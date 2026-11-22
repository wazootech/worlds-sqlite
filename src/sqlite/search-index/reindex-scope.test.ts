import { DatabaseSync } from "node:sqlite";
import { assertEquals } from "@std/assert";
import { DataFactory } from "n3";
import type { ReindexRequest } from "@worlds/sdk/search-index";
import { SqliteStore } from "@/sqlite/rdfjs-store/sqlite-store.ts";
import { SqliteQuadStore } from "@/sqlite/quad-store/sqlite-quad-store.ts";
import { SqliteSearchIndex } from "./sqlite-search-index.ts";
import {
  createTestSqliteConnectionDriver,
  setupSqliteSchemaForTest,
  sharedTextSplitter,
  testSearchQueryBuilderFor,
} from "../sqlite-test-fixtures.ts";

const { quad, namedNode, literal } = DataFactory;
const gA = namedNode("urn:scope:gA");
const gB = namedNode("urn:scope:gB");
const pX = namedNode("urn:scope:pX");
const pY = namedNode("urn:scope:pY");
const s = (name: string) => namedNode(`urn:scope:${name}`);

/** fixture seeds two graphs and two predicates, fully indexed. */
async function fixture() {
  const db = new DatabaseSync(":memory:", { allowExtension: true });
  const connection = createTestSqliteConnectionDriver(db, {
    vectorSupported: false,
  });
  await setupSqliteSchemaForTest(connection);
  const searchQueryBuilder = testSearchQueryBuilderFor(connection);
  const quadStore = new SqliteQuadStore({
    connection,
    store: new SqliteStore({ path: ":memory:", db }),
    searchQueryBuilder,
    searchIndexOnImport: "disabled",
  });
  await quadStore.import({
    source: {
      kind: "quads",
      quads: [
        quad(s("a1"), pX, literal("alpha one"), gA),
        quad(s("a2"), pY, literal("alpha two"), gA),
        quad(s("b1"), pX, literal("beta one"), gB),
        quad(s("b2"), pY, literal("beta two"), gB),
      ],
    },
  });
  const index = new SqliteSearchIndex({
    connection,
    searchQueryBuilder,
    textSplitter: sharedTextSplitter,
  });
  await index.reindex();
  return { db, index };
}

type Db = DatabaseSync;
const values = (db: Db, graph: string): string[] =>
  db.prepare("SELECT value FROM chunks WHERE graph = ? ORDER BY value")
    .all(graph).map((row) => String(row.value));
const total = (db: Db): number =>
  Number(db.prepare("SELECT COUNT(*) AS n FROM chunks").get()!.n);

/** tamper marks every chunk row so a refresh (or a survival) is observable. */
function tamper(db: Db, column: "graph" | "predicate", value: string) {
  db.prepare(`UPDATE chunks SET value = 'stale' WHERE ${column} = ?`)
    .run(value);
}

async function scopedCase(
  request: ReindexRequest,
  inScope: { column: "graph" | "predicate"; value: string },
  outScope: { column: "graph" | "predicate"; value: string },
  expectedChunks: number,
) {
  const { db, index } = await fixture();
  tamper(db, inScope.column, inScope.value);
  tamper(db, outScope.column, outScope.value);
  const rows = (column: string, value: string) =>
    Number(
      db.prepare(
        `SELECT COUNT(*) AS n FROM chunks WHERE ${column} = ? AND value = 'stale'`,
      ).get(value)!.n,
    );
  const outsideBefore = rows(outScope.column, outScope.value);
  const report = await index.reindex(request);
  assertEquals(report.processedQuadCount, 4, "every scanned quad is counted");
  assertEquals(report.chunkRowCount, expectedChunks);
  assertEquals(
    rows(outScope.column, outScope.value),
    outsideBefore,
    "out-of-scope chunk rows survive untouched",
  );
  assertEquals(rows(inScope.column, inScope.value), 0, "in-scope rows refresh");
  assertEquals(total(db), 4, "no chunk row is lost or duplicated");
  db.close();
}

Deno.test("sqlite reindex - include keeps out-of-scope chunk rows and refreshes in-scope", async () => {
  await scopedCase(
    { include: { graphs: [gA.value] } },
    { column: "graph", value: gA.value },
    { column: "graph", value: gB.value },
    2,
  );
});

Deno.test("sqlite reindex - exclude keeps excluded chunk rows and refreshes the rest", async () => {
  await scopedCase(
    { exclude: { predicates: [pY.value] } },
    { column: "predicate", value: pX.value },
    { column: "predicate", value: pY.value },
    2,
  );
});

Deno.test("sqlite reindex - a request with no criteria is unscoped and rebuilds everything", async () => {
  const { db, index } = await fixture();
  tamper(db, "graph", gA.value);
  tamper(db, "graph", gB.value);
  const report = await index.reindex({ include: {}, exclude: { graphs: [] } });
  assertEquals(report, { processedQuadCount: 4, chunkRowCount: 4 });
  assertEquals(values(db, gA.value), ["alpha one", "alpha two"]);
  assertEquals(values(db, gB.value), ["beta one", "beta two"]);
  db.close();
});

Deno.test("sqlite reindex - unscoped reindex drops the stale chunk row of a deleted quad", async () => {
  const { db, index } = await fixture();
  db.prepare(
    "INSERT INTO chunks (quad_id, subject, predicate, graph, value, fts_value) VALUES ('gone', 's', 'p', 'g', 'ghost', 'ghost')",
  ).run();
  assertEquals(total(db), 5);
  const report = await index.reindex();
  assertEquals(report, { processedQuadCount: 4, chunkRowCount: 4 });
  assertEquals(total(db), 4);
});
