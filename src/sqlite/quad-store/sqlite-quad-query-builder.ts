import type * as rdfjs from "@rdfjs/types";
import { termKey } from "@/sqlite/term/term-key.ts";

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

/** BULK_INSERT_QUAD_COLUMN_COUNT is the column width of a quads INSERT. */
const BULK_INSERT_QUAD_COLUMN_COUNT = 5;

/** BULK_INSERT_QUAD_ROWS_PER_STATEMENT caps rows per INSERT statement. */
export const BULK_INSERT_QUAD_ROWS_PER_STATEMENT = 80;

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

/**
 * buildSelectExistingQuadKeys builds a row-value IN presence query over the
 * composite key, chunked by the caller so IN-clause widths stay bounded.
 */
export function buildSelectExistingQuadKeys(
  keys: QuadKey[],
): { sql: string; args: string[] } {
  const rowValues = keys.map(() => "(?, ?, ?, ?)").join(", ");
  const args: string[] = [];
  for (const key of keys) args.push(...key);
  return {
    sql:
      `SELECT skey, pkey, okey, gkey FROM quads WHERE (skey, pkey, okey, gkey) IN (${rowValues})`,
    args,
  };
}

/** buildDeleteQuadsByQuadKeys builds a row-value IN deletion over composite keys. */
export function buildDeleteQuadsByQuadKeys(
  keys: QuadKey[],
): { sql: string; args: string[] } {
  const rowValues = keys.map(() => "(?, ?, ?, ?)").join(", ");
  const args: string[] = [];
  for (const key of keys) args.push(...key);
  return {
    sql: `DELETE FROM quads WHERE (skey, pkey, okey, gkey) IN (${rowValues})`,
    args,
  };
}

/** buildInsertQuad builds a single-quad INSERT OR REPLACE statement. */
export function buildInsertQuad(
  insertQuadRow: InsertQuadRow,
): { sql: string; args: (string | null)[] } {
  return buildBulkInsertQuads([insertQuadRow])[0];
}

/**
 * buildBulkInsertQuads builds INSERT OR REPLACE statements for quads rows,
 * batching at BULK_INSERT_QUAD_ROWS_PER_STATEMENT rows per statement to stay
 * under SQLite's host-parameter budget.
 */
export function buildBulkInsertQuads(
  insertQuadRows: InsertQuadRow[],
): Array<{ sql: string; args: (string | null)[] }> {
  if (insertQuadRows.length === 0) {
    return [];
  }

  const statements: Array<{ sql: string; args: (string | null)[] }> = [];

  for (
    let rowOffset = 0;
    rowOffset < insertQuadRows.length;
    rowOffset += BULK_INSERT_QUAD_ROWS_PER_STATEMENT
  ) {
    const rowBatch = insertQuadRows.slice(
      rowOffset,
      rowOffset + BULK_INSERT_QUAD_ROWS_PER_STATEMENT,
    );
    const valuePlaceholders = rowBatch
      .map(() => "(?, ?, ?, ?, ?)")
      .join(", ");
    const args: (string | null)[] = [];

    for (const row of rowBatch) {
      args.push(...row.key, row.payload);
    }

    if (
      args.length >
        BULK_INSERT_QUAD_ROWS_PER_STATEMENT * BULK_INSERT_QUAD_COLUMN_COUNT
    ) {
      throw new Error(
        `buildBulkInsertQuads: batch exceeds SQLite host-parameter budget (${args.length})`,
      );
    }

    statements.push({
      sql:
        `INSERT OR REPLACE INTO quads (skey, pkey, okey, gkey, payload) VALUES ${valuePlaceholders}`,
      args,
    });
  }

  return statements;
}

/**
 * buildWipeAllGraphDataStatements clears search chunks (FTS rows via trigger,
 * plus vec rows when the vec0 table exists) and durable quads for a
 * replace-mode import.
 */
export function buildWipeAllGraphDataStatements(options?: {
  vectorSupported?: boolean;
}): Array<{ sql: string; args: [] }> {
  const statements: Array<{ sql: string; args: [] }> = [];
  if (options?.vectorSupported) {
    statements.push({ sql: "DELETE FROM chunks_vec", args: [] });
  }
  statements.push(
    { sql: "DELETE FROM chunks", args: [] },
    { sql: "DELETE FROM quads", args: [] },
  );
  return statements;
}
