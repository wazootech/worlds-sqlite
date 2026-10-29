import type { SearchRequest } from "@worlds/sdk";
import {
  buildIncludeExcludeFilterClauses,
  buildKeywordFtsStatement,
  sanitizeFtsQuery,
} from "@/sql-core/mod.ts";
import type { ColumnMapping } from "@/sql-core/mod.ts";
import type { SqlStatement } from "@/sqlite/sqlite-connection-driver.ts";
import type {
  SqliteSearchPlan,
  SqliteSearchQueryBuilderOptions,
} from "./sqlite-search-plan.ts";
import {
  buildDeleteByQuadIds,
  buildInsertChunk,
  buildInsertVecChunk,
} from "./sqlite-chunk-write-sql.ts";
import { buildVectorStatement } from "./sqlite-search-vector-sql.ts";

export type {
  SqliteSearchPlan,
  SqliteSearchQueryBuilderOptions,
} from "./sqlite-search-plan.ts";

/** CHUNKS_TABLE_COLUMNS maps QuadFilter fields to chunks table column names. */
const CHUNKS_TABLE_COLUMNS: ColumnMapping = {
  subjects: "chunks.subject",
  predicates: "chunks.predicate",
  graphs: "chunks.graph",
};

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
  public buildInsertChunk(
    insertOptions: Parameters<typeof buildInsertChunk>[0],
  ): { sql: string; args: string[] } {
    return buildInsertChunk(insertOptions);
  }

  /** buildInsertVecChunk inserts one embedding into chunks_vec by rowid. */
  public buildInsertVecChunk(
    insertOptions: Parameters<typeof buildInsertVecChunk>[0],
  ): { sql: string; args: (string | bigint)[] } {
    return buildInsertVecChunk(insertOptions);
  }

  /** buildDeleteByQuadIds builds the chunk (and vec row) sweep statements. */
  public buildDeleteByQuadIds(quadIds: string[]): SqlStatement[] {
    return buildDeleteByQuadIds(quadIds, this.vectorSupported);
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
        vector: buildVectorStatement(
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
        statement: buildVectorStatement(
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
}
