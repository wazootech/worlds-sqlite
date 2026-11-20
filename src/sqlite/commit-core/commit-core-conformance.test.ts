import { assert } from "@std/assert";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { runCommitConformanceSuite } from "@worlds/sdk/testing";
import type {
  CommitConformanceContract,
  CommitConformanceSubject,
} from "@worlds/sdk/testing";
import { commitSqlPatch } from "@/sql-core/mod.ts";
import { type FakeLimits, FakeSqlStore } from "./sql-commit.fake.ts";

const splitter = new RecursiveCharacterTextSplitter({ chunkSize: 1000 });

type CreateOptions = Parameters<
  Parameters<typeof runCommitConformanceSuite>[0]["create"]
>[0];

function subjectFor(limits: FakeLimits) {
  return (options: CreateOptions): CommitConformanceSubject => {
    const store = new FakeSqlStore(limits);
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
      fullRebuildCount: () => store.clearCount,
    };
  };
}

async function runSuite(
  limits: FakeLimits,
  contract: CommitConformanceContract,
): Promise<void> {
  const report = await runCommitConformanceSuite({
    create: subjectFor(limits),
    contract,
  });
  const failed = report.results.filter((r) => !r.ok);
  assert(
    report.ok,
    `conformance failures: ${
      failed.map((r) => `${r.name}: ${r.failures.join("; ")}`).join(" | ")
    }`,
  );
}

Deno.test("the core passes the conformance suite on the atomic path", async () => {
  await runSuite(
    { maxAtomicStatements: 10_000, writeBatchSize: 500 },
    {
      atomic: true,
      embeddingFailure: "throws",
      replaceImportFailure: "keeps-old-graph",
      defaultSearchIndexOnImport: "incremental",
    },
  );
});

Deno.test("the core passes the conformance suite on the chunked fallback path", async () => {
  // maxAtomicStatements 0 sends every commit down the fallback, one statement per batch.
  await runSuite(
    { maxAtomicStatements: 0, writeBatchSize: 1 },
    {
      atomic: false,
      embeddingFailure: "throws",
      replaceImportFailure: "empties-graph",
      defaultSearchIndexOnImport: "incremental",
    },
  );
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
