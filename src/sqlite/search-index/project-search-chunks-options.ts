import type { TextSplitterInterface } from "@worlds/sdk/search-index/quad-chunker";
import type { EmbeddingService } from "@worlds/sdk/search-index/embedding-service";
import type { QuadFilter } from "@worlds/sdk/quad-store";
import type { SqliteConnectionDriver } from "@/sqlite/sqlite-connection-driver.ts";
import type { SqliteSearchQueryBuilder } from "./sqlite-search-query-builder.ts";

/** ProjectSearchChunksOptions configures search chunk projection. */
export interface ProjectSearchChunksOptions extends QuadFilter {
  /** connection is the SqliteConnectionDriver wrapping the SQLite handle. */
  connection: SqliteConnectionDriver;

  /** textSplitter splits long literal values into chunk rows (required for projection/rebuild). */
  textSplitter?: TextSplitterInterface;

  /** maxLookupChunkSize caps IN-clause widths (default 800). */
  maxLookupChunkSize?: number;

  /** searchQueryBuilder supplies dimension-aware chunk/vec SQL. */
  searchQueryBuilder: SqliteSearchQueryBuilder;

  /** embeddingService optionally projects chunk text into comparison vectors. */
  embeddingService?: EmbeddingService;
}
