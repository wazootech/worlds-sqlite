/**
 * Hello world: basic quad store + SPARQL over an in-memory SqliteStore.
 *
 * Run from the repo root:
 *
 *   deno run --allow-all examples/hello-world/main.ts
 *
 * This example exercises the Layer 1 surface directly: a durable
 * `rdfjs.Store` over a synchronous SQLite handle, wired through
 * `WazooSparqlEngine` for SPARQL read/write.
 */
import { DataFactory } from "n3";
import { WazooSparqlEngine } from "@wazoo/sparql-engine";
import { SqliteStore } from "@/sqlite/rdfjs-store/mod.ts";

const { namedNode, literal, quad, defaultGraph } = DataFactory;

const store = new SqliteStore({ path: ":memory:" });
const engine = new WazooSparqlEngine({
  store,
  createTransaction: () => store.createTransaction(),
});

// One named triple, then a SPARQL SELECT over it.
store.addQuad(
  quad(
    namedNode("http://example.org/alice"),
    namedNode("http://example.org/name"),
    literal("Alice"),
    defaultGraph(),
  ),
);

console.log(store.size); // 1

const results = await engine.execute({
  query: "SELECT ?name WHERE { ?s <http://example.org/name> ?name }",
});

if (results.kind === "select") {
  console.log(results.kind); // "select"
  console.log(results.data.results.bindings.length); // 1
  console.log(results.data.results.bindings[0].name.value); // "Alice"
}

store.close();
