/**
 * Hybrid search: full SDK with text splitting, embedding service, and search.
 *
 * Run from the repo root:
 *
 *   deno run --allow-all examples/hybrid-search/main.ts
 *
 * This example exercises the Layer 2 surface: `createSqliteWorldsSdk` with
 * an embedding service producing comparison vectors, then `import`, `search`,
 * and `sparql` over the materialized index.
 */
import { DataFactory } from "n3";
import { createSqliteWorldsSdk } from "@/sqlite/mod.ts";
import { FakeEmbeddingService } from "@worlds/sdk/search-index/embedding-service";

const { namedNode, literal, quad } = DataFactory;

const sdk = await createSqliteWorldsSdk({
  path: ":memory:",
  vectorDimensions: 32,
  embeddingService: new FakeEmbeddingService(),
});

// Two facts so both keyword-only and hybrid searches have something to find.
await sdk.import({
  source: {
    kind: "quads",
    quads: [
      quad(
        namedNode("urn:alice"),
        namedNode("urn:name"),
        literal("Alice the explorer"),
      ),
      quad(
        namedNode("urn:bob"),
        namedNode("urn:name"),
        literal("Bob lives in orbit"),
      ),
    ],
  },
});

const searchResult = await sdk.search({ query: "explorer", topK: 10 });
console.log(searchResult.results?.length); // 1
console.log(searchResult.results?.[0]?.text); // "Alice the explorer"

const sparqlResult = await sdk.sparql({
  query: "SELECT ?name WHERE { ?s <urn:name> ?name }",
});

if (sparqlResult.kind === "select") {
  console.log(sparqlResult.kind); // "select"
  console.log(sparqlResult.data.results.bindings.length); // 2
}

await sdk.close();
