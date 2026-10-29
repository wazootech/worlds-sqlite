import { DatabaseSync } from "node:sqlite";
import { assertEquals, assertExists } from "@std/assert";
import { FakeEmbeddingService } from "@worlds/sdk/search-index/embedding-service";
import { SqliteSearchIndex } from "./sqlite-search-index.ts";
import { insertChunkRowForTest } from "./search-index-test-helpers.ts";
import {
  createTestSqliteConnectionDriver,
  setupSqliteSchemaForTest,
  testSearchQueryBuilderFor,
  tryLoadVectorExtension,
} from "../sqlite-test-fixtures.ts";

// --- Hybrid / vector paths (gated on the sqlite-vec extension) ---

Deno.test("SqliteSearchIndex - hybrid search fuses keyword and vector ranks (vec-gated)", async () => {
  const db = new DatabaseSync(":memory:", { allowExtension: true });
  const vecAvailable = await tryLoadVectorExtension(db);
  if (!vecAvailable) {
    return; // keyword-only environments skip the vec-specific assertion
  }
  const connection = createTestSqliteConnectionDriver(db, {
    vectorSupported: true,
  });
  await setupSqliteSchemaForTest(connection);

  await insertChunkRowForTest(
    connection,
    testSearchQueryBuilderFor(connection),
    {
      quad_id: "f1",
      subject: "urn:ethan",
      predicate: "urn:name",
      graph: "urn:graph",
      value: "Ethan is the explorer",
      vector: [1.0],
    },
  );
  await insertChunkRowForTest(
    connection,
    testSearchQueryBuilderFor(connection),
    {
      quad_id: "f2",
      subject: "urn:gregory",
      predicate: "urn:name",
      graph: "urn:graph",
      value: "Gregory stays back",
      vector: [0.0],
    },
  );

  const searchIndex = new SqliteSearchIndex({
    connection,
    embeddingService: new FakeEmbeddingService(),
    searchQueryBuilder: testSearchQueryBuilderFor(connection),
  });

  // "Ethan" matches ethan via keyword AND vector (FakeEmbeddingService always
  // emits the same vector, so both rows rank; keyword rank dominates ethan).
  const response = await searchIndex.search({ query: "Ethan", topK: 10 });
  assertExists(response.results);
  assertEquals(response.results.length, 2);
  assertEquals(response.results[0].subject, "urn:ethan");
});

Deno.test("SqliteSearchIndex - vector-only search when query has no keyword tokens (vec-gated)", async () => {
  const db = new DatabaseSync(":memory:", { allowExtension: true });
  const vecAvailable = await tryLoadVectorExtension(db);
  if (!vecAvailable) {
    return;
  }
  const connection = createTestSqliteConnectionDriver(db, {
    vectorSupported: true,
  });
  await setupSqliteSchemaForTest(connection);

  await insertChunkRowForTest(
    connection,
    testSearchQueryBuilderFor(connection),
    {
      quad_id: "f1",
      subject: "urn:a",
      predicate: "urn:p",
      graph: "urn:g",
      value: "some text",
      vector: [1.0],
    },
  );
  await insertChunkRowForTest(
    connection,
    testSearchQueryBuilderFor(connection),
    {
      quad_id: "f2",
      subject: "urn:b",
      predicate: "urn:p",
      graph: "urn:g",
      value: "other text",
      vector: [0.0],
    },
  );

  const searchIndex = new SqliteSearchIndex({
    connection,
    embeddingService: new FakeEmbeddingService(),
    searchQueryBuilder: testSearchQueryBuilderFor(connection),
  });

  // Pure punctuation yields no FTS tokens → vector-only branch.
  const response = await searchIndex.search({ query: "!!!", topK: 10 });
  assertExists(response.results);
  assertEquals(response.results.length, 2);
});
