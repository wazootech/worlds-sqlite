// Term-key parity: @worlds/sqlite's row keys must never diverge from the
// engine's, since both packages key quads by RDF-term identity. The store
// owns its copy of termKey (it must not import the engine), so this suite
// pins the two implementations together on a term corpus covering every
// termType, literal language/datatype, and RDF-star nesting.
import { assertEquals } from "@std/assert";
import { DataFactory } from "n3";
import { termKey as engineTermKey } from "@wazoo/sparql-engine/term";
import { termKey as localTermKey } from "@/sqlite/term/term-key.ts";

const { namedNode, blankNode, variable, literal, defaultGraph, quad } =
  DataFactory;

const ex = (suffix: string) => namedNode(`http://example.org/${suffix}`);
const XSD_INTEGER = "http://www.w3.org/2001/XMLSchema#integer";

const corpus = [
  namedNode("http://example.org/x"),
  ex("with-hyphen/and/slash"),
  blankNode("b1"),
  variable("?v"),
  defaultGraph(),
  literal("plain"),
  literal("hola", "es"),
  literal("42", namedNode(XSD_INTEGER)),
  literal("", namedNode(XSD_INTEGER)),
  // RDF-star triple terms, including nesting.
  quad(ex("s"), ex("p"), ex("o")),
  quad(ex("s"), ex("p"), literal("v")),
  quad(
    ex("s"),
    ex("p"),
    quad(ex("a"), ex("b"), ex("c")),
  ),
];

Deno.test("term-key parity — @worlds/sqlite matches @wazoo/sparql-engine on the term corpus", () => {
  for (const term of corpus) {
    assertEquals(
      localTermKey(term),
      engineTermKey(term),
      `termKey mismatch for ${term.termType}: ${term.value}`,
    );
  }
});

Deno.test("term-key parity — distinct terms never collide", () => {
  const keys = new Set(corpus.map((term) => localTermKey(term)));
  assertEquals(keys.size, corpus.length);
});
