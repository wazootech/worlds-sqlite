import { test } from "node:test";
import { assert, assertEquals, assertRejects } from "@std/assert";
import { DataFactory } from "n3";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { FakeEmbeddingService } from "@worlds/sdk/search-index/embedding-service";
import {
  commitSqlPatch,
  rebuildSqlSearchIndex,
  rebuildSqlSearchIndexWithCounts,
} from "@/sql-core/mod.ts";
import { FakeSqlStore } from "./sql-commit.fake.ts";

const { quad, namedNode, literal } = DataFactory;
const p = namedNode("urn:scoped:p");
const gA = namedNode("urn:scoped:gA");
const gB = namedNode("urn:scoped:gB");
const qa = (n: number) =>
  quad(namedNode(`urn:scoped:a${n}`), p, literal(`a ${n}`), gA);
const qb = (n: number) =>
  quad(namedNode(`urn:scoped:b${n}`), p, literal(`b ${n}`), gB);

const projection = {
  textSplitter: new RecursiveCharacterTextSplitter({ chunkSize: 1000 }),
  embeddingService: new FakeEmbeddingService(),
};
const limits = { maxAtomicStatements: 10_000, writeBatchSize: 500 };
const scopeA = { include: { graphs: [gA.value] } };

/** seeded stores 3 quads in graph A and 2 in graph B, with chunk rows for all. */
async function seeded() {
  const store = new FakeSqlStore(limits);
  await commitSqlPatch(
    {
      insertions: [qa(1), qa(2), qa(3), qb(1), qb(2)],
      deletions: [],
    },
    undefined,
    store.driver,
    store.dialect,
    { searchIndexOnImport: "incremental", projection },
  );
  assertEquals(store.chunks.length, 5);
  return store;
}

test("a scoped rebuild replaces only the in-scope rows and clears nothing", async () => {
  const store = await seeded();
  const outside = store.chunks.filter((c) => c.text.startsWith("b"));
  store.chunks = store.chunks.filter((c) => !c.text.startsWith("a"));
  store.chunks.push({ quadId: "stale-in-scope", text: "x", vectorized: false });
  const result = await rebuildSqlSearchIndexWithCounts(
    store.driver,
    store.dialect,
    projection,
    { pageSize: 2, scope: scopeA },
  );
  assertEquals(result, { processedQuadCount: 5, chunkRowCount: 3 });
  assertEquals(store.clearCount, 0, "a scoped rebuild never clears all");
  assertEquals(store.chunks.filter((c) => c.text.startsWith("a")).length, 3);
  for (const row of outside) assert(store.chunks.some((c) => c === row));
  assert(store.chunks.some((c) => c.quadId === "stale-in-scope"));
});

test("a scoped rebuild does not duplicate rows that already exist", async () => {
  const store = await seeded();
  await rebuildSqlSearchIndex(store.driver, store.dialect, projection, {
    scope: scopeA,
  });
  assertEquals(store.chunks.length, 5);
});

test("an exclude scope rebuilds everything but the excluded quads", async () => {
  const store = await seeded();
  store.chunks = [];
  const result = await rebuildSqlSearchIndexWithCounts(
    store.driver,
    store.dialect,
    projection,
    { scope: { exclude: { graphs: [gA.value] } } },
  );
  assertEquals(result, { processedQuadCount: 5, chunkRowCount: 2 });
  assert(store.chunks.every((c) => c.text.startsWith("b")));
});

test("a scope with no criteria is a full rebuild that clears all", async () => {
  const store = await seeded();
  store.chunks.push({ quadId: "stale", text: "stale", vectorized: false });
  const result = await rebuildSqlSearchIndexWithCounts(
    store.driver,
    store.dialect,
    projection,
    { scope: { include: { graphs: [] } } },
  );
  assertEquals(result, { processedQuadCount: 5, chunkRowCount: 5 });
  assertEquals(store.clearCount, 1);
  assert(!store.chunks.some((c) => c.quadId === "stale"));
});

test("a scope that matches nothing writes nothing and clears nothing", async () => {
  const store = await seeded();
  const before = [...store.chunks];
  const result = await rebuildSqlSearchIndexWithCounts(
    store.driver,
    store.dialect,
    projection,
    { scope: { include: { graphs: ["urn:scoped:none"] } } },
  );
  assertEquals(result, { processedQuadCount: 5, chunkRowCount: 0 });
  assertEquals(store.clearCount, 0);
  assertEquals(store.chunks, before);
});

test("an embedding failure in a scoped rebuild changes nothing", async () => {
  const store = await seeded();
  const before = [...store.chunks];
  const failing = { embed: () => Promise.reject(new Error("embedding down")) };
  await assertRejects(
    () =>
      rebuildSqlSearchIndex(
        store.driver,
        store.dialect,
        {
          ...projection,
          embeddingService: failing,
        },
        { scope: scopeA },
      ),
    Error,
    "failed to vectorize",
  );
  assertEquals(store.chunks, before);
});

test("a scoped rebuild needs a dialect that can delete chunks by quad", async () => {
  const store = await seeded();
  const { buildDeleteChunks: _omitted, ...dialect } = store.dialect;
  await assertRejects(
    () =>
      rebuildSqlSearchIndex(store.driver, dialect, projection, {
        scope: scopeA,
      }),
    Error,
    "buildDeleteChunks",
  );
  assertEquals(store.batches.length, 1, "only the seeding commit wrote");
});

test("rebuildSqlSearchIndex still returns the chunk row count and clears all", async () => {
  const store = await seeded();
  assertEquals(
    await rebuildSqlSearchIndex(store.driver, store.dialect, projection),
    5,
  );
  assertEquals(store.clearCount, 1);
});
