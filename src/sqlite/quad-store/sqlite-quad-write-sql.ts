import type { InsertQuadRow, QuadKey } from "./sqlite-quad-types.ts";

/** BULK_INSERT_QUAD_COLUMN_COUNT is the column width of a quads INSERT. */
const BULK_INSERT_QUAD_COLUMN_COUNT = 5;

/** BULK_INSERT_QUAD_ROWS_PER_STATEMENT caps rows per INSERT statement. */
export const BULK_INSERT_QUAD_ROWS_PER_STATEMENT = 80;

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
