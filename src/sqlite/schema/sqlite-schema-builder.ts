/** Maximum embedding dimensions accepted by SqliteSchemaBuilder (resource guardrail). */
const SQLITE_SCHEMA_BUILDER_MAX_VECTOR_DIMENSIONS = 1536;

/** SqliteSchemaBuilderOptions configures schema DDL generation. */
export interface SqliteSchemaBuilderOptions {
  /**
   * vectorSupported enables the sqlite-vec `chunks_vec` vec0 virtual table.
   * When false (sqlite-vec could not be loaded), the schema stays
   * keyword-only and no vec SQL is ever emitted.
   */
  vectorSupported?: boolean;
}

/**
 * SqliteSchemaBuilder exposes DDL helpers for the L2 search surface over the
 * existing L1 quad table.
 *
 * The `quads` DDL mirrors the L1 `SqliteStore` table exactly (term-keyed rows
 * with a lossless JSON payload) so the store's RDF/JS read path remains the
 * single source of truth; `chunks`/`chunks_fts`/`chunks_vec` are the new
 * materialized search tables. sqlite-vec lives in a `vec0` virtual table
 * keyed by `chunks.id` (sqlite-vec has no F32_BLOB column type like
 * libsql_vector's `vector32`), and RRF fusion is JS-side per the Layer 2 plan.
 */
export class SqliteSchemaBuilder {
  public readonly vectorDimensions: number;
  public readonly vectorSupported: boolean;

  public constructor(
    vectorDimensions: number,
    options?: SqliteSchemaBuilderOptions,
  ) {
    const dimensions = Math.floor(Number(vectorDimensions));
    if (
      !Number.isFinite(dimensions) ||
      dimensions < 1 ||
      dimensions > SQLITE_SCHEMA_BUILDER_MAX_VECTOR_DIMENSIONS
    ) {
      throw new Error(
        `vectorDimensions must be a finite integer in [1, ${SQLITE_SCHEMA_BUILDER_MAX_VECTOR_DIMENSIONS}], received: ${
          String(vectorDimensions)
        }`,
      );
    }
    this.vectorDimensions = dimensions;
    this.vectorSupported = options?.vectorSupported ?? false;
  }

  /**
   * buildTables returns the idempotent DDL that creates the quads and chunks
   * tables (plus the vec0 table when sqlite-vec is available) in dependency
   * order.
   */
  public buildTables(): string[] {
    const tables = [
      this.buildSqliteQuadsTable(),
      this.buildSqliteChunksTable(),
    ];
    if (this.vectorSupported) {
      tables.push(this.buildSqliteChunksVecTable());
    }
    return tables;
  }

  /**
   * buildIndexes returns DDL for the covering indexes the L1 store relies on
   * (term-keyed equality seeks) plus the chunks quad_id index used by
   * deletion sweeps.
   */
  public buildIndexes(): string[] {
    return [
      "CREATE INDEX IF NOT EXISTS idx_quads_pkey ON quads (pkey)",
      "CREATE INDEX IF NOT EXISTS idx_quads_okey ON quads (okey)",
      "CREATE INDEX IF NOT EXISTS idx_quads_gkey ON quads (gkey)",
      this.buildSqliteChunksQuadIdIndex(),
    ];
  }

  /**
   * buildSqliteQuadsTable returns the L1 SqliteStore quad table DDL (same
   * shape as the store's constructor so both layers share one table).
   */
  public buildSqliteQuadsTable(): string {
    return `CREATE TABLE IF NOT EXISTS quads (
    skey TEXT NOT NULL,
    pkey TEXT NOT NULL,
    okey TEXT NOT NULL,
    gkey TEXT NOT NULL,
    payload TEXT NOT NULL,
    PRIMARY KEY (skey, pkey, okey, gkey)
  ) STRICT`;
  }

  /**
   * buildSqliteChunksTable returns the materialized search chunk table.
   * Vectors are stored in the vec0 `chunks_vec` table keyed by `chunks.id`
   * (sqlite-vec stores embeddings in its own virtual table).
   */
  public buildSqliteChunksTable(): string {
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
   * buildSqliteChunksQuadIdIndex returns the chunks quad_id lookup index used
   * by content-addressed deletion sweeps.
   */
  public buildSqliteChunksQuadIdIndex(): string {
    return "CREATE INDEX IF NOT EXISTS idx_chunks_quad_id ON chunks (quad_id)";
  }

  /**
   * buildSqliteChunksFtsTable returns the FTS5 virtual table over the chunks
   * content table (external content, keyed by chunks.id).
   */
  public buildSqliteChunksFtsTable(): string {
    return `CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
    fts_value,
    content='chunks',
    content_rowid='id'
  )`;
  }

  /**
   * buildSqliteChunksTriggers returns the triggers that keep the external
   * FTS5 index in sync with chunks row inserts and deletes.
   */
  public buildSqliteChunksTriggers(): string[] {
    return [
      `CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
      INSERT INTO chunks_fts(rowid, fts_value) VALUES (new.id, new.fts_value);
    END;`,
      `CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
      INSERT INTO chunks_fts(chunks_fts, rowid, fts_value) VALUES('delete', old.id, old.fts_value);
    END;`,
    ];
  }

  /**
   * buildSqliteChunksVecTable returns the sqlite-vec vec0 virtual table for
   * vector search. Only emitted when the extension is available.
   */
  public buildSqliteChunksVecTable(): string {
    return `CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec USING vec0(
    embedding float[${this.vectorDimensions}]
  )`;
  }
}
