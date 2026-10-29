import type * as rdfjs from "@rdfjs/types";

/** SqliteQuadPattern is a four-position RDF quad pattern with nullable terms. */
export interface SqliteQuadPattern {
  subject: rdfjs.Term | null;
  predicate: rdfjs.Term | null;
  object: rdfjs.Term | null;
  graph: rdfjs.Term | null;
}

/**
 * QuadKey is the four term-equality keys (skey/pkey/okey/gkey) that
 * composite-key a row in the L1 quads table.
 */
export type QuadKey = [string, string, string, string];

/** InsertQuadRow is one parameterized quads-table row for bulk insertion. */
export interface InsertQuadRow {
  key: QuadKey;
  payload: string;
}

/** SqliteQuadPatternWhereClause is a built WHERE fragment with its args. */
export interface SqliteQuadPatternWhereClause {
  conditions: string[];
  args: (string | null)[];
}
