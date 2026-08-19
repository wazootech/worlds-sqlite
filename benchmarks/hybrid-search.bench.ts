import { createSqliteSdkForBench } from "./shared/sparql-perf-shared.ts";
import { generateSyntheticQuads } from "./shared/synthetic-data.ts";

/**
 * Search performance (group mirrors libsql's "Hybrid Search Performance").
 *
 * Today worlds-sqlite ships the RDF/JS store only, and its phase-4 parity
 * suite searches through the shared scan-based `RdfjsSearchIndex`. This bench
 * measures that real path. The libsql-group counterparts that need the
 * materialized search index — FTS5 keyword-only, hybrid RRF fusion, and
 * degrade-to-keyword fallback — land with `SqliteSearchIndex` (workspace#64,
 * plan items 2–3) and will be added to this group then.
 */
const client = createSqliteSdkForBench();

const corpus = generateSyntheticQuads(1000);
await client.import({
  source: { kind: "quads", quads: corpus },
});

Deno.bench({
  name: "Search: Scan-based Keyword (RdfjsSearchIndex, 1,000 Quads)",
  group: "Hybrid Search Performance",
  async fn(benchContext) {
    benchContext.start();
    await client.search({ query: "synthetic data" });
    benchContext.end();
  },
});
