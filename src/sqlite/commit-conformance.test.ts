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
import { SqliteSearchIndexProjector } from "@/sqlite/search-index/mod.ts";
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
 * sqlite's commit path is NOT atomic across quads and chunks: quads go in one
 * BEGIN IMMEDIATE batch, then each chunk row is its own statement, and a failed
 * projection is cleaned up by deleting the quads just written (so an embedding
 * failure still leaves nothing). A replace import wipes in its own committed
 * batch first, so a failed write after it leaves an empty graph.
 */
const sqliteContract: CommitConformanceContract = {
  atomic: false,
  embeddingFailure: "throws",
  replaceImportFailure: "empties-graph",
  defaultSearchIndexOnImport: "incremental",
};

/** FaultyConnection fails the next write that inserts rows, once, when armed. */
class FaultyConnection extends SqliteConnectionDriver {
  public armed = false;

  private failIfArmed(statements: readonly SqlStatement[]): void {
    if (this.armed && statements.some((s) => /^\s*INSERT/i.test(s.sql))) {
      this.armed = false;
      throw new Error("injected write failure");
    }
  }

  public override batch(statements: readonly SqlStatement[]): Promise<void> {
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

/** CountingProjector counts the full rebuilds a deferred import triggers. */
class CountingProjector extends SqliteSearchIndexProjector {
  public rebuilds = 0;

  public override async reindexAll(): Promise<void> {
    this.rebuilds++;
    await super.reindexAll();
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
  const projector = new CountingProjector({
    connection,
    searchQueryBuilder,
    textSplitter: sharedTextSplitter,
    embeddingService: options.embeddingService,
  });
  const store = new SqliteStore({ path: ":memory:", db });
  const quadStore = new SqliteQuadStore({
    connection,
    store,
    searchQueryBuilder,
    searchIndexProjector: projector,
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
    fullRebuildCount: () => projector.rebuilds,
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
