import type {
  ReindexRequest,
  ReindexResponse,
  SearchIndexInterface,
  SearchRequest,
  SearchResponse,
  SearchResult,
} from "@worlds/sdk/search-index";
import { buildSearchResultId } from "@/sql-core/mod.ts";
import type { SqliteConnectionDriver } from "@/sqlite/sqlite-connection-driver.ts";
import type { SqliteSearchQueryBuilder } from "./sqlite-search-query-builder.ts";
import type { SqliteSearchPlan } from "./sqlite-search-query-builder.ts";
import { rebuildSqliteSearchIndexFromQuads } from "./rebuild-sqlite-search-index-from-quads.ts";
import type { ProjectSearchChunksOptions } from "./project-search-chunks.ts";

/**
 * SearchRequestWithProfile extends SearchRequest with memory profile
 * overrides for topK and minScore. These fields will be added to the upstream
 * SearchRequest interface in a future release.
 */
interface SearchRequestWithProfile extends SearchRequest {
  topK?: number;
  minScore?: number;
}

/** SqliteSearchIndexOptions configures the sqlite search engine. */
export interface SqliteSearchIndexOptions extends ProjectSearchChunksOptions {
  /** connection is the SqliteConnectionDriver wrapping the SQLite handle. */
  connection: SqliteConnectionDriver;

  /** searchQueryBuilder must match the schema and commit path used when materializing chunk vectors. */
  searchQueryBuilder: SqliteSearchQueryBuilder;

  /** limit establishes optional page sizing constraints for search result sets, defaulting to 100. */
  limit?: number;
}

/** SearchRow is one result row returned by the keyword/vector SQL branches. */
interface SearchRow {
  chunk_id: unknown;
  subject: unknown;
  predicate: unknown;
  graph: unknown;
  value: unknown;
  combined_rank: unknown;
}

/**
 * SqliteSearchIndex implements the query pathway of the L2 search surface:
 * FTS5 keyword search, sqlite-vec vector search, and a hybrid mode that runs
 * both branches and fuses them with JS-side reciprocal rank fusion (the
 * sqlite-vec counterpart of libsql's SQL-side RRF).
 *
 * Keyword-only degradation is layered: an embedding-service failure falls back
 * to FTS5 keyword search (like the libsql reference), and a missing sqlite-vec
 * extension disables the vector branch entirely (no vec0 SQL is ever emitted).
 */
export class SqliteSearchIndex implements SearchIndexInterface {
  public constructor(
    private readonly options: SqliteSearchIndexOptions,
  ) {}

  /**
   * search executes a keyword and vector hybrid query against the current
   * index.
   */
  public async search(request: SearchRequest): Promise<SearchResponse> {
    const profileRequest = request as SearchRequestWithProfile;
    let vectorJson: string | undefined;

    if (
      this.options.embeddingService &&
      this.options.connection.hasVectorSupport()
    ) {
      try {
        const [vector] = await this.options.embeddingService.embed([
          request.query,
        ]);
        const embeddingLength = vector.length;
        if (
          embeddingLength !== this.options.searchQueryBuilder.vectorDimensions
        ) {
          throw new Error(
            `query embedding length ${embeddingLength} does not match vectorDimensions ${this.options.searchQueryBuilder.vectorDimensions}`,
          );
        }
        vectorJson = JSON.stringify(Array.from(vector));
      } catch (error) {
        // Gracefully degrade to keyword-only search if the embedding service fails.
        console.warn(
          `[Search Warning] Embedding service failure. Degrading to keyword-only search fallback. Reason: ${
            (error as Error).message
          }`,
        );
      }
    }

    const searchLimit = profileRequest.topK ?? this.options.limit ?? 100;

    const plan = this.options.searchQueryBuilder.buildSearchQuery(request, {
      vectorJson,
      limit: searchLimit,
    });

    const rows = await this.executePlan(plan);
    const minScore = profileRequest.minScore ?? 0;
    const results: SearchResult[] = [];

    for (const row of rows) {
      const score = Number(row.combined_rank);
      if (score < minScore) continue;

      const searchResultBase = {
        subject: String(row.subject),
        predicate: String(row.predicate),
        graph: String(row.graph),
        text: String(row.value),
      };
      results.push({
        id: await buildSearchResultId(searchResultBase),
        ...searchResultBase,
        score,
      });
    }

    return { results };
  }

  /**
   * reindex rebuilds FTS/vector chunk rows from durable quads without
   * re-importing graph data.
   */
  public async reindex(
    request?: ReindexRequest,
  ): Promise<ReindexResponse> {
    const textSplitter = this.options.textSplitter;
    if (!textSplitter) {
      throw new Error(
        "SqliteSearchIndex reindex requires textSplitter in SqliteSearchIndexOptions",
      );
    }

    const include = request?.include ?? this.options.include;
    const exclude = request?.exclude ?? this.options.exclude;

    return await rebuildSqliteSearchIndexFromQuads({
      ...this.options,
      textSplitter,
      include,
      exclude,
      readPageSize: request?.readPageSize,
    });
  }

  private async executePlan(plan: SqliteSearchPlan): Promise<SearchRow[]> {
    switch (plan.mode) {
      case "none":
        return [];
      case "keyword":
      case "vector":
        return (await this.options.connection.execute(plan.statement))
          .rows as unknown as SearchRow[];
      case "hybrid": {
        const keywordRows = (await this.options.connection.execute(
          plan.keyword,
        )).rows as unknown as SearchRow[];
        const vectorRows = (await this.options.connection.execute(
          plan.vector,
        )).rows as unknown as SearchRow[];

        // JS-side reciprocal rank fusion: each row carries its single-branch
        // RRF contribution (1 / (60 + rank)); overlapping chunk ids sum both.
        const fused = new Map<number, SearchRow>();
        for (const row of keywordRows) {
          const chunkId = Number(row.chunk_id);
          fused.set(chunkId, { ...row, combined_rank: row.combined_rank });
        }
        for (const row of vectorRows) {
          const chunkId = Number(row.chunk_id);
          const existing = fused.get(chunkId);
          if (existing) {
            existing.combined_rank = Number(existing.combined_rank) +
              Number(row.combined_rank);
          } else {
            fused.set(chunkId, { ...row, combined_rank: row.combined_rank });
          }
        }

        return [...fused.values()]
          .sort((a, b) => {
            const scoreDelta = Number(b.combined_rank) -
              Number(a.combined_rank);
            if (scoreDelta !== 0) return scoreDelta;
            return String(a.subject).localeCompare(String(b.subject));
          })
          .slice(0, plan.limit);
      }
    }
  }
}
