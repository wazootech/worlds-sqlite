import type { QuadFilter } from "@worlds/sdk/quad-store";
import type { EmbeddingService } from "@worlds/sdk/search-index/embedding-service";
import type { TextSplitterInterface } from "@worlds/sdk/search-index/quad-chunker";
import {
  buildChunkFtsValue,
  type SqlCommitDriver,
  type SqlDialect,
  type SqlProjectionOptions,
} from "@/sql-core/mod.ts";
import type {
  SqliteConnectionDriver,
  SqlStatement,
} from "@/sqlite/sqlite-connection-driver.ts";
import type { SqliteSearchQueryBuilder } from "@/sqlite/search-index/sqlite-search-query-builder.ts";
import type { QuadKey } from "@/sqlite/quad-store/sqlite-quad-query-builder.ts";
import { createSqliteCommitDriver } from "./sqlite-commit-driver.ts";
import { createSqliteCommitDialect } from "./sqlite-commit-dialect.ts";

/** SqliteCommitCoreOptions configures the sqlite side of the shared SQL commit core. */
export interface SqliteCommitCoreOptions extends QuadFilter {
  /** connection is the SqliteConnectionDriver wrapping the SQLite handle. */
  connection: SqliteConnectionDriver;

  /** searchQueryBuilder supplies dimension-aware chunk and vec SQL. */
  searchQueryBuilder: SqliteSearchQueryBuilder;

  /** textSplitter splits literals into chunk rows; without it no chunks are written. */
  textSplitter?: TextSplitterInterface;

  /** embeddingService optionally projects chunk text into vectors (ignored without sqlite-vec). */
  embeddingService?: EmbeddingService;

  /** maxLookupChunkSize caps IN-clause widths (default 800). */
  maxLookupChunkSize?: number;
}

/** SqliteCommit is what `commitSqlPatch` and `rebuildSqlSearchIndex` need from sqlite. */
export interface SqliteCommit {
  driver: SqlCommitDriver<SqlStatement>;
  dialect: SqlDialect<SqlStatement>;
  /** projection is undefined when no textSplitter is configured. */
  projection?: SqlProjectionOptions;
  filter: QuadFilter;
}

/**
 * createSqliteCommit wires the sqlite driver and dialect for one commit (or one
 * rebuild). The two share a key registry, so build a fresh one per call.
 * `onScanned` receives the stored quads each rebuild page read.
 */
export function createSqliteCommit(
  options: SqliteCommitCoreOptions,
  onScanned?: (count: number) => void,
): SqliteCommit {
  const { connection, searchQueryBuilder, textSplitter } = options;
  const keys = new Map<string, QuadKey>();
  const lookupChunkSize = options.maxLookupChunkSize ?? 800;
  const filter = { include: options.include, exclude: options.exclude };
  return {
    driver: createSqliteCommitDriver({
      connection,
      keys,
      lookupChunkSize,
      filter,
      onScanned,
    }),
    dialect: createSqliteCommitDialect({
      searchQueryBuilder,
      keys,
      lookupChunkSize,
    }),
    filter,
    projection: textSplitter && {
      textSplitter,
      // Keyword-only degradation: with no vec0 table there is nowhere to store vectors.
      embeddingService: searchQueryBuilder.vectorSupported
        ? options.embeddingService
        : undefined,
      ftsValueOf: buildChunkFtsValue,
      vectorDimensions: searchQueryBuilder.vectorDimensions,
    },
  };
}
