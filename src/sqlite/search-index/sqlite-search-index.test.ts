import { DatabaseSync } from "node:sqlite";
import { assertEquals, assertExists } from "@std/assert";
import { FakeEmbeddingService } from "@worlds/sdk/search-index/embedding-service";
import type { EmbeddingService } from "@worlds/sdk/search-index/embedding-service";
import { SqliteSearchIndex } from "./sqlite-search-index.ts";
import { insertChunkRowForTest } from "./search-index-test-helpers.ts";
import {
  createTestSqliteConnectionDriver,
  setupSqliteSchemaForTest,
  testSearchQueryBuilderFor,
  tryLoadVectorExtension,
} from "../sqlite-test-fixtures.ts";

/** FailingEmbeddingService always rejects embed() to exercise keyword fallback. */
class FailingEmbeddingService implements EmbeddingService {
  public embed(_texts: string[]): Promise<Array<Float32Array>> {
    return Promise.reject(new Error("embedding service unavailable"));
  }
}

/** WrongDimensionEmbeddingService returns vectors with an invalid width. */
class WrongDimensionEmbeddingService implements EmbeddingService {
  public embed(texts: string[]): Promise<Array<Float32Array>> {
    return Promise.resolve(texts.map(() => new Float32Array(8)));
  }
}

function createTestConnection() {
  // Keyword-path tests do not need sqlite-vec: the schema stays keyword-only.
  const db = new DatabaseSync(":memory:", { allowExtension: true });
  const connection = createTestSqliteConnectionDriver(db, {
    vectorSupported: false,
  });
  return connection;
}

Deno.test("SqliteSearchIndex - basic keyword search maps results", async () => {
  const connection = createTestConnection();
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
    },
  );

  const searchIndex = new SqliteSearchIndex({
    connection,
    searchQueryBuilder: testSearchQueryBuilderFor(connection),
  });

  const response = await searchIndex.search({ query: "Ethan" });
  assertExists(response.results);
  assertEquals(response.results.length, 1);
  assertEquals(response.results[0].subject, "urn:ethan");
  assertEquals(response.results[0].predicate, "urn:name");
  assertEquals(response.results[0].text, "Ethan is the explorer");
  assertEquals(typeof response.results[0].score, "number");
});

Deno.test("SqliteSearchIndex - Scope Inclusion: limits matches to included subjects", async () => {
  const connection = createTestConnection();
  await setupSqliteSchemaForTest(connection);

  for (
    const [quadId, subject, text] of [
      ["f1", "urn:person:1", "Loves coding and data"],
      ["f2", "urn:person:2", "Loves coding and gardening"],
    ] as const
  ) {
    await insertChunkRowForTest(
      connection,
      testSearchQueryBuilderFor(connection),
      {
        quad_id: quadId,
        subject,
        predicate: "urn:bio",
        graph: "urn:g1",
        value: text,
      },
    );
  }

  const searchIndex = new SqliteSearchIndex({
    connection,
    searchQueryBuilder: testSearchQueryBuilderFor(connection),
  });

  const base = await searchIndex.search({ query: "coding" });
  assertEquals(
    base.results?.length,
    2,
    "Baseline should find both coding references",
  );

  const filtered = await searchIndex.search({
    query: "coding",
    include: { subjects: ["urn:person:2"] },
  });
  assertEquals(
    filtered.results?.length,
    1,
    "Should return exactly one filtered match",
  );
  assertEquals(filtered.results?.[0].subject, "urn:person:2");
});

Deno.test("SqliteSearchIndex - Scope Exclusion: suppresses excluded predicates", async () => {
  const connection = createTestConnection();
  await setupSqliteSchemaForTest(connection);

  await insertChunkRowForTest(
    connection,
    testSearchQueryBuilderFor(connection),
    {
      quad_id: "f1",
      subject: "urn:e1",
      predicate: "urn:allowed",
      graph: "urn:g",
      value: "Match text",
    },
  );
  await insertChunkRowForTest(
    connection,
    testSearchQueryBuilderFor(connection),
    {
      quad_id: "f2",
      subject: "urn:e1",
      predicate: "urn:forbidden",
      graph: "urn:g",
      value: "Match text",
    },
  );

  const searchIndex = new SqliteSearchIndex({
    connection,
    searchQueryBuilder: testSearchQueryBuilderFor(connection),
  });

  const response = await searchIndex.search({
    query: "Match",
    exclude: { predicates: ["urn:forbidden"] },
  });
  assertEquals(response.results?.length, 1);
  assertEquals(response.results?.[0].predicate, "urn:allowed");
});

