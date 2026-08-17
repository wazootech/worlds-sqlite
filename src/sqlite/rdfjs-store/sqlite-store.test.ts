import { assertEquals, assertRejects } from "@std/assert";
import type * as rdfjs from "@rdfjs/types";
import { DataFactory } from "n3";
import { sameRdfTerm } from "@/sqlite/term/term-key.ts";
import { SqliteStore } from "@/sqlite/rdfjs-store/sqlite-store.ts";
import { WazooSparqlEngine } from "@wazoo/sparql-engine";

const { namedNode, literal, quad, defaultGraph } = DataFactory;

const ex = (suffix: string) => namedNode(`http://example.org/${suffix}`);
const alice = ex("alice");
const name = ex("name");
const knows = ex("knows");
const graphA = ex("g/a");
const graphB = ex("g/b");

function tempDbPath(): string {
  const dir = Deno.makeTempDirSync();
  return `${dir}/test.sqlite`;
}

function makeEngine(path: string): WazooSparqlEngine {
  const store = new SqliteStore({ path });
  return new WazooSparqlEngine({
    store,
    createTransaction: () => store.createTransaction(),
  });
}

function collect(
  stream: rdfjs.Stream<rdfjs.Quad>,
): Promise<rdfjs.Quad[]> {
  return new Promise((resolve, reject) => {
    const out: rdfjs.Quad[] = [];
    stream.on("data", (q: rdfjs.Quad) => out.push(q));
    stream.on("end", () => resolve(out));
    stream.on("error", reject);
  });
}

Deno.test("SqliteStore - round-trips terms with full fidelity", async () => {
  const path = tempDbPath();
  const store = new SqliteStore({ path });
  const langLit = literal("hola", "es");
  const typedLit = literal(
    "42",
    namedNode("http://www.w3.org/2001/XMLSchema#integer"),
  );
  const starTerm = quad(alice, knows, ex("bob"));
  store.addQuad(quad(alice, name, langLit));
  store.addQuad(quad(alice, name, typedLit));
  store.addQuad(quad(alice, knows, starTerm));

  const got = await collect(store.match());
  assertEquals(got.length, 3);

  const langBack = got.find((q) =>
    q.object.termType === "Literal" &&
    (q.object as rdfjs.Literal).language === "es"
  );
  assertEquals(langBack !== undefined, true);
  assertEquals(
    sameRdfTerm(langBack!.object, langLit),
    true,
  );

  const typedBack = got.find((q) =>
    q.object.termType === "Literal" &&
    (q.object as rdfjs.Literal).datatype.value.includes("integer")
  );
  assertEquals(
    sameRdfTerm(typedBack!.object, typedLit),
    true,
  );

  const starBack = got.find((q) => q.object.termType === "Quad");
  assertEquals(starBack !== undefined, true);
  assertEquals(sameRdfTerm(starBack!.object, starTerm), true);
  store.close();
});

Deno.test("SqliteStore - quads differing only by graph do not collide", () => {
  const store = new SqliteStore({ path: ":memory:" });
  store.addQuad(quad(alice, name, literal("A"), graphA));
  store.addQuad(quad(alice, name, literal("A"), graphB));
  store.addQuad(quad(alice, name, literal("A"), defaultGraph()));

  assertEquals(store.size, 3);
  assertEquals(store.countQuads(), 3);
  assertEquals(store.countQuads(null, null, null, graphA), 1);
  assertEquals(store.countQuads(null, null, null, graphB), 1);
  assertEquals(store.countQuads(null, null, null, defaultGraph()), 1);

  store.removeQuad(quad(alice, name, literal("A"), graphA));
  assertEquals(store.size, 2);
  store.close();
});

