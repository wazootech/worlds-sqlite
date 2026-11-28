import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { assert, assertEquals, assertRejects } from "@std/assert";
import { DataFactory } from "n3";
import type * as rdfjs from "@rdfjs/types";
import type { Patch, TransactionContext } from "@worlds/sdk/quad-store";
import { FakeEmbeddingService } from "@worlds/sdk/search-index/embedding-service";
import type { EmbeddingService } from "@worlds/sdk/search-index/embedding-service";
import { commitSqlPatch, type SqlCommitSummary } from "@/sql-core/mod.ts";
import { SqliteStore } from "@/sqlite/rdfjs-store/sqlite-store.ts";
import type { SqliteConnectionDriver } from "@/sqlite/sqlite-connection-driver.ts";
import {
  createTestSqliteConnectionDriver,
  setupSqliteSchemaForTest,
  sharedTextSplitter,
  testSearchQueryBuilderFor,
  tryLoadVectorExtension,
} from "@/sqlite/sqlite-test-fixtures.ts";
import {
  createSqliteCommit,
  type SqliteCommitCoreOptions,
} from "./create-sqlite-commit.ts";

const { quad, namedNode, literal } = DataFactory;

class FailingEmbeddingService implements EmbeddingService {
  public embed(): Promise<Float32Array[]> {
    return Promise.reject(new Error("embedding service unavailable"));
  }
}

async function setup(
  options: {
    vector?: boolean;
    projection?: boolean;
    embeddingService?: EmbeddingService;
    include?: SqliteCommitCoreOptions["include"];
  } = {},
) {
  const db = new DatabaseSync(":memory:", { allowExtension: true });
  const vector = options.vector === true && (await tryLoadVectorExtension(db));
  if (options.vector) assert(vector, "sqlite-vec must load");
  const connection = createTestSqliteConnectionDriver(db, {
    vectorSupported: vector,
  });
  await setupSqliteSchemaForTest(connection);
  const store = new SqliteStore({ path: ":memory:", db });
  const core: SqliteCommitCoreOptions = {
    connection,
    searchQueryBuilder: testSearchQueryBuilderFor(connection),
    textSplitter: options.projection === false ? undefined : sharedTextSplitter,
    embeddingService: options.embeddingService,
    include: options.include,
  };
  const commit = (
    patch: Partial<Patch>,
    context?: TransactionContext,
  ): Promise<SqlCommitSummary> => {
    const { driver, dialect, projection, filter } = createSqliteCommit(core);
    return commitSqlPatch(
      { insertions: [], deletions: [], ...patch },
      context,
      driver,
      dialect,
      {
        filter,
        projection,
      },
    );
  };
  return { connection, store, commit };
}

async function count(
  connection: SqliteConnectionDriver,
  table: string,
): Promise<number> {
  const { rows } = await connection.execute({
    sql: `SELECT COUNT(*) AS n FROM ${table}`,
  });
  return Number(rows[0]!.n);
}

const hello = quad(
  namedNode("urn:a"),
  namedNode("urn:p"),
  literal("hello world"),
);

test("sqlite commit - persists novel insertions and writes their chunks", async () => {
  const { connection, store, commit } = await setup();
  const summary = await commit({ insertions: [hello], deletions: [] });
  assertEquals(summary.novelQuads, 1);
  assertEquals(summary.chunkRows, 1);
  assertEquals(store.getQuads().length, 1);
  assertEquals(store.getQuads()[0]!.object.value, "hello world");
  assertEquals(await count(connection, "chunks"), 1);
});

test("sqlite commit - suppresses redundant re-inserts (idempotency guard)", async () => {
  const { store, commit } = await setup();
  assertEquals((await commit({ insertions: [hello] })).novelQuads, 1);
  assertEquals((await commit({ insertions: [hello] })).novelQuads, 0);
  assertEquals(store.getQuads().length, 1);
});