Deno.test("SqliteSearchIndex - keyword-only degradation without embeddingService", async () => {
  const connection = createTestConnection();
  await setupSqliteSchemaForTest(connection);

  await insertChunkRowForTest(
    connection,
    testSearchQueryBuilderFor(connection),
    {
      quad_id: "id-1",
      subject: "urn:target",
      predicate: "urn:prop",
      graph: "urn:g",
      value: "Specific search term inside target document",
    },
  );
  await insertChunkRowForTest(
    connection,
    testSearchQueryBuilderFor(connection),
    {
      quad_id: "id-2",
      subject: "urn:other",
      predicate: "urn:prop",
      graph: "urn:g",
      value: "Completely unrelated keywords",
    },
  );

  const searchIndex = new SqliteSearchIndex({
    connection,
    searchQueryBuilder: testSearchQueryBuilderFor(connection),
  });

  const response = await searchIndex.search({ query: "search term" });
  assertEquals(response.results?.length, 1);
  assertEquals(response.results?.[0].subject, "urn:target");
});

Deno.test("SqliteSearchIndex - dangerous FTS5 syntax does not crash", async () => {
  const connection = createTestConnection();
  await setupSqliteSchemaForTest(connection);
  await insertChunkRowForTest(
    connection,
    testSearchQueryBuilderFor(connection),
    {
      quad_id: "id-1",
      subject: "urn:subject",
      predicate: "urn:prop",
      graph: "urn:g",
      value: 'The magic phrase with "quotes"',
    },
  );

  const searchIndex = new SqliteSearchIndex({
    connection,
    searchQueryBuilder: testSearchQueryBuilderFor(connection),
  });

  const dangerousQueries = [
    'magic "phrase"',
    '"hello',
    "{ unclosed",
    "foo* bar",
  ];
  for (const query of dangerousQueries) {
    const response = await searchIndex.search({ query });
    assertExists(response.results, `Failed on query: ${query}`);
  }
});

Deno.test("SqliteSearchIndex - degrades to keyword-only when embedding service throws", async () => {
  const connection = createTestConnection();
  await setupSqliteSchemaForTest(connection);
  await insertChunkRowForTest(
    connection,
    testSearchQueryBuilderFor(connection),
    {
      quad_id: "id-fts",
      subject: "urn:fallback",
      predicate: "urn:prop",
      graph: "urn:g",
      value: "Unique fallback keyword phrase",
    },
  );

  const searchIndex = new SqliteSearchIndex({
    connection,
    embeddingService: new FailingEmbeddingService(),
    searchQueryBuilder: testSearchQueryBuilderFor(connection),
  });

  const response = await searchIndex.search({ query: "fallback keyword" });
  assertEquals(response.results?.length, 1);
  assertEquals(response.results?.[0].subject, "urn:fallback");
});

Deno.test("SqliteSearchIndex - degrades when embedding dimensions do not match", async () => {
  const connection = createTestConnection();
  await setupSqliteSchemaForTest(connection);
  await insertChunkRowForTest(
    connection,
    testSearchQueryBuilderFor(connection),
    {
      quad_id: "id-dim",
      subject: "urn:dim",
      predicate: "urn:prop",
      graph: "urn:g",
      value: "Dimension mismatch keyword target",
    },
  );

  const searchIndex = new SqliteSearchIndex({
    connection,
    embeddingService: new WrongDimensionEmbeddingService(),
    searchQueryBuilder: testSearchQueryBuilderFor(connection),
  });

  const response = await searchIndex.search({ query: "dimension mismatch" });
  assertEquals(response.results?.length, 1);
  assertEquals(response.results?.[0].subject, "urn:dim");
});

Deno.test("SqliteSearchIndex - respects custom result limit", async () => {
  const connection = createTestConnection();
  await setupSqliteSchemaForTest(connection);

  for (let index = 0; index < 5; index++) {
    await insertChunkRowForTest(
      connection,
      testSearchQueryBuilderFor(connection),
      {
        quad_id: `id-${index}`,
        subject: `urn:row:${index}`,
        predicate: "urn:prop",
        graph: "urn:g",
        value: `Shared limit keyword row ${index}`,
      },
    );
  }

  const searchIndex = new SqliteSearchIndex({
    connection,
    searchQueryBuilder: testSearchQueryBuilderFor(connection),
    limit: 2,
  });

  const response = await searchIndex.search({ query: "limit keyword" });
  assertEquals(response.results?.length, 2);
});

Deno.test("SqliteSearchIndex - non-ASCII queries match via unicode61 (parity #21)", async () => {
  const connection = createTestConnection();
  await setupSqliteSchemaForTest(connection);
  await insertChunkRowForTest(
    connection,
    testSearchQueryBuilderFor(connection),
    {
      quad_id: "id-ar",
      subject: "urn:item1",
      predicate: "urn:greeting",
      graph: "",
      value: "\u0645\u0631\u062d\u0628\u0627",
    },
  );

  const searchIndex = new SqliteSearchIndex({
    connection,
    searchQueryBuilder: testSearchQueryBuilderFor(connection),
  });

  const response = await searchIndex.search({
    query: "\u0645\u0631\u062d\u0628\u0627",
  });
  assertEquals(response.results?.length, 1);
  assertEquals(response.results?.[0].text, "\u0645\u0631\u062d\u0628\u0627");
});

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
