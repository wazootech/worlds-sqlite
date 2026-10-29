import { generatePlaceholders } from "@/sql-core/mod.ts";
import type { SqlStatement } from "@/sqlite/sqlite-connection-driver.ts";

/**
 * buildInsertChunk builds a chunks insert that returns the new rowid so the
 * projector can pair it with a chunks_vec insert when sqlite-vec is active.
 */
export function buildInsertChunk(insertOptions: {
  quad_id: string;
  subject: string;
  predicate: string;
  graph: string;
  value: string;
  fts_value: string;
}): { sql: string; args: string[] } {
  return {
    sql:
      `INSERT INTO chunks (quad_id, subject, predicate, graph, value, fts_value)
        VALUES (?, ?, ?, ?, ?, ?) RETURNING id`,
    args: [
      insertOptions.quad_id,
      insertOptions.subject,
      insertOptions.predicate,
      insertOptions.graph,
      insertOptions.value,
      insertOptions.fts_value,
    ],
  };
}

/**
 * buildInsertVecChunk inserts one embedding into the vec0 chunks_vec table
 * keyed by the owning chunks rowid.
 *
 * The rowid must be bound as an integer: sqlite-vec rejects non-INTEGER
 * rowid bindings, and Deno's node:sqlite binds JS numbers as REAL — only
 * bigint binds as INTEGER.
 */
export function buildInsertVecChunk(insertOptions: {
  chunkId: number | bigint;
  vectorJson: string;
}): { sql: string; args: (string | bigint)[] } {
  return {
    sql: "INSERT INTO chunks_vec (rowid, embedding) VALUES (?, ?)",
    args: [BigInt(insertOptions.chunkId), insertOptions.vectorJson],
  };
}

/**
 * buildDeleteByQuadIds builds the statements that sweep every chunk (and
 * its vec row) for the given content-addressed quad ids. FTS rows are
 * removed by the chunks_ad trigger. Vec statements are only emitted when
 * the vec0 table exists.
 */
export function buildDeleteByQuadIds(
  quadIds: string[],
  vectorSupported: boolean,
): SqlStatement[] {
  const placeholders = generatePlaceholders(quadIds.length);
  const statements: SqlStatement[] = [];
  if (vectorSupported) {
    statements.push({
      sql:
        `DELETE FROM chunks_vec WHERE rowid IN (SELECT id FROM chunks WHERE quad_id IN (${placeholders}))`,
      args: [...quadIds],
    });
  }
  statements.push({
    sql: `DELETE FROM chunks WHERE quad_id IN (${placeholders})`,
    args: [...quadIds],
  });
  return statements;
}
