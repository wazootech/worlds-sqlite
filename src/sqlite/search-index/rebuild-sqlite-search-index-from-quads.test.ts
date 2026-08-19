import { DatabaseSync } from "node:sqlite";
import { assertEquals } from "@std/assert";
import { DataFactory } from "n3";
import { SqliteStore } from "@/sqlite/rdfjs-store/sqlite-store.ts";
import { SqliteQuadStore } from "@/sqlite/quad-store/sqlite-quad-store.ts";
import { SqliteSearchIndexProjector } from "./sqlite-search-index-projector.ts";
import { rebuildSqliteSearchIndexFromQuads } from "./rebuild-sqlite-search-index-from-quads.ts";
import { SqliteSearchIndex } from "./sqlite-search-index.ts";
import {
  createTestSqliteConnectionDriver,
  setupSqliteSchemaForTest,
  sharedTextSplitter,
  testSearchQueryBuilderFor,
} from "../sqlite-test-fixtures.ts";

const { quad, namedNode, literal } = DataFactory;

Deno.test(
  "rebuildSqliteSearchIndexFromQuads - rebuilds chunks from durable quads and returns counts",
  async () => {
    const db = new DatabaseSync(":memory:", { allowExtension: true });
    const connection = createTestSqliteConnectionDriver(db, {
      vectorSupported: false,
    });
    await setupSqliteSchemaForTest(connection);

    const store = new SqliteStore({ path: ":memory:", db });
    const quadStore = new SqliteQuadStore({
      connection,
      store,
      searchQueryBuilder: testSearchQueryBuilderFor(connection),
      searchIndexOnImport: "disabled",
    });

    await quadStore.import({
      source: {
        kind: "quads",
        quads: [
          quad(
            namedNode("urn:a"),
            namedNode("urn:p"),
            literal("alpha needle text"),
          ),
          quad(
            namedNode("urn:b"),
            namedNode("urn:p"),
            literal("beta unrelated"),
          ),
        ],
      },
    });

    const report = await rebuildSqliteSearchIndexFromQuads({
      connection,
      searchQueryBuilder: testSearchQueryBuilderFor(connection),
      textSplitter: sharedTextSplitter,
    });
    assertEquals(report.processedQuadCount, 2);
    assertEquals(report.chunkRowCount, 2);

    // The rebuilt index is searchable.
    const searchIndex = new SqliteSearchIndex({
      connection,
      searchQueryBuilder: testSearchQueryBuilderFor(connection),
    });
    const response = await searchIndex.search({ query: "needle" });
    assertEquals(response.results?.length, 1);
    assertEquals(response.results?.[0].subject, "urn:a");
  },
);

Deno.test(
  "rebuildSqliteSearchIndexFromQuads - respects include/exclude scope",
  async () => {
    const db = new DatabaseSync(":memory:", { allowExtension: true });
    const connection = createTestSqliteConnectionDriver(db, {
      vectorSupported: false,
    });
    await setupSqliteSchemaForTest(connection);

    const store = new SqliteStore({ path: ":memory:", db });
    const quadStore = new SqliteQuadStore({
      connection,
      store,
      searchQueryBuilder: testSearchQueryBuilderFor(connection),
      searchIndexOnImport: "disabled",
    });

    await quadStore.import({
      source: {
        kind: "quads",
        quads: [
          quad(
            namedNode("urn:a"),
            namedNode("urn:p"),
            literal("alpha needle text"),
          ),
          quad(
            namedNode("urn:b"),
            namedNode("urn:p"),
            literal("beta needle text"),
          ),
        ],
      },
    });

    const report = await rebuildSqliteSearchIndexFromQuads({
      connection,
      searchQueryBuilder: testSearchQueryBuilderFor(connection),
      textSplitter: sharedTextSplitter,
      include: { subjects: ["urn:a"] },
    });
    assertEquals(report.processedQuadCount, 2);
    assertEquals(report.chunkRowCount, 1);
  },
);

Deno.test(
  "SqliteSearchIndexProjector - reindexAll rebuilds the entire index",
  async () => {
    const db = new DatabaseSync(":memory:", { allowExtension: true });
    const connection = createTestSqliteConnectionDriver(db, {
      vectorSupported: false,
    });
    await setupSqliteSchemaForTest(connection);

    const store = new SqliteStore({ path: ":memory:", db });
    const projector = new SqliteSearchIndexProjector({
      connection,
      searchQueryBuilder: testSearchQueryBuilderFor(connection),
      textSplitter: sharedTextSplitter,
    });
    const quadStore = new SqliteQuadStore({
      connection,
      store,
      searchQueryBuilder: testSearchQueryBuilderFor(connection),
      searchIndexOnImport: "disabled",
    });

    await quadStore.import({
      source: {
        kind: "quads",
        quads: [
          quad(
            namedNode("urn:a"),
            namedNode("urn:p"),
            literal("alpha needle text"),
          ),
        ],
      },
    });

    await projector.reindexAll();

    const searchIndex = new SqliteSearchIndex({
      connection,
      searchQueryBuilder: testSearchQueryBuilderFor(connection),
    });
    const response = await searchIndex.search({ query: "needle" });
    assertEquals(response.results?.length, 1);
  },
);
