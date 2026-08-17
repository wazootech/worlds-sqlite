import type * as rdfjs from "@rdfjs/types";

/**
 * termKey renders a deterministic key for an RDF/JS term, normalizing its
 * type, value, and — for literals — language and datatype, with RDF-star
 * nesting handled recursively. Two terms produce the same key exactly when
 * they are the same RDF term, so termKey is a sound hash-index key.
 *
 * This is the same scheme `@wazoo/sparql-engine` uses for its stores; the
 * term-key parity suite (`src/sqlite/rdfjs-store/term-key-parity.test.ts`)
 * asserts equivalence against the published engine so row keys never diverge
 * between the two packages.
 */
export function termKey(term: rdfjs.Term): string {
  switch (term.termType) {
    case "NamedNode":
      return `uri:${term.value}`;
    case "BlankNode":
      return `bnode:${term.value}`;
    case "Variable":
      return `var:${term.value}`;
    case "DefaultGraph":
      return "default";
    case "Literal":
      return (
        `literal:${term.value}|${term.language ?? ""}|` +
        `${term.direction ?? ""}|${term.datatype?.value ?? ""}`
      );
    case "Quad":
      return (
        `quad:${termKey(term.subject)}|${termKey(term.predicate)}|` +
        termKey(term.object)
      );
    default:
      throw new Error(
        `Unsupported RDF term type: ${(term as rdfjs.Term).termType}`,
      );
  }
}

/**
 * sameRdfTerm compares two RDF/JS terms by type, value, and literal
 * language/datatype. RDF-star triple terms are compared structurally on
 * subject, predicate, and object — the graph is a property of the statement,
 * not of the triple term, so it is not part of term identity.
 */
export function sameRdfTerm(a: rdfjs.Term, b: rdfjs.Term): boolean {
  if (a.termType !== b.termType) {
    return false;
  }
  switch (a.termType) {
    case "NamedNode":
      return a.value === (b as rdfjs.NamedNode).value;
    case "BlankNode":
      return a.value === (b as rdfjs.BlankNode).value;
    case "Variable":
      return a.value === (b as rdfjs.Variable).value;
    case "DefaultGraph":
      return true;
    case "Literal":
      return a.value === (b as rdfjs.Literal).value &&
        a.language === (b as rdfjs.Literal).language &&
        (a.direction ?? "") === ((b as rdfjs.Literal).direction ?? "") &&
        (a.datatype?.value ?? "") ===
          ((b as rdfjs.Literal).datatype?.value ?? "");
    case "Quad":
      return sameRdfTerm(a.subject, (b as rdfjs.Quad).subject) &&
        sameRdfTerm(a.predicate, (b as rdfjs.Quad).predicate) &&
        sameRdfTerm(a.object, (b as rdfjs.Quad).object);
    default:
      throw new Error(
        `Unsupported RDF term type: ${(a as rdfjs.Term).termType}`,
      );
  }
}