Deno.test("SqliteStore - data persists across store reopen", async () => {
  const path = tempDbPath();
  const engine = makeEngine(path);
  await engine.execute({
    query:
      'INSERT DATA { <http://example.org/alice> <http://example.org/name> "Alice" . }',
  });
  await engine.execute({
    query:
      "INSERT DATA { GRAPH <http://example.org/g/a> { <http://example.org/alice> <http://example.org/knows> <http://example.org/bob> } }",
  });

  // Reopen the same file with a brand-new store instance.
  const store2 = new SqliteStore({ path });
  const engine2 = new WazooSparqlEngine({
    store: store2,
    createTransaction: () => store2.createTransaction(),
  });
  const result = await engine2.execute({
    query:
      "SELECT ?name WHERE { <http://example.org/alice> <http://example.org/name> ?name }",
  });
  assertEquals(result.kind, "select");
  if (result.kind === "select") {
    assertEquals(result.data.head.vars, ["name"]);
    assertEquals(result.data.results.bindings.length, 1);
    const binding = result.data.results.bindings[0];
    assertEquals(binding.name.type, "literal");
    assertEquals(binding.name.value, "Alice");
  }
  assertEquals(store2.size, 2);
  store2.close();
});

Deno.test("SqliteStore - update through createTransaction commits atomically", async () => {
  const path = tempDbPath();
  const engine = makeEngine(path);
  await engine.execute({
    query:
      'INSERT DATA { <http://example.org/alice> <http://example.org/name> "Alice" . } ;' +
      "INSERT DATA { GRAPH <http://example.org/g/a> { <http://example.org/alice> <http://example.org/knows> <http://example.org/bob> } }",
  });

  const store = new SqliteStore({ path });
  assertEquals(store.size, 2);
  assertEquals(
    store.countQuads(null, null, null, graphA),
    1,
  );
  store.close();
});

Deno.test("SqliteStore - failed commit rolls back every buffered write", async () => {
  const path = tempDbPath();
  const store = new SqliteStore({
    path,
    beforeCommit: () => {
      throw new Error("simulated commit failure");
    },
  });
  const engine = new WazooSparqlEngine({
    store,
    createTransaction: () => store.createTransaction(),
  });

  await assertRejects(
    async () => {
      await engine.execute({
        query:
          'INSERT DATA { <http://example.org/alice> <http://example.org/name> "Alice" . } ;' +
          'INSERT DATA { <http://example.org/bob> <http://example.org/name> "Bob" . }',
      });
    },
    Error,
    "simulated commit failure",
  );

  // Nothing was persisted, and the store remains usable.
  assertEquals(store.size, 0);
  const fresh = new SqliteStore({ path });
  assertEquals(fresh.size, 0);
  fresh.close();
  store.close();
});

Deno.test("SqliteStore - transaction rollback discards buffered writes", () => {
  const store = new SqliteStore({ path: ":memory:" });
  const txn = store.createTransaction();
  txn.add(quad(alice, name, literal("Alice")));
  txn.add(quad(ex("bob"), name, literal("Bob")));
  txn.rollback();
  assertEquals(store.size, 0);
  store.close();
});

Deno.test("SqliteStore - add then delete of the same quad nets to nothing", async () => {
  const store = new SqliteStore({ path: ":memory:" });
  const txn = store.createTransaction();
  txn.add(quad(alice, name, literal("Alice")));
  txn.delete(quad(alice, name, literal("Alice")));
  await txn.commit();
  assertEquals(store.size, 0);

  const txn2 = store.createTransaction();
  txn2.delete(quad(alice, name, literal("Alice")));
  txn2.add(quad(alice, name, literal("Alice")));
  await txn2.commit();
  assertEquals(store.size, 1);
  store.close();
});

Deno.test("SqliteStore - deleteGraph clears exactly one graph", () => {
  const store = new SqliteStore({ path: ":memory:" });
  store.addQuad(quad(alice, name, literal("A"), graphA));
  store.addQuad(quad(alice, name, literal("A"), graphB));
  store.deleteGraph(graphA.value);
  assertEquals(store.size, 1);
  assertEquals(store.countQuads(null, null, null, graphA), 0);
  assertEquals(store.countQuads(null, null, null, graphB), 1);
  store.close();
});
