/**
 * Phase-4 parity suite seed (workspace#64, #72) — copied from the sdk's
 * proving-ground test (worlds-sdk-ts/src/testing/run-parity-suite.sqlite.test.ts,
 * landed in worlds-sdk-ts#178).
 *
 * Runs the shared fixture corpus with the zero-dependency reference —
 * @worlds/sdk/memory's createMemorySdk — against SqliteStore, the durable
 * store this backend ships (the same topology client-integration.test.ts
 * proves end to end). No libsql anywhere in the run. The libsql-reference
 * comparison lands when the shared harness grows its reference fixtures.
 *
 * Search ordering is compared set-wise (strictSearchOrder: false): scan-based
 * keyword search order is a store implementation detail, not a parity contract.
 */
import { assertEquals } from "@std/assert";
import { Sdk } from "@worlds/sdk";
import { RdfjsQuadStore, RdfjsSearchIndex } from "@worlds/sdk/rdfjs";
import { createMemorySdk } from "@worlds/sdk/memory";
import { parityCorpus, runParitySuite } from "@worlds/sdk/testing";
import { WazooSparqlEngine } from "@wazoo/sparql-engine";
import { SqliteStore } from "@/sqlite/rdfjs-store/sqlite-store.ts";

function createSqliteSdk(): Sdk {
  const store = new SqliteStore({ path: ":memory:" });
  return new Sdk({
    quadStore: new RdfjsQuadStore({ store }),
    sparqlEngine: new WazooSparqlEngine({ store }),
    searchIndex: new RdfjsSearchIndex(store),
  });
}

Deno.test(
  "parity suite - SqliteStore agrees with the in-memory reference on the full corpus",
  async () => {
    const report = await runParitySuite({
      reference: () => createMemorySdk(),
      candidate: () => createSqliteSdk(),
      strictSearchOrder: false,
    });

    assertEquals(
      report.results.length,
      parityCorpus.fixtures.length + parityCorpus.replaceCases.length,
      "every corpus fixture and replace case runs on both stores",
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

    // The reference-gated fixtures must be clean on both stores — any
    // divergence there is a real parity break, not a declared-category note.
    const referenceGated = report.results.filter(
      (r) => r.name !== "rdfStarWorld",
    );
    for (const result of referenceGated) {
      assertEquals(
        result.ok,
        true,
        `${result.name}: ${result.failures.join("; ")}`,
      );
      assertEquals(
        result.notes,
        undefined,
        `${result.name} must have no notes`,
      );
    }
  },
);
