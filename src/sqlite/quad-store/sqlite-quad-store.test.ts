import { DatabaseSync } from "node:sqlite";
import { assertEquals } from "@std/assert";
import { DataFactory } from "n3";
import { SqliteStore } from "@/sqlite/rdfjs-store/sqlite-store.ts";
import { SqliteSearchIndexProjector } from "@/sqlite/search-index/mod.ts";
import { SqliteSearchIndex } from "@/sqlite/search-index/mod.ts";
import { SqliteQuadStore } from "./sqlite-quad-store.ts";
import {
  createTestSqliteConnectionDriver,
  setupSqliteSchemaForTest,
  sharedTextSplitter,
  testSearchQueryBuilderFor,
} from "../sqlite-test-fixtures.ts";

const { quad, namedNode, literal } = DataFactory;

async function createQuadStore(
  searchIndexOnImport?: "incremental" | "deferred" | "disabled",
) {
  const db = new DatabaseSync(":memory:", { allowExtension: true });
  const connection = createTestSqliteConnectionDriver(db, {
    vectorSupported: false,
  });
  await setupSqliteSchemaForTest(connection);
  const store = new SqliteStore({ path: ":memory:", db });
  const searchIndexProjector = new SqliteSearchIndexProjector({
    connection,
    searchQueryBuilder: testSearchQueryBuilderFor(connection),
    textSplitter: sharedTextSplitter,
  });
  const searchQueryBuilder = testSearchQueryBuilderFor(connection);
  const quadStore = new SqliteQuadStore({
    connection,
    store,
    searchQueryBuilder,
    searchIndexProjector,
    searchIndexOnImport,
  });
  return { db, connection, store, quadStore };
}

Deno.test("SqliteQuadStore - import merges quads and export round-trips", async () => {
  const { db, quadStore } = await createQuadStore();
  try {
    await quadStore.import({
      source: {
        kind: "quads",
        quads: [
          quad(namedNode("urn:a"), namedNode("urn:p"), literal("alpha")),
          quad(namedNode("urn:b"), namedNode("urn:p"), literal("beta")),
        ],
      },
    });

    const exported = await quadStore.export({ format: { kind: "quads" } });
    assertEquals(exported.kind, "quads");
    if (exported.kind === "quads") {
      assertEquals(exported.quads.length, 2);
    }
  } finally {
    db.close();
  }
});

Deno.test("SqliteQuadStore - import with replace mode fully replaces the world", async () => {
  const { db, quadStore } = await createQuadStore();
  try {
    await quadStore.import({
      source: {
        kind: "quads",
        quads: [quad(namedNode("urn:a"), namedNode("urn:p"), literal("one"))],
      },
    });
    await quadStore.import({
      mode: "replace",
      source: {
        kind: "quads",
        quads: [quad(namedNode("urn:c"), namedNode("urn:p"), literal("two"))],
      },
    });

    const exported = await quadStore.export({ format: { kind: "quads" } });
    if (exported.kind === "quads") {
      assertEquals(exported.quads.length, 1);
      assertEquals(exported.quads[0].subject.value, "urn:c");
    }
  } finally {
    db.close();
  }
});

Deno.test("SqliteQuadStore - incremental import projects search chunks", async () => {
  const { db, connection, quadStore } = await createQuadStore("incremental");
  try {
    await quadStore.import({
      source: {
        kind: "quads",
        quads: [
          quad(namedNode("urn:a"), namedNode("urn:p"), literal("needle text")),
        ],
      },
    });

    const searchIndex = new SqliteSearchIndex({
      connection,
      searchQueryBuilder: testSearchQueryBuilderFor(connection),
    });
    const response = await searchIndex.search({ query: "needle" });
    assertEquals(response.results?.length, 1);
  } finally {
    db.close();
  }
});

Deno.test("SqliteQuadStore - deferred import skips per-quad projection then reindexes all", async () => {
  const { db, connection, quadStore } = await createQuadStore("deferred");
  try {
    await quadStore.import({
      source: {
        kind: "quads",
        quads: [
          quad(namedNode("urn:a"), namedNode("urn:p"), literal("needle text")),
        ],
      },
    });

    const searchIndex = new SqliteSearchIndex({
      connection,
      searchQueryBuilder: testSearchQueryBuilderFor(connection),
    });
    const response = await searchIndex.search({ query: "needle" });
    assertEquals(
      response.results?.length,
      1,
      "deferred import rebuilds the index once",
    );
  } finally {
    db.close();
  }
});

Deno.test("SqliteQuadStore - disabled import stores quads but no chunks until reindex", async () => {
  const { db, connection, quadStore } = await createQuadStore("disabled");
  try {
    await quadStore.import({
      source: {
        kind: "quads",
        quads: [
          quad(namedNode("urn:a"), namedNode("urn:p"), literal("needle text")),
        ],
      },
    });

    const searchIndex = new SqliteSearchIndex({
      connection,
      searchQueryBuilder: testSearchQueryBuilderFor(connection),
      textSplitter: sharedTextSplitter,
    });
    const before = await searchIndex.search({ query: "needle" });
    assertEquals(before.results?.length ?? 0, 0);

    await searchIndex.reindex();
    const after = await searchIndex.search({ query: "needle" });
    assertEquals(after.results?.length, 1);
  } finally {
    db.close();
  }
});

Deno.test("SqliteQuadStore - createTransaction routes SPARQL-style patches through commit", async () => {
  const { db, connection, quadStore } = await createQuadStore();
  try {
    const tx = quadStore.createTransaction();
    tx.add(
      quad(namedNode("urn:tx"), namedNode("urn:p"), literal("transactional")),
    );
    await tx.commit();

    const searchIndex = new SqliteSearchIndex({
      connection,
      searchQueryBuilder: testSearchQueryBuilderFor(connection),
    });
    const response = await searchIndex.search({ query: "transactional" });
    assertEquals(response.results?.length, 1);
  } finally {
    db.close();
  }
});
