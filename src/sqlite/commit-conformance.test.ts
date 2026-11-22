import { DatabaseSync } from "node:sqlite";
import { assert, assertEquals, assertRejects } from "@std/assert";
import { DataFactory } from "n3";
import { FakeEmbeddingService } from "@worlds/sdk/search-index/embedding-service";
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
  // Ignored for an atomic backend, which always restores the prior state; kept
  // explicit so the declaration reads the same as the SDK default.
  laterWriteFailure: "restores-prior-state",
};

/** QUAD_WRITE matches the statement that writes quad rows. */
const QUAD_WRITE = /^\s*INSERT OR REPLACE INTO quads\b/i;

/** CHUNK_WRITE matches the statement that writes a search chunk row. */
const CHUNK_WRITE = /^\s*INSERT INTO chunks\b/i;

/** LaterWriteInjection records where `failLaterWrite` landed inside a batch. */
interface LaterWriteInjection {
  /** index is the position of the statement that was made to fail. */
  index: number;
  /** replaced is the chunk-row SQL that the failing statement stood in for. */
  replaced: string;
  /** precedingSql lists the statements that ran in the transaction before it. */
  precedingSql: string[];
}

/**
 * FaultyConnection fails the next write that inserts rows, once, when armed,
 * fails the first chunk-row write that follows a quad write, once, when
 * `laterArmed`, and counts the full search-index rebuilds (a batch that clears
 * the chunks without wiping the quads).
 */
class FaultyConnection extends SqliteConnectionDriver {
  public armed = false;
  public laterArmed = false;
  public rebuilds = 0;
  public readonly laterInjections: LaterWriteInjection[] = [];

  /**
   * injectLater swaps the first chunk-row statement that follows a quad write
   * for one SQLite itself rejects (an INSERT into a missing table). The batch
   * still runs through the real BEGIN IMMEDIATE transaction, so the quad
   * writes before it are applied and then genuinely rolled back.
   */
  private injectLater(
    statements: readonly SqlStatement[],
  ): readonly SqlStatement[] {
    if (!this.laterArmed) return statements;
    const firstQuad = statements.findIndex((s) => QUAD_WRITE.test(s.sql));
    const index = firstQuad < 0
      ? -1
      : statements.findIndex((s, i) =>
        i > firstQuad && CHUNK_WRITE.test(s.sql)
      );
    if (index < 0) return statements;
    this.laterArmed = false;
    this.laterInjections.push({
      index,
      replaced: statements[index]!.sql,
      precedingSql: statements.slice(0, index).map((s) => s.sql),
    });
    return statements.map((s, i) =>
      i === index
        ? {
          sql: "INSERT INTO injected_missing_table (x) VALUES (?)",
          args: [1],
        }
        : s
    );
  }

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
    return super.batch(this.injectLater(statements));
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

type CreateOptions = Parameters<
  Parameters<typeof runCommitConformanceSuite>[0]["create"]
>[0];

async function createFixture(
  options: CreateOptions,
): Promise<
  { subject: CommitConformanceSubject; connection: FaultyConnection }
> {
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
  const subject: CommitConformanceSubject = {
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
    failLaterWrite() {
      connection.laterArmed = true;
    },
    fullRebuildCount: () => connection.rebuilds,
  };
  return { subject, connection };
}

async function createSubject(
  options: CreateOptions,
): Promise<CommitConformanceSubject> {
  return (await createFixture(options)).subject;
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
  const skipped = (report.notes ?? []).filter((note) => /skip/i.test(note));
  assertEquals(skipped, [], "no conformance case may be skipped");
  assert(
    report.results.some((r) => r.name.startsWith("later-write failure")),
    "the later-write case must run",
  );
});

Deno.test("sqlite failLaterWrite lands on a chunk write after the quad writes", async () => {
  const { subject, connection } = await createFixture({
    searchIndexOnImport: "incremental",
    embeddingService: new FakeEmbeddingService(),
  });
  const quad = (id: string) =>
    DataFactory.quad(
      DataFactory.namedNode(`https://example.test/${id}`),
      DataFactory.namedNode("https://example.test/label"),
      DataFactory.literal(`label ${id}`),
    );
  await subject.commit({ insertions: [quad("a")], deletions: [] });
  const storedBefore = (await subject.storedQuads()).length;

  subject.failLaterWrite!();
  await assertRejects(
    () => subject.commit({ insertions: [quad("b"), quad("c")], deletions: [] }),
    Error,
  );

  assertEquals(connection.laterInjections.length, 1, "injected exactly once");
  const [injection] = connection.laterInjections;
  assert(CHUNK_WRITE.test(injection!.replaced), "a chunk-row write failed");
  assert(
    injection!.precedingSql.some((sql) => QUAD_WRITE.test(sql)),
    "the quad writes ran before the failing write in the same batch",
  );
  assert(
    !injection!.precedingSql.some((sql) => CHUNK_WRITE.test(sql)),
    "the failing write is the first chunk-row write",
  );
  assertEquals(
    (await subject.storedQuads()).length,
    storedBefore,
    "the BEGIN IMMEDIATE transaction rolled the applied quad writes back",
  );
  assertEquals(connection.laterArmed, false, "the failure fires once");
});
