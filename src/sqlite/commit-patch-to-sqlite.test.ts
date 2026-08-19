import { DatabaseSync } from "node:sqlite";
import { assertEquals } from "@std/assert";
import { DataFactory } from "n3";
import { hashQuads } from "@worlds/sdk/quad-store";
import { commitPatchToSqlite } from "./commit-patch-to-sqlite.ts";
import { SqliteStore } from "./rdfjs-store/sqlite-store.ts";
import { SqliteSearchQueryBuilder } from "./search-index/sqlite-search-query-builder.ts";
import {
  createTestSqliteConnectionDriver,
  setupSqliteSchemaForTest,
  testSearchQueryBuilderFor,
} from "./sqlite-test-fixtures.ts";

const { quad, namedNode, literal } = DataFactory;

function createTestStore() {
  const db = new DatabaseSync(":memory:", { allowExtension: true });
  const connection = createTestSqliteConnectionDriver(db, {
    vectorSupported: false,
  });
  const store = new SqliteStore({ path: ":memory:", db });
  return {
    db,
    connection,
    store,
    searchQueryBuilder: testSearchQueryBuilderFor(connection),
  };
}

Deno.test("commitPatchToSqlite - persists novel insertions and reports them for projection", async () => {
  const { connection, store, searchQueryBuilder } = createTestStore();
  await setupSqliteSchemaForTest(connection);

  const insertion = quad(
    namedNode("urn:a"),
    namedNode("urn:p"),
    literal("hello world"),
  );
  const result = await commitPatchToSqlite(
    { insertions: [insertion], deletions: [] },
    { connection, searchQueryBuilder },
  );

  assertEquals(result.novelInsertions.length, 1);
  assertEquals(result.novelQuadIds.length, 1);
  assertEquals(store.getQuads().length, 1);
  assertEquals(store.getQuads()[0].object.value, "hello world");
});

Deno.test("commitPatchToSqlite - suppresses redundant re-inserts (idempotency guard)", async () => {
  const { connection, store, searchQueryBuilder } = createTestStore();
  await setupSqliteSchemaForTest(connection);

  const insertion = quad(
    namedNode("urn:a"),
    namedNode("urn:p"),
    literal("hello world"),
  );
  const first = await commitPatchToSqlite(
    { insertions: [insertion], deletions: [] },
    { connection, searchQueryBuilder },
  );
  assertEquals(first.novelInsertions.length, 1);

  const second = await commitPatchToSqlite(
    { insertions: [insertion], deletions: [] },
    { connection, searchQueryBuilder },
  );
  assertEquals(second.novelInsertions.length, 0);
  assertEquals(store.getQuads().length, 1);
});

Deno.test("commitPatchToSqlite - delete then re-insert in one patch counts as novel", async () => {
  const { connection, store, searchQueryBuilder } = createTestStore();
  await setupSqliteSchemaForTest(connection);

  const insertion = quad(
    namedNode("urn:a"),
    namedNode("urn:p"),
    literal("hello world"),
  );
  await commitPatchToSqlite(
    { insertions: [insertion], deletions: [] },
    { connection, searchQueryBuilder },
  );

  const result = await commitPatchToSqlite(
    { insertions: [insertion], deletions: [insertion] },
    { connection, searchQueryBuilder },
  );
  assertEquals(result.novelInsertions.length, 1);
  assertEquals(store.getQuads().length, 1);
});

Deno.test("commitPatchToSqlite - deletion sweeps durable quads", async () => {
  const { connection, store, searchQueryBuilder } = createTestStore();
  await setupSqliteSchemaForTest(connection);

  const insertion = quad(
    namedNode("urn:a"),
    namedNode("urn:p"),
    literal("hello world"),
  );
  await commitPatchToSqlite(
    { insertions: [insertion], deletions: [] },
    { connection, searchQueryBuilder },
  );

  await commitPatchToSqlite(
    { insertions: [], deletions: [insertion] },
    { connection, searchQueryBuilder },
  );
  assertEquals(store.getQuads().length, 0);
});

