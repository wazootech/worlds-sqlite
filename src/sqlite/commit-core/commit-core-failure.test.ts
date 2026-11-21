import { assert, assertEquals, assertRejects } from "@std/assert";
import { DataFactory } from "n3";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { FakeEmbeddingService } from "@worlds/sdk/search-index/embedding-service";
import { commitSqlPatch, type SqlCommitOptions } from "@/sql-core/mod.ts";
import { type FakeLimits, FakeSqlStore } from "./sql-commit.fake.ts";

const { quad, namedNode, literal } = DataFactory;
const g = namedNode("urn:core:g");
const p = namedNode("urn:core:p");
const q = (n: number) =>
  quad(namedNode(`urn:core:s${n}`), p, literal(`text ${n}`), g);

const projection = {
  textSplitter: new RecursiveCharacterTextSplitter({ chunkSize: 1000 }),
  embeddingService: new FakeEmbeddingService(),
};

function setup(limits: FakeLimits, keyPrefix = "") {
  const store = new FakeSqlStore(limits, keyPrefix);
  const commit = (
    insertions: ReturnType<typeof q>[],
    options: SqlCommitOptions = {},
    deletions: ReturnType<typeof q>[] = [],
  ) =>
    commitSqlPatch(
      { insertions, deletions },
      undefined,
      store.driver,
      store.dialect,
      {
        projection,
        ...options,
      },
    );
  return { store, commit };
}

Deno.test("a commit at maxAtomicStatements is one batch; one statement over is chunked", async () => {
  // Per quad: 1 insert + 1 chunk = 2, plus one clean-slate delete for all: 5 statements for 2 quads.
  const atMax = setup({ maxAtomicStatements: 5, writeBatchSize: 2 });
  await atMax.commit([q(1), q(2)]);
  assertEquals(atMax.store.batches.map((b) => b.length), [5]);

  const over = setup({ maxAtomicStatements: 4, writeBatchSize: 2 });
  await over.commit([q(1), q(2)]);
  assertEquals(over.store.batches.map((b) => b.length), [2, 2, 1]);
  assertEquals(over.store.quads.size, 2);
  assertEquals(over.store.chunks.length, 2);
});

Deno.test("per-commit options can lower the driver's limits but never raise them", async () => {
  const lowered = setup({ maxAtomicStatements: 100, writeBatchSize: 100 });
  await lowered.commit([q(1)], { maxAtomicStatements: 1, writeBatchSize: 1 });
  assertEquals(lowered.store.batches.length, 3); // delete, insert, chunk

  const raised = setup({ maxAtomicStatements: 1, writeBatchSize: 1 });
  await raised.commit([q(1)], {
    maxAtomicStatements: 100,
    writeBatchSize: 100,
  });
  assertEquals(raised.store.batches.length, 3);
});

Deno.test("a failure in the first fallback batch writes nothing and runs no cleanup", async () => {
  const { store, commit } = setup({
    maxAtomicStatements: 1,
    writeBatchSize: 100,
  });
  store.failNextInsertBatch();
  await assertRejects(
    () => commit([q(1), q(2)]),
    Error,
    "injected write failure",
  );
  assertEquals(store.batches.length, 1);
  assertEquals(store.executed("cleanup").length, 0);
  assertEquals(store.quads.size, 0);
});

Deno.test("a later fallback failure cleans up the novel quads already written", async () => {
  const { store, commit } = setup({
    maxAtomicStatements: 1,
    writeBatchSize: 1,
  });
  // Batches: 1 delete, 2 insert q1, 3 insert q2 (fails), then the cleanup batch.
  store.failBatchNumber(3);
  await assertRejects(
    () => commit([q(1), q(2)]),
    Error,
    "injected write failure",
  );
  assertEquals(store.executed("cleanup").length, 1);
  assertEquals(
    store.quads.size,
    0,
    "the cleanup removed the partially written quad",
  );
  assertEquals(store.chunks.length, 0);
});

Deno.test("when the cleanup also fails the commit throws an AggregateError with both errors", async () => {
  const { store, commit } = setup({
    maxAtomicStatements: 1,
    writeBatchSize: 1,
  });
  store.failBatchNumber(3);
  store.failCleanup();
  const error = await assertRejects(() => commit([q(1), q(2)]));
  assert(error instanceof AggregateError);
  assertEquals(error.errors.length, 2);
  assert(error.message.includes("may be inconsistent"));
});

Deno.test("an embedding failure writes nothing on either path", async () => {
  const failing = { embed: () => Promise.reject(new Error("embedding down")) };
  for (
    const limits of [
      { maxAtomicStatements: 10_000, writeBatchSize: 500 },
      { maxAtomicStatements: 0, writeBatchSize: 1 },
    ]
  ) {
    const { store, commit } = setup(limits);
    await assertRejects(
      () =>
        commit([q(1)], {
          projection: { ...projection, embeddingService: failing },
        }),
      Error,
      "failed to vectorize",
    );
    assertEquals(store.batches.length, 0);
  }
});

Deno.test("the dialect's keyOf is the identity used for lookups and statements", async () => {
  const { store, commit } = setup({
    maxAtomicStatements: 100,
    writeBatchSize: 100,
  }, "term:");
  await commit([q(1)]);
  const key = [...store.quads.keys()][0]!;
  assert(key.startsWith("term:"));
  assert(store.lookups[0]!.every((k) => k.startsWith("term:")));

  const before = store.executed("insert").length;
  const again = await commit([q(1)]);
  assertEquals(again.novelQuads, 0, "an already stored quad is not novel");
  assertEquals(store.executed("insert").length, before);
});

Deno.test("without a projection option no chunk rows are written", async () => {
  const { store, commit } = setup({
    maxAtomicStatements: 100,
    writeBatchSize: 100,
  });
  const summary = await commit([q(1)], { projection: undefined });
  assertEquals(store.chunks.length, 0);
  assertEquals(summary.novelQuads, 1);
});

Deno.test("afterWrite runs once, after the write, with the summary", async () => {
  const { store, commit } = setup({
    maxAtomicStatements: 100,
    writeBatchSize: 100,
  });
  const seen: number[] = [];
  await commit([q(1), q(2)], {
    afterWrite: (summary) => {
      seen.push(store.quads.size);
      assertEquals(summary.novelQuads, 2);
      return Promise.resolve();
    },
  });
  assertEquals(seen, [2], "the write was durable before the hook ran");
});

Deno.test("deletions apply before the insertions of the same patch", async () => {
  const { store, commit } = setup({
    maxAtomicStatements: 100,
    writeBatchSize: 100,
  });
  await commit([q(1)]);
  await commit([q(1), q(2)], {}, [q(1)]);
  assertEquals(store.quads.size, 2);
  assertEquals(
    store.chunks.length,
    2,
    "q1 was deleted and re-added, so it was re-chunked once",
  );
});
