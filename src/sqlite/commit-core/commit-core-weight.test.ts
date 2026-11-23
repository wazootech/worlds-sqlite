import { assert, assertEquals, assertRejects } from "@std/assert";
import { DataFactory } from "n3";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { FakeEmbeddingService } from "@worlds/sdk/search-index/embedding-service";
import type { SqlDialect } from "@/sql-core/mod.ts";
import { commitSqlPatch } from "@/sql-core/mod.ts";
import { type FakeLimits, FakeSqlStore } from "./sql-commit.fake.ts";
import {
  type FakeStatement,
  fakeStatementWeight,
} from "./sql-commit-dialect.fake.ts";

const { quad, namedNode, literal } = DataFactory;
const g = namedNode("urn:weight:g");
const p = namedNode("urn:weight:p");
const q = (n: number) =>
  quad(namedNode(`urn:weight:s${n}`), p, literal(`text ${n}`), g);
const projection = {
  textSplitter: new RecursiveCharacterTextSplitter({ chunkSize: 1000 }),
  embeddingService: new FakeEmbeddingService(),
};

// N quads commit as: 1 delete (weight 1), N inserts (1 each), N chunks (10 each).
const weighted = (maxBatchWeight: number, extra: Partial<FakeLimits> = {}) => ({
  maxAtomicStatements: 100,
  writeBatchSize: 100,
  statementWeight: fakeStatementWeight,
  maxBatchWeight,
  ...extra,
});

function run(
  limits: FakeLimits,
  count: number,
  dialect?: (base: SqlDialect<FakeStatement>) => SqlDialect<FakeStatement>,
) {
  const store = new FakeSqlStore(limits);
  const quads = Array.from({ length: count }, (_, i) => q(i + 1));
  const commit = () =>
    commitSqlPatch(
      { insertions: quads, deletions: [] },
      undefined,
      store.driver,
      dialect ? dialect(store.dialect) : store.dialect,
      { projection },
    );
  return { store, commit };
}

const sizes = (store: FakeSqlStore) => store.batches.map((b) => b.length);
const weightOf = (batch: FakeStatement[]) =>
  batch.reduce((sum, s) => sum + fakeStatementWeight(s), 0);

Deno.test("a list under both limits is one atomic batch", async () => {
  const { store, commit } = run(weighted(23), 2); // weight 1 + 2 + 20
  await commit();
  assertEquals(sizes(store), [5]);
});

Deno.test("a list over the weight limit only falls back, in batches filled by weight", async () => {
  const { store, commit } = run(weighted(22), 2);
  await commit();
  assertEquals(sizes(store), [4, 1]);
  assertEquals(store.quads.size, 2);
  assertEquals(store.chunks.length, 2);
});

Deno.test("weights split the batches and no batch exceeds the budget", async () => {
  const { store, commit } = run(weighted(12), 3);
  await commit();
  assertEquals(sizes(store), [4, 1, 1, 1]);
  assert(store.batches.every((b) => weightOf(b) <= 12));
});

Deno.test("a single statement over the budget goes alone and the commit completes", async () => {
  const { store, commit } = run(weighted(5), 2);
  await commit();
  assertEquals(sizes(store), [3, 1, 1]);
  assertEquals(store.quads.size, 2);
  assertEquals(store.chunks.length, 2);
});

Deno.test("the driver can reject an over-budget statement; the earlier batches are cleaned up", async () => {
  const { store, commit } = run(weighted(5), 2);
  store.failBatchNumber(2); // the first chunk, alone in its batch
  await assertRejects(commit, Error, "injected write failure");
  assertEquals(store.executed("cleanup").length, 1);
  assertEquals(store.quads.size, 0);
});

Deno.test("the count limits still apply when the weight budget is generous", async () => {
  const over = run(
    weighted(1000, { maxAtomicStatements: 4, writeBatchSize: 2 }),
    2,
  );
  await over.commit();
  assertEquals(sizes(over.store), [2, 2, 1]);
  const atMax = run(weighted(1000, { maxAtomicStatements: 5 }), 2);
  await atMax.commit();
  assertEquals(sizes(atMax.store), [5]);
});

Deno.test("a driver without a complete weight declaration behaves as before", async () => {
  let calls = 0;
  const counting = (s: FakeStatement) => (calls++, fakeStatementWeight(s));
  const base = { maxAtomicStatements: 4, writeBatchSize: 2 };
  for (
    const limits of [
      base,
      { ...base, statementWeight: counting }, // no budget
      { ...base, maxBatchWeight: 1 }, // no estimator
    ]
  ) {
    const { store, commit } = run(limits, 2);
    await commit();
    assertEquals(sizes(store), [2, 2, 1]);
  }
  assertEquals(calls, 0, "weights are never computed without a budget");
});

Deno.test("cleanup batches obey the same weight limits", async () => {
  // Cleanup statements weigh 5 each; the budget of 12 fits two per batch.
  const weight = (s: FakeStatement) =>
    s.kind === "cleanup" ? 5 : fakeStatementWeight(s);
  const perQuad = (
    base: SqlDialect<FakeStatement>,
  ): SqlDialect<FakeStatement> => ({
    ...base,
    buildCleanup: (keys, hashes) =>
      keys.map((key, i) => ({
        kind: "cleanup",
        keys: [key],
        hashes: [hashes[i]!],
      })),
  });
  const { store, commit } = run(
    weighted(12, { statementWeight: weight }),
    3,
    perQuad,
  );
  store.failBatchNumber(3); // delete+inserts, chunk 1 commit; chunk 2 fails
  await assertRejects(commit, Error, "injected write failure");
  assertEquals(
    sizes(store),
    [4, 1, 1, 2, 1],
    "three cleanup statements, split by weight",
  );
  assertEquals(store.quads.size, 0);
  assertEquals(store.chunks.length, 0);
});

Deno.test("an embedding failure writes nothing with a weighted driver", async () => {
  const { store } = run(weighted(12), 1);
  const failing = { embed: () => Promise.reject(new Error("embedding down")) };
  await assertRejects(
    () =>
      commitSqlPatch(
        { insertions: [q(1)], deletions: [] },
        undefined,
        store.driver,
        store.dialect,
        {
          projection: { ...projection, embeddingService: failing },
        },
      ),
    Error,
    "failed to vectorize",
  );
  assertEquals(store.batches.length, 0);
});
