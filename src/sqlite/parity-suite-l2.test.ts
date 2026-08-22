/**
 * Layer 2 parity suite (workspace#64, #72) — runs the shared fixture corpus
 * with reference = createMemoryWorldsSdk (the portable in-memory reference) and
 * candidate = createSqliteWorldsSdk over the materialized L2 surface (FTS5 keyword
 * search + optional sqlite-vec hybrid, commitPatchToSqlite, quad store).
 *
 * Exemptions (explicit, documented on workspace#72 — never silent):
 *   - chunkBoundaryWorld is excluded via the harness's fixtures override:
 *     the sqlite chunker splits literals at 1000 chars (the chunker
 *     divergence); memory has no chunker, so chunk-derived search ids/text
 *     cannot be compared. Same exemption as the libsql reference suite.
 *   - rdfStarWorld runs under its declared gate (the store actually supports
 *     RDF-star via the lossless L1 payload, but the corpus category is
 *     declared until the reference does).
 *
 * Search ordering is compared set-wise (strictSearchOrder: false): bm25
 * ranking vs scan order is an engine detail, not a parity contract.
 */
import { assertEquals } from "@std/assert";
import { createMemoryWorldsSdk } from "@worlds/sdk/memory";
import { parityCorpus, runParitySuite } from "@worlds/sdk/testing";
import { createSqliteWorldsSdk } from "./create-sqlite-sdk.ts";

const CHUNKER_DIVERGENT_FIXTURE = "chunkBoundaryWorld";

function createSqliteWorldsSdkForParity() {
  return createSqliteWorldsSdk({ path: ":memory:" });
}

Deno.test(
  "parity suite - createSqliteWorldsSdk agrees with the in-memory reference on the corpus",
  async () => {
    const fixtures = parityCorpus.fixtures.filter(
      (fixture) => fixture.name !== CHUNKER_DIVERGENT_FIXTURE,
    );

    const report = await runParitySuite({
      reference: () => createMemoryWorldsSdk(),
      candidate: () => createSqliteWorldsSdkForParity(),
      fixtures,
      strictSearchOrder: false,
    });

    assertEquals(
      report.results.length,
      fixtures.length + parityCorpus.replaceCases.length,
      "every non-exempted corpus fixture and replace case runs on both",
    );
    assertEquals(
      report.ok,
      true,
      report.results
        .map(
          (r) =>
            `${r.name}: ${r.failures.join("; ")}` +
            `${r.notes ? ` [notes: ${r.notes.join("; ")}]` : ""}`,
        )
        .join("\n"),
    );
  },
);
