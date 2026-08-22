/**
 * buildChunksTable returns the materialized search chunk table DDL. Vectors
 * are not part of this table: each backend stores embeddings in its own
 * dialect (a vec0 virtual table keyed by `chunks.id`, or a native vector
 * column added by its own migration).
 */
export function buildChunksTable(): string {
  return `CREATE TABLE IF NOT EXISTS chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    quad_id TEXT NOT NULL,
    subject TEXT NOT NULL,
    predicate TEXT NOT NULL,
    graph TEXT NOT NULL,
    value TEXT NOT NULL,
    fts_value TEXT NOT NULL
  )`;
}

/**
 * buildChunksQuadIdIndex returns the chunks quad_id lookup index used by
 * content-addressed deletion sweeps.
 */
export function buildChunksQuadIdIndex(): string {
  return "CREATE INDEX IF NOT EXISTS idx_chunks_quad_id ON chunks (quad_id)";
}

/**
 * buildChunksFtsTable returns the FTS5 virtual table over the chunks content
 * table (external content, keyed by chunks.id).
 */
export function buildChunksFtsTable(): string {
  return `CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
    fts_value,
    content='chunks',
    content_rowid='id'
  )`;
}

/**
 * buildChunksTriggers returns the triggers that keep the external FTS5 index
 * in sync with chunks row inserts and deletes.
 */
export function buildChunksTriggers(): string[] {
  return [
    `CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
      INSERT INTO chunks_fts(rowid, fts_value) VALUES (new.id, new.fts_value);
    END;`,
    `CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
      INSERT INTO chunks_fts(chunks_fts, rowid, fts_value) VALUES('delete', old.id, old.fts_value);
    END;`,
  ];
}
