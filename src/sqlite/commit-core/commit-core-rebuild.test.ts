import { test } from "node:test";
import { assert, assertEquals, assertRejects } from "@std/assert";
import { DataFactory } from "n3";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { FakeEmbeddingService } from "@worlds/sdk/search-index/embedding-service";
import { commitSqlPatch, rebuildSqlSearchIndex } from "@/sql-core/mod.ts";
import { FakeSqlStore } from "./sql-commit.fake.ts";

const { quad, namedNode, literal } = DataFactory;
const g = namedNode("urn:rebuild:g");
const p = namedNode("urn:rebuild:p");
const q = (n: number) =>
  quad(namedNode(`urn:rebuild:s${n}`), p, literal(`text ${n}`), g);

const projection = {
  textSplitter: new RecursiveCharacterTextSplitter({ chunkSize: 1000 }),
  embeddingService: new FakeEmbeddingService(),
};
const limits = { maxAtomicStatements: 10_000, writeBatchSize: 500 };

async function seeded(count: number) {
  const store = new FakeSqlStore(limits);
  await commitSqlPatch(
    {
      insertions: Array.from({ length: count }, (_, i) => q(i)),
      deletions: [],
    },
    undefined,
    store.driver,
    store.dialect,
    { searchIndexOnImport: "disabled", projection },
  );
  assertEquals(store.chunks.length, 0, "seeded without chunks");
  return store;
}

test("a rebuild pages the stored quads, clears chunks once, and writes every chunk", async () => {
  const store = await seeded(5);
  store.chunks.push({ quadId: "stale", text: "stale", vectorized: false });
  const written = await rebuildSqlSearchIndex(
    store.driver,
    store.dialect,
    projection,
    {
      pageSize: 2,
    },
  );
  assertEquals(written, 5);
  assertEquals(store.streamCalls, 3, "5 quads at 2 per page is 3 pages");
  assertEquals(store.clearCount, 1);
  assertEquals(store.chunks.length, 5);
  assert(!store.chunks.some((c) => c.quadId === "stale"));
});

test("rebuilding an empty store clears the chunk rows and writes none", async () => {
  const store = new FakeSqlStore(limits);
  store.chunks.push({ quadId: "stale", text: "stale", vectorized: false });
  assertEquals(
    await rebuildSqlSearchIndex(store.driver, store.dialect, projection),
    0,
  );
  assertEquals(store.chunks.length, 0);
  assertEquals(store.clearCount, 1);
});

test("an embedding failure on the first page changes nothing", async () => {
  const store = await seeded(3);
  store.chunks.push({ quadId: "kept", text: "kept", vectorized: false });
  const failing = { embed: () => Promise.reject(new Error("embedding down")) };
  await assertRejects(
    () =>
      rebuildSqlSearchIndex(store.driver, store.dialect, {
        ...projection,
        embeddingService: failing,
      }),
    Error,
    "failed to vectorize",
  );
  assertEquals(store.clearCount, 0);
  assertEquals(
    store.chunks.map((c) => c.quadId),
    ["kept"],
  );
});

test("a deferred import rebuilds once after the commit and reports it", async () => {
  const store = new FakeSqlStore(limits);
  const summary = await commitSqlPatch(
    { insertions: [q(1), q(2), q(3)], deletions: [] },
    { importMode: "merge" },
    store.driver,
    store.dialect,
    { searchIndexOnImport: "deferred", projection, rebuildPageSize: 2 },
  );
  assertEquals(summary.rebuilt, true);
  assertEquals(
    summary.chunkRows,
    0,
    "a deferred import projects nothing in the commit",
  );
  assertEquals(store.clearCount, 1);
  assertEquals(store.chunks.length, 3);
});

test("the backend's own default mode applies when the option is unset", async () => {
  const store = new FakeSqlStore(limits);
  const summary = await commitSqlPatch(
    { insertions: [q(1)], deletions: [] },
    { importMode: "merge" },
    store.driver,
    store.dialect,
    { defaultSearchIndexOnImport: "deferred", projection },
  );
  assertEquals(summary.rebuilt, true);
  assertEquals(store.chunks.length, 1);
});
