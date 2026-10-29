import type * as rdfjs from "@rdfjs/types";
import { termKey } from "@/sqlite/term/term-key.ts";
import type {
  QuadKey,
  SqliteQuadPattern,
  SqliteQuadPatternWhereClause,
} from "./sqlite-quad-types.ts";

export type {
  InsertQuadRow,
  QuadKey,
  SqliteQuadPattern,
  SqliteQuadPatternWhereClause,
} from "./sqlite-quad-types.ts";
export {
  buildBulkInsertQuads,
  buildDeleteQuadsByQuadKeys,
  buildInsertQuad,
  buildSelectExistingQuadKeys,
  buildWipeAllGraphDataStatements,
  BULK_INSERT_QUAD_ROWS_PER_STATEMENT,
} from "./sqlite-quad-write-sql.ts";

/**
 * quadKeyFor builds the composite key for a quad (the same key
 * SqliteStore uses for row identity and RDF term equality).
 */
export function quadKeyFor(quad: rdfjs.Quad): QuadKey {
  return [
    termKey(quad.subject),
    termKey(quad.predicate),
    termKey(quad.object),
    termKey(quad.graph),
  ];
}

/** quadKeyString joins a QuadKey into a single comparable string. */
export function quadKeyString(key: QuadKey): string {
  return key.join("\u0000");
}

/** DEFAULT_SQLITE_MATCH_PAGE_SIZE is the default rows per paged read. */
export const DEFAULT_SQLITE_MATCH_PAGE_SIZE = 1000;

export function generatePlaceholders(count: number): string {
  return Array(count).fill("?").join(", ");
}

/**
 * buildSqliteQuadPatternWhereClause binds each bound pattern position by its
 * term-equality key — the same equality the L1 store's match() uses, so SQL
 * reads and store reads always agree on term identity.
 */
export function buildSqliteQuadPatternWhereClause(
  pattern: SqliteQuadPattern,
): SqliteQuadPatternWhereClause {
  const conditions: string[] = [];
  const args: (string | null)[] = [];

  if (pattern.subject) {
    conditions.push("skey = ?");
    args.push(termKey(pattern.subject));
  }
  if (pattern.predicate) {
    conditions.push("pkey = ?");
    args.push(termKey(pattern.predicate));
  }
  if (pattern.object) {
    conditions.push("okey = ?");
    args.push(termKey(pattern.object));
  }
  if (pattern.graph) {
    conditions.push("gkey = ?");
    args.push(termKey(pattern.graph));
  }

  return { conditions, args };
}

/**
 * buildMatchQuadsQuery builds a keyset-paged SELECT over the quads table,
 * ordered by the composite primary key for stable paging.
 */
export function buildMatchQuadsQuery(
  pattern: SqliteQuadPattern,
  pageOptions?: { afterKey?: QuadKey; limit?: number },
): { sql: string; args: (string | null)[] } {
  const { conditions, args } = buildSqliteQuadPatternWhereClause(pattern);

  if (pageOptions?.afterKey) {
    conditions.push("(skey, pkey, okey, gkey) > (?, ?, ?, ?)");
    args.push(...pageOptions.afterKey);
  }

  const whereClause = conditions.length > 0
    ? `WHERE ${conditions.join(" AND ")}`
    : "";

  let limitClause = "";
  if (pageOptions?.limit != null) {
    limitClause = " LIMIT ?";
    args.push(String(Math.max(1, Math.floor(pageOptions.limit))));
  }

  return {
    sql:
      `SELECT skey, pkey, okey, gkey, payload FROM quads ${whereClause} ORDER BY skey, pkey, okey, gkey ASC${limitClause}`,
    args,
  };
}

/** buildCountQuadsQuery builds a COUNT(*) query for a quad pattern. */
export function buildCountQuadsQuery(
  pattern: SqliteQuadPattern,
): { sql: string; args: (string | null)[] } {
  const { conditions, args } = buildSqliteQuadPatternWhereClause(pattern);
  const whereClause = conditions.length > 0
    ? `WHERE ${conditions.join(" AND ")}`
    : "";

  return {
    sql: `SELECT COUNT(*) AS count FROM quads ${whereClause}`,
    args,
  };
}
