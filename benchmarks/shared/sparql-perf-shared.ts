import { WorldsSdk, type WorldsSdkInterface } from "@worlds/sdk";
import { RdfjsQuadStore, RdfjsSearchIndex } from "@worlds/sdk/rdfjs";
import { WazooSparqlEngine } from "@wazoo/sparql-engine";
import { SqliteStore } from "@/sqlite/rdfjs-store/sqlite-store.ts";
import { generateSyntheticQuads } from "./synthetic-data.ts";

/** selectiveSubjectIri is the grounded subject for subject-bound SPARQL benchmarks. */
export const selectiveSubjectIri = "urn:entity:0";

/** selectiveSparqlQuery exercises a subject-bound BGP (quad index-friendly). */
export const selectiveSparqlQuery =
  `SELECT ?p ?o WHERE { <${selectiveSubjectIri}> ?p ?o }`;

/** fullScanSparqlQuery exercises an unbound triple pattern with a small result cap. */
export const fullScanSparqlQuery =
  "SELECT ?s ?p ?o WHERE { ?s ?p ?o } LIMIT 100";

/** SparqlQueryShape labels the SPARQL quad index perf query patterns. */
export type SparqlQueryShape = "selective" | "fullScan";

/** standardPerfQueryShapes is the default dev iteration set (subject-bound only). */
export const standardPerfQueryShapes = [
  "selective",
] as const satisfies readonly SparqlQueryShape[];

/** allPerfQueryShapes includes the unbound dev-scan shape (opt-in via BENCH_HEXASTORE_PERF_FULL_SCAN=1). */
export const allPerfQueryShapes = [
  "selective",
  "fullScan",
] as const satisfies readonly SparqlQueryShape[];

/**
 * resolvePerfQueryShapes returns query shapes for quad index perf bench registration.
 */
export function resolvePerfQueryShapes(): readonly SparqlQueryShape[] {
  return Deno.env.get("BENCH_HEXASTORE_PERF_FULL_SCAN") === "1"
    ? allPerfQueryShapes
    : standardPerfQueryShapes;
}

/**
 * createSqliteWorldsSdkForBench wires the shared WorldsSdk facade over a fresh
 * :memory: SqliteStore — the same topology the phase-4 parity suite proves.
 */
export function createSqliteWorldsSdkForBench(): WorldsSdkInterface {
  const store = new SqliteStore({ path: ":memory:" });
  return new WorldsSdk({
    quadStore: new RdfjsQuadStore({ store }),
    sparqlEngine: new WazooSparqlEngine({ store }),
    searchIndex: new RdfjsSearchIndex(store),
  });
}

/**
 * preloadSparqlPerfFixtures builds a warmed WorldsSdk per scale at module load.
 */
export async function preloadSparqlPerfFixtures(
  perfScales: readonly number[],
): Promise<Map<number, WorldsSdkInterface>> {
  const engines = new Map<number, WorldsSdkInterface>();
  for (const quadCount of perfScales) {
    // Timing logs go to stderr so `deno bench --json` stdout stays parseable.
    const startedAt = performance.now();
    const sdk = createSqliteWorldsSdkForBench();
    await sdk.import({
      source: { kind: "quads", quads: generateSyntheticQuads(quadCount) },
    });
    console.error(
      `generate + import ${quadCount} quads: ${
        Math.round(performance.now() - startedAt)
      }ms`,
    );
    engines.set(quadCount, sdk);
  }
  return engines;
}

/**
 * sparqlQueryForShape returns the SPARQL string for a quad index perf query shape.
 */
export function sparqlQueryForShape(queryShape: SparqlQueryShape): string {
  return queryShape === "selective"
    ? selectiveSparqlQuery
    : fullScanSparqlQuery;
}

/**
 * registerSparqlPerfBenchmarks registers execute-only SPARQL Deno.bench entries.
 */
export function registerSparqlPerfBenchmarks(
  perfScales: readonly number[],
  engines: Map<number, WorldsSdkInterface>,
  queryShapes: readonly SparqlQueryShape[] = resolvePerfQueryShapes(),
): void {
  for (const quadCount of perfScales) {
    for (const queryShape of queryShapes) {
      const query = sparqlQueryForShape(queryShape);
      const engine = engines.get(quadCount);
      if (!engine) {
        throw new Error(`Missing preloaded SPARQL fixture: ${quadCount}`);
      }
      Deno.bench({
        name:
          `SPARQL Hexastore Perf: ${quadCount} quads | ${queryShape} | sqliteStore`,
        group: `SPARQL Hexastore Perf (${quadCount})`,
        async fn(benchContext) {
          benchContext.start();
          await engine.sparql({ query });
          benchContext.end();
        },
      });
    }
  }
}
