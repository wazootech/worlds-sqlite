import type { SearchRequest } from "@worlds/sdk";
import {
  buildIncludeExcludeFilterClauses,
  buildKeywordFtsStatement,
  generatePlaceholders,
  sanitizeFtsQuery,
} from "@/sql-core/mod.ts";
import type { ColumnMapping } from "@/sql-core/mod.ts";
import type { SqlStatement } from "@/sqlite/sqlite-connection-driver.ts";

/** CHUNKS_TABLE_COLUMNS maps QuadFilter fields to chunks table column names. */
const CHUNKS_TABLE_COLUMNS: ColumnMapping = {
  subjects: "chunks.subject",
  predicates: "chunks.predicate",
  graphs: "chunks.graph",
};

/**
 * SqliteSearchPlan is the executable plan SqliteSearchIndex consumes. The
 * hybrid mode runs the keyword and vector branches separately and fuses them
 * with JS-side reciprocal rank fusion (per the Layer 2 plan); the single
 * modes execute one branch directly.
 */
export type SqliteSearchPlan =
  | {
    mode: "hybrid";
    keyword: SqlStatement;
    vector: SqlStatement;
    limit: number;
  }
  | { mode: "keyword"; statement: SqlStatement; limit: number }
  | { mode: "vector"; statement: SqlStatement; limit: number }
  | { mode: "none"; limit: number };

/** SqliteSearchQueryBuilderOptions configures vector SQL generation. */
export interface SqliteSearchQueryBuilderOptions {
  /**
   * vectorSupported gates every vec0 statement. When false the builder never
   * references chunks_vec (keyword-only degradation).
   */
  vectorSupported?: boolean;
}

/** Maximum embedding dimensions accepted by SqliteSearchQueryBuilder. */
const SQLITE_QUERY_BUILDER_MAX_VECTOR_DIMENSIONS = 1536;

/**
 * SqliteSearchQueryBuilder emits dimension-aware SQL for the L2 search
 * surface: FTS5 keyword queries over chunks_fts (via the shared sql-core
 * keyword plan), sqlite-vec queries over chunks_vec, and hybrid plans for
 * JS-side RRF fusion. The chunks columns (subject/predicate/graph/value)
 * always ride along so the search index can build SearchResults without a
 * second round-trip.
 */
export class SqliteSearchQueryBuilder {
  public readonly vectorDimensions: number;
  public readonly vectorSupported: boolean;

  public constructor(
    vectorDimensions: number,
    options?: SqliteSearchQueryBuilderOptions,
  ) {
    const dimensions = Math.floor(Number(vectorDimensions));
    if (
      !Number.isFinite(dimensions) ||
      dimensions < 1 ||
      dimensions > SQLITE_QUERY_BUILDER_MAX_VECTOR_DIMENSIONS
    ) {
      throw new Error(
        `vectorDimensions must be a finite integer in [1, ${SQLITE_QUERY_BUILDER_MAX_VECTOR_DIMENSIONS}], received: ${
          String(vectorDimensions)
        }`,
      );
    }
    this.vectorDimensions = dimensions;
    this.vectorSupported = options?.vectorSupported ?? false;
  }

  /** sanitizeFtsQuery exposes the FTS5 query sanitizer for callers and tests. */
  public sanitizeFtsQuery(query: string): string {
    return sanitizeFtsQuery(query);
  }

  /**
   * buildInsertChunk builds a chunks insert that returns the new rowid so the
   * projector can pair it with a chunks_vec insert when sqlite-vec is active.
   */
  public buildInsertChunk(insertOptions: {
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
  public buildInsertVecChunk(insertOptions: {
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
  public buildDeleteByQuadIds(
    quadIds: string[],
  ): SqlStatement[] {
    const placeholders = generatePlaceholders(quadIds.length);
    const statements: SqlStatement[] = [];
    if (this.vectorSupported) {
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

  /**
   * buildSearchQuery returns the executable plan for a search request:
   * hybrid (both branches, JS-side RRF), keyword-only, vector-only, or none
   * (a present query with no searchable tokens and no vector).
   */
  public buildSearchQuery(
    request: SearchRequest,
    searchBuildOptions: { vectorJson?: string; limit: number },
  ): SqliteSearchPlan {
    const { vectorJson, limit } = searchBuildOptions;

    const { whereClauses, filterArgs } = buildIncludeExcludeFilterClauses(
      request,
      CHUNKS_TABLE_COLUMNS,
    );

    const whereFilter = whereClauses.length > 0
      ? `WHERE ${whereClauses.join(" AND ")}`
      : "";

    const hasVector = !!vectorJson && this.vectorSupported;
    const hasQuery = !!request.query && request.query.trim().length > 0;
    const sanitizedQuery = hasQuery ? sanitizeFtsQuery(request.query) : "";
    // A present query with zero searchable tokens (pure punctuation, emoji)
    // must not emit `MATCH ""` — FTS5 crashes on the empty match string.
    const hasKeyword = sanitizedQuery.length > 0;

    if (hasVector && hasKeyword) {
      return {
        mode: "hybrid",
        keyword: buildKeywordFtsStatement({
          sanitizedQuery,
          limit,
          whereFilter,
          filterArgs,
        }),
        vector: this.buildVectorStatement(
          vectorJson,
          limit,
          whereFilter,
          filterArgs,
        ),
        limit,
      };
    }

    if (hasVector) {
      return {
        mode: "vector",
        statement: this.buildVectorStatement(
          vectorJson,
          limit,
          whereFilter,
          filterArgs,
        ),
        limit,
      };
    }

    if (hasKeyword) {
      return {
        mode: "keyword",
        statement: buildKeywordFtsStatement({
          sanitizedQuery,
          limit,
          whereFilter,
          filterArgs,
        }),
        limit,
      };
    }

    return { mode: "none", limit };
  }

  private buildVectorStatement(
    vectorJson: string,
    limit: number,
    whereFilter: string,
    filterArgs: string[],
  ): SqlStatement {
    const args: (string | number)[] = [
      vectorJson,
      limit,
      ...filterArgs,
      limit,
    ];

    const sql = `
      WITH vec_matches AS (
        SELECT
          rowid,
          row_number() OVER (ORDER BY distance) AS rank_number
        FROM
          chunks_vec
        WHERE
          embedding MATCH ? AND k = ?
      ), final AS (
        SELECT
          chunks.id AS chunk_id,
          chunks.subject,
          chunks.predicate,
          chunks.graph,
          chunks.value,
          COALESCE(1.0 / (60 + vec_matches.rank_number), 0.0) AS combined_rank
        FROM
          vec_matches
          JOIN chunks ON chunks.id = vec_matches.rowid
        ${whereFilter}
        ORDER BY
          combined_rank DESC
        LIMIT ?
      )
      SELECT * FROM final;
    `;
    return { sql, args };
  }
}
