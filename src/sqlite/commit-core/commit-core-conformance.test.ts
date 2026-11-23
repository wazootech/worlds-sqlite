import { assert, assertEquals } from "@std/assert";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { runCommitConformanceSuite } from "@worlds/sdk/testing";
import type {
  CommitConformanceContract,
  CommitConformanceSubject,
} from "@worlds/sdk/testing";
import { commitSqlPatch } from "@/sql-core/mod.ts";
import { type FakeLimits, FakeSqlStore } from "./sql-commit.fake.ts";
import { fakeStatementWeight } from "./sql-commit-dialect.fake.ts";

const splitter = new RecursiveCharacterTextSplitter({ chunkSize: 1000 });

type CreateOptions = Parameters<
  Parameters<typeof runCommitConformanceSuite>[0]["create"]
>[0];

function subjectFor(limits: FakeLimits, created: FakeSqlStore[] = []) {
  return (options: CreateOptions): CommitConformanceSubject => {
    const store = new FakeSqlStore(limits);
    created.push(store);
    return {
      async commit(patch, context) {
        await commitSqlPatch(patch, context, store.driver, store.dialect, {
          searchIndexOnImport: options.searchIndexOnImport,
          projection: {
            textSplitter: splitter,
            embeddingService: options.embeddingService,
            vectorDimensions: 32,
          },
        });
      },
      storedQuads: () =>
        Promise.resolve([...store.quads.values()].map((v) => v.quad)),
      chunkedQuadIds: () => Promise.resolve(store.chunks.map((c) => c.quadId)),
      failNextWrite: () => store.failNextInsertBatch(),
      failLaterWrite: () => store.failLaterWrite(),
      fullRebuildCount: () => store.clearCount,
    };
  };
}

async function runSuite(
  limits: FakeLimits,
  contract: CommitConformanceContract,
): Promise<LaterWriteRecord> {
  const created: FakeSqlStore[] = [];
  const report = await runCommitConformanceSuite({
    create: subjectFor(limits, created),
    contract,
  });
  const failed = report.results.filter((r) => !r.ok);
  assert(
    report.ok,
    `conformance failures: ${
      failed.map((r) => `${r.name}: ${r.failures.join("; ")}`).join(" | ")
    }`,
  );
  const skipped = (report.notes ?? []).filter((note) => /skip/i.test(note));
  assertEquals(skipped, [], "no conformance case may be skipped");
  assert(
    report.results.some((r) => r.name.startsWith("later-write failure")),
    "the later-write case must run",
  );
  const fired = created.flatMap((store) =>
    store.laterInjections.map((injection) => ({ store, injection }))
  );
  assertEquals(fired.length, 1, "the later write failed exactly once");
  return fired[0]!;
}

/** LaterWriteRecord is the store and injection of the one later-write failure a suite run fired. */
interface LaterWriteRecord {
  store: FakeSqlStore;
  injection: FakeSqlStore["laterInjections"][number];
}

Deno.test("the core passes the conformance suite on the atomic path", async () => {
  const { store, injection } = await runSuite(
    { maxAtomicStatements: 10_000, writeBatchSize: 500 },
    {
      atomic: true,
      embeddingFailure: "throws",
      replaceImportFailure: "keeps-old-graph",
      defaultSearchIndexOnImport: "incremental",
    },
  );
  // One atomic batch: the quad writes ran in it before the chunk write failed,
  // then the whole batch rolled back, so no cleanup statement was needed.
  assert(injection.index > 0, "the chunk write follows others in its batch");
  assert(
    injection.precedingKinds.includes("insert"),
    "quad writes were applied before the failing chunk write",
  );
  assert(
    store.batches[injection.batchNumber - 1]!.some((s) => s.kind === "insert"),
    "the quad writes and the failing chunk write share one batch",
  );
  assertEquals(store.executed("cleanup").length, 0, "atomic needs no cleanup");
});

Deno.test("the core passes the conformance suite on the chunked fallback path", async () => {
  // maxAtomicStatements 0 sends every commit down the fallback, one statement per batch.
  const { store, injection } = await runSuite(
    { maxAtomicStatements: 0, writeBatchSize: 1 },
    {
      atomic: false,
      embeddingFailure: "throws",
      replaceImportFailure: "empties-graph",
      defaultSearchIndexOnImport: "incremental",
    },
  );
  // Batch size 1: the quad writes were committed by earlier batches, so only
  // the core's compensating cleanup can have removed them.
  assertEquals(injection.index, 0, "the chunk write is a batch of its own");
  assert(
    injection.precedingKinds.includes("insert"),
    "quad writes were committed before the failing chunk write",
  );
  assert(store.executed("cleanup").length > 0, "the core's cleanup ran");
});

Deno.test("the suite catches a wrong atomic declaration on the fallback path", async () => {
  // A fallback backend that claims to be atomic must fail the suite: the
  // replace-import case expects the old graph to survive.
  const report = await runCommitConformanceSuite({
    create: subjectFor({ maxAtomicStatements: 0, writeBatchSize: 1 }),
    contract: {
      atomic: true,
      embeddingFailure: "throws",
      replaceImportFailure: "keeps-old-graph",
      defaultSearchIndexOnImport: "incremental",
    },
  });
  assert(!report.ok, "a fallback backend declaring atomic: true must fail");
});

Deno.test("the core passes the conformance suite when the weight budget drives the chunked path", async () => {
  // Count limits are generous; a budget of 1 puts every statement in a batch of its own (chunk rows weigh 10, over budget, so they go alone)
  // so only the weight budget makes the commit non-atomic.
  const { store, injection } = await runSuite(
    {
      maxAtomicStatements: 10_000,
      writeBatchSize: 500,
      statementWeight: fakeStatementWeight,
      maxBatchWeight: 1,
    },
    {
      atomic: false,
      embeddingFailure: "throws",
      replaceImportFailure: "empties-graph",
      defaultSearchIndexOnImport: "incremental",
    },
  );
  assertEquals(injection.index, 0, "the chunk write is a batch of its own");
  assert(
    injection.precedingKinds.includes("insert"),
    "quad writes were committed before the failing chunk write",
  );
  assert(store.executed("cleanup").length > 0, "the core's cleanup ran");
});
