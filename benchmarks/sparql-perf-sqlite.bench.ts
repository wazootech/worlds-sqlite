import {
  preloadSparqlPerfFixtures,
  registerSparqlPerfBenchmarks,
} from "./shared/sparql-perf-shared.ts";

const standardPerfScales = [1_000, 5_000, 10_000, 25_000, 50_000] as const;

const engines = await preloadSparqlPerfFixtures(standardPerfScales);

registerSparqlPerfBenchmarks(standardPerfScales, engines);
