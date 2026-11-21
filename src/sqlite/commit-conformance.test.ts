import { DatabaseSync } from "node:sqlite";
import { assert } from "@std/assert";
import type * as rdfjs from "@rdfjs/types";
import { runCommitConformanceSuite } from "@worlds/sdk/testing";
import type {
  CommitConformanceContract,
  CommitConformanceSubject,
} from "@worlds/sdk/testing";
import { SqliteQuadStore } from "@/sqlite/quad-store/sqlite-quad-store.ts";
import { SqliteStore } from "@/sqlite/rdfjs-store/sqlite-store.ts";
import {
  SqliteConnectionDriver,
  type SqlResult,
  type SqlStatement,
} from "./sqlite-connection-driver.ts";
import {
  setupSqliteSchemaForTest,
  sharedTextSplitter,
  testSearchQueryBuilderFor,
  tryLoadVectorExtension,
} from "./sqlite-test-fixtures.ts";

/**
 * sqlite runs the shared commitSqlPatch: `connection.batch` is one BEGIN
 * IMMEDIATE transaction, so quads, chunk rows and a replace-import wipe commit
 * together (or not at all) up to the shared atomic limit, and an embedding
 * failure throws before anything is written.
 */
const sqliteContract: CommitConformanceContract = {
  atomic: true,
  embeddingFailure: "throws",
  replaceImportFailure: "keeps-old-graph",
  defaultSearchIndexOnImport: "incremental",
};

/**
 * FaultyConnection fails the next write that inserts rows, once, when armed,
 * and counts the full search-index rebuilds (a batch that clears the chunks
 * without wiping the quads).
 */
class FaultyConnection extends SqliteConnectionDriver {
  public armed = false;
  public rebuilds = 0;

  private failIfArmed(statements: readonly SqlStatement[]): void {
    if (this.armed && statements.some((s) => /^\s*INSERT/i.test(s.sql))) {
      this.armed = false;
      throw new Error("injected write failure");
    }
  }

  public override batch(statements: readonly SqlStatement[]): Promise<void> {
    const sqls = statements.map((s) => s.sql);
    if (
      sqls.includes("DELETE FROM chunks") && !sqls.includes("DELETE FROM quads")
    ) {
      this.rebuilds++;
    }
    try {
      this.failIfArmed(statements);
    } catch (error) {
      return Promise.reject(error);
    }
    return super.batch(statements);
  }

  public override execute<Row = Record<string, unknown>>(
    statement: SqlStatement,
  ): Promise<SqlResult<Row>> {
    try {
      this.failIfArmed([statement]);
    } catch (error) {
      return Promise.reject(error);
    }
    return super.execute<Row>(statement);
  }
}

async function createSubject(
  options: Parameters<
    Parameters<typeof runCommitConformanceSuite>[0]["create"]
  >[0],
): Promise<CommitConformanceSubject> {
  const db = new DatabaseSync(":memory:", { allowExtension: true });
  const vectorSupported = await tryLoadVectorExtension(db);
  assert(vectorSupported, "sqlite-vec must load for the conformance suite");
  const connection = new FaultyConnection(db, { vectorSupported });
  await setupSqliteSchemaForTest(connection);
  const searchQueryBuilder = testSearchQueryBuilderFor(connection);
  const store = new SqliteStore({ path: ":memory:", db });
  const quadStore = new SqliteQuadStore({
    connection,
    store,
    searchQueryBuilder,
    textSplitter: sharedTextSplitter,
    embeddingService: options.embeddingService,
    searchIndexOnImport: options.searchIndexOnImport,
  });
  return {
    async commit(patch, context) {
      const transaction = quadStore.createTransaction();
      transaction.addQuads(patch.insertions ?? []);
      transaction.removeQuads(patch.deletions ?? []);
      await transaction.commit(context);
    },
    async storedQuads() {
      const exported = await quadStore.export({ format: { kind: "quads" } });
      return exported.kind === "quads" ? exported.quads : ([] as rdfjs.Quad[]);
    },
    async chunkedQuadIds() {
      const { rows } = await connection.execute<{ quad_id: string }>({
        sql: "SELECT quad_id FROM chunks",
        args: [],
      });
      return rows.map((row) => row.quad_id);
    },
    failNextWrite() {
      connection.armed = true;
    },
    fullRebuildCount: () => connection.rebuilds,
  };
}

Deno.test("sqlite commit path passes the shared conformance suite", async () => {
  const report = await runCommitConformanceSuite({
    create: createSubject,
    contract: sqliteContract,
  });
  const failures = report.results.filter((r) => !r.ok);
  assert(
    report.ok,
    failures.map((r) => `${r.name}: ${r.failures.join("; ")}`).join("\n"),
  );
});