test("sqlite commit - delete then re-insert in one patch counts as novel", async () => {
  const { connection, store, commit } = await setup();
  await commit({ insertions: [hello] });
  const summary = await commit({ insertions: [hello], deletions: [hello] });
  assertEquals(summary.novelQuads, 1);
  assertEquals(store.getQuads().length, 1);
  assertEquals(await count(connection, "chunks"), 1);
});

test("sqlite commit - deletion sweeps durable quads and their chunks", async () => {
  const { connection, store, commit } = await setup();
  await commit({ insertions: [hello] });
  await commit({ deletions: [hello] });
  assertEquals(store.getQuads().length, 0);
  assertEquals(await count(connection, "chunks"), 0);
});

test("sqlite commit - replace-mode import wipes all quads and chunks", async () => {
  const { connection, store, commit } = await setup();
  await commit({ insertions: [hello] });
  const second = quad(namedNode("urn:c"), namedNode("urn:p"), literal("two"));
  const summary = await commit(
    { insertions: [second] },
    {
      importMode: "replace",
    },
  );
  assertEquals(summary.novelQuads, 1);
  assertEquals(
    store.getQuads().map((q: rdfjs.Quad) => q.subject.value),
    ["urn:c"],
  );
  assertEquals(await count(connection, "chunks"), 1);
});

test("sqlite commit - respects include boundaries", async () => {
  const { store, commit } = await setup({ include: { subjects: ["urn:a"] } });
  const dropped = quad(namedNode("urn:x"), namedNode("urn:p"), literal("no"));
  const summary = await commit({ insertions: [hello, dropped] });
  assertEquals(summary.novelQuads, 1);
  assertEquals(store.getQuads().length, 1);
});

test("sqlite commit - without a textSplitter no chunks are written", async () => {
  const { connection, store, commit } = await setup({ projection: false });
  await commit({ insertions: [hello] });
  assertEquals(store.getQuads().length, 1);
  assertEquals(await count(connection, "chunks"), 0);
});

test("sqlite commit - pairs every vector with its own chunk row in one batch", async () => {
  const { connection, commit } = await setup({
    vector: true,
    embeddingService: new FakeEmbeddingService(),
  });
  const quads = ["alpha", "beta", "gamma", "delta"].map((word) =>
    quad(namedNode(`urn:${word}`), namedNode("urn:p"), literal(`${word} text`)),
  );
  const summary = await commit({ insertions: quads });
  assertEquals(summary.chunkRows, 4);
  assertEquals(await count(connection, "chunks"), 4);
  assertEquals(await count(connection, "chunks_vec"), 4);
  const orphans = await connection.execute({
    sql: "SELECT COUNT(*) AS n FROM chunks LEFT JOIN chunks_vec ON chunks_vec.rowid = chunks.id WHERE chunks_vec.rowid IS NULL",
  });
  assertEquals(Number(orphans.rows[0]!.n), 0);

  await commit({ deletions: quads.slice(0, 2) });
  assertEquals(await count(connection, "chunks"), 2);
  assertEquals(await count(connection, "chunks_vec"), 2);
});

test("sqlite commit - an embedding failure throws and writes nothing", async () => {
  const { connection, store, commit } = await setup({
    vector: true,
    embeddingService: new FailingEmbeddingService(),
  });
  await assertRejects(() => commit({ insertions: [hello] }));
  assertEquals(store.getQuads().length, 0);
  assertEquals(await count(connection, "chunks"), 0);
});

test("sqlite commit - a failed write rolls back quads and chunks together", async () => {
  const { connection, store, commit } = await setup();
  await commit({ insertions: [hello] });
  // With the FTS table gone, the chunk insert fails after the quad insert ran
  // in the same batch; the quad must roll back with it.
  await connection.execute({ sql: "DROP TABLE chunks_fts" });
  const other = quad(namedNode("urn:b"), namedNode("urn:p"), literal("more"));
  await assertRejects(() => commit({ insertions: [other] }));
  assertEquals(store.getQuads().length, 1);
  assertEquals(await count(connection, "chunks"), 1);
});