Deno.test("commitPatchToSqlite - replace-mode import wipes all quads and chunks", async () => {
  const { connection, store, searchQueryBuilder } = createTestStore();
  await setupSqliteSchemaForTest(connection);

  const first = quad(namedNode("urn:a"), namedNode("urn:p"), literal("one"));
  await commitPatchToSqlite(
    { insertions: [first], deletions: [] },
    { connection, searchQueryBuilder },
  );
  assertEquals(store.getQuads().length, 1);

  const second = quad(namedNode("urn:c"), namedNode("urn:p"), literal("two"));
  const result = await commitPatchToSqlite(
    { insertions: [second], deletions: [] },
    { connection, searchQueryBuilder },
    { importMode: "replace" },
  );
  assertEquals(result.novelInsertions.length, 1);
  assertEquals(store.getQuads().length, 1);
  assertEquals(store.getQuads()[0].subject.value, "urn:c");
});

Deno.test("commitPatchToSqlite - respects include/exclude boundaries", async () => {
  const { connection, store } = createTestStore();
  await setupSqliteSchemaForTest(connection);

  const kept = quad(
    namedNode("urn:kept"),
    namedNode("urn:p"),
    literal("kept text"),
  );
  const dropped = quad(
    namedNode("urn:drop"),
    namedNode("urn:p"),
    literal("drop text"),
  );
  const result = await commitPatchToSqlite(
    { insertions: [kept, dropped], deletions: [] },
    {
      connection,
      searchQueryBuilder: testSearchQueryBuilderFor(connection),
      include: { subjects: ["urn:kept"] },
    },
  );

  assertEquals(result.novelInsertions.length, 1);
  assertEquals(result.novelInsertions[0].subject.value, "urn:kept");
  assertEquals(store.getQuads().length, 1);
});

Deno.test("commitPatchToSqlite - chunk deletion sweeps vec rows before chunks", async () => {
  const db = new DatabaseSync(":memory:", { allowExtension: true });
  // Load sqlite-vec if available to exercise the vec sweep.
  let vecAvailable = false;
  try {
    const { load } = await import("sqlite-vec");
    load(db);
    vecAvailable = true;
  } catch {
    // keyword-only path
  }
  const connection = createTestSqliteConnectionDriver(db, {
    vectorSupported: vecAvailable,
  });
  await setupSqliteSchemaForTest(connection);
  void new SqliteStore({ path: ":memory:", db });
  const queryBuilder = new SqliteSearchQueryBuilder(32, {
    vectorSupported: vecAvailable,
  });

  const insertion = quad(
    namedNode("urn:a"),
    namedNode("urn:p"),
    literal("hello world"),
  );
  const [quadId] = await hashQuads([insertion]);
  await commitPatchToSqlite(
    { insertions: [insertion], deletions: [] },
    { connection, searchQueryBuilder: queryBuilder },
  );

  // Project a chunk + vec row manually, then delete the quad and verify cleanup.
  const resultSet = await connection.execute<{ id: number | bigint }>({
    sql:
      "INSERT INTO chunks (quad_id, subject, predicate, graph, value, fts_value) VALUES (?, ?, ?, ?, ?, ?) RETURNING id",
    args: [quadId!, "urn:a", "urn:p", "", "hello world", "hello world"],
  });
  if (vecAvailable) {
    await connection.execute({
      sql: "INSERT INTO chunks_vec (rowid, embedding) VALUES (?, ?)",
      args: [
        BigInt(resultSet.rows[0]!.id),
        JSON.stringify(new Array(32).fill(0)),
      ],
    });
  }

  await commitPatchToSqlite(
    { insertions: [], deletions: [insertion] },
    { connection, searchQueryBuilder: queryBuilder },
  );

  const chunks = await connection.execute({
    sql: "SELECT COUNT(*) AS n FROM chunks",
  });
  assertEquals(chunks.rows[0].n, 0);
  if (vecAvailable) {
    const vecRows = await connection.execute({
      sql: "SELECT COUNT(*) AS n FROM chunks_vec",
    });
    assertEquals(vecRows.rows[0].n, 0);
  }
});
