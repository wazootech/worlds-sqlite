import type * as rdfjs from "@rdfjs/types";
import { DataFactory } from "@wazoo/sparql-engine";
import { termKey } from "@/sqlite/term/term-key.ts";

/** Lossless, JSON-serializable term encoding (kept private to this module). */
type TermRecord =
  | { t: "N"; v: string } // NamedNode
  | { t: "B"; v: string } // BlankNode
  | { t: "V"; v: string } // Variable
  | { t: "D" } // DefaultGraph
  | { t: "L"; v: string; lang: string; dt: string } // Literal
  | { t: "Q"; s: TermRecord; p: TermRecord; o: TermRecord }; // RDF-star triple term

type QuadRecord = {
  s: TermRecord;
  p: TermRecord;
  o: TermRecord;
  g: TermRecord;
};

function toTermRecord(term: rdfjs.Term): TermRecord {
  switch (term.termType) {
    case "NamedNode":
      return { t: "N", v: term.value };
    case "BlankNode":
      return { t: "B", v: term.value };
    case "Variable":
      return { t: "V", v: term.value };
    case "DefaultGraph":
      return { t: "D" };
    case "Literal":
      return {
        t: "L",
        v: term.value,
        lang: term.language,
        dt: term.datatype.value,
      };
    case "Quad":
      return {
        t: "Q",
        s: toTermRecord(term.subject),
        p: toTermRecord(term.predicate),
        o: toTermRecord(term.object),
      };
  }
}

function fromTermRecord(rec: TermRecord): rdfjs.Term {
  switch (rec.t) {
    case "N":
      return DataFactory.namedNode(rec.v);
    case "B":
      return DataFactory.blankNode(rec.v);
    case "V":
      return DataFactory.variable(rec.v);
    case "D":
      return DataFactory.defaultGraph();
    case "L":
      return rec.lang
        ? DataFactory.literal(rec.v, rec.lang)
        : DataFactory.literal(rec.v, DataFactory.namedNode(rec.dt));
    case "Q":
      // The engine's quad() types are strict about positions, but RDF 1.2
      // triple terms allow any term in any position (literal subjects
      // included) — cast to the position types, which is always sound here.
      return DataFactory.quad(
        fromTermRecord(rec.s) as rdfjs.Quad_Subject,
        fromTermRecord(rec.p) as rdfjs.Quad_Predicate,
        fromTermRecord(rec.o) as rdfjs.Quad_Object,
      );
  }
}

function toQuadRecord(quad: rdfjs.Quad): QuadRecord {
  return {
    s: toTermRecord(quad.subject),
    p: toTermRecord(quad.predicate),
    o: toTermRecord(quad.object),
    g: toTermRecord(quad.graph),
  };
}

export function fromQuadRecord(rec: QuadRecord): rdfjs.Quad {
  // Reconstructed positions may be any term (RDF 1.2 quoted triples allow
  // literal subjects); the engine's position types are narrower, so cast.
  return DataFactory.quad(
    fromTermRecord(rec.s) as rdfjs.Quad_Subject,
    fromTermRecord(rec.p) as rdfjs.Quad_Predicate,
    fromTermRecord(rec.o) as rdfjs.Quad_Object,
    fromTermRecord(rec.g) as rdfjs.Quad_Graph,
  );
}

export function quadKey(quad: rdfjs.Quad): string {
  return [
    termKey(quad.subject),
    termKey(quad.predicate),
    termKey(quad.object),
    termKey(quad.graph),
  ].join("\u0000");
}

/**
 * quadToPayloadJson serializes a quad to the store's lossless JSON payload
 * format. Exported so the L2 commit path (commitPatchToSqlite) writes rows in
 * exactly the same encoding the store reads back.
 */
export function quadToPayloadJson(quad: rdfjs.Quad): string {
  return JSON.stringify(toQuadRecord(quad));
}

/**
 * quadFromPayloadJson reconstructs a quad from the store's lossless JSON
 * payload format. Exported so the L2 rebuild path can page over the quads
 * table directly while keeping the payload format's single source of truth
 * here.
 */
export function quadFromPayloadJson(payload: string): rdfjs.Quad {
  return fromQuadRecord(JSON.parse(payload) as QuadRecord);
}
