import {
  preloadSparqlPerfFixtures,
  registerSparqlPerfBenchmarks,
} from "./shared/sparql-perf-shared.ts";

// Mirrors libsql's large-scale group (structure, not exact scales). The 1M
// and 500k scales are omitted: sqlite's fixtures are in-memory (no file
// cache) and the 500k preload alone runs ~2 minutes at multi-GB memory on
// this box, so 100k/250k keep `bench:check` practical.
const largePerfScales = [100_000, 250_000] as const;

const engines = await preloadSparqlPerfFixtures(largePerfScales);

registerSparqlPerfBenchmarks(largePerfScales, engines);
