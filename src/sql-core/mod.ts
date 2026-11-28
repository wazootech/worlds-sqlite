/**
 * @worlds/sqlite/sql-core is the driver-free SQL plan layer shared across the
 * SQLite-family durable backends (node:sqlite today, LibSQL/Turso via
 * `@worlds/libsql`, D1 later). Everything here emits inert `{sql, args}`
 * plans or pure text helpers — no database driver, no connection, no I/O.
 * The purity guardrail is enforced by `bun run sql-core:purity`.
 *
 * Non-goals: quad storage layout (term-key hexastore vs column-per-position
 * rows) and vector search dialect (vec0 vs native libsql vectors) stay in
 * their respective backend packages by design.
 */

export {
  buildChunksFtsTable,
  buildChunksQuadIdIndex,
  buildChunksTable,
  buildChunksTriggers,
} from "./chunk-schema.ts";
export { buildChunkFtsValue } from "./fts-value.ts";
export { FTS_STOPWORDS, sanitizeFtsQuery } from "./fts-sanitize.ts";
export {
  buildIncludeExcludeFilterClauses,
  buildKeywordFtsStatement,
  generatePlaceholders,
  RRF_FUSION_K,
} from "./keyword-fts-plan.ts";
export type {
  BuildKeywordFtsStatementOptions,
  ColumnMapping,
} from "./keyword-fts-plan.ts";
export { buildSearchResultId } from "./search-result-id.ts";
export type { BuildSearchResultIdOptions } from "./search-result-id.ts";
export type { SqlBindValue, SqlStatement } from "./sql-statement.ts";
export { commitSqlPatch } from "./commit/commit-sql-patch.ts";
export {
  DEFAULT_REBUILD_PAGE_SIZE,
  rebuildSqlSearchIndex,
  rebuildSqlSearchIndexWithCounts,
} from "./commit/rebuild-sql-search-index.ts";
export type {
  SqlRebuildOptions,
  SqlRebuildResult,
} from "./commit/rebuild-sql-search-index.ts";
export {
  DEFAULT_MAX_ATOMIC_STATEMENTS,
  DEFAULT_WRITE_BATCH_SIZE,
  writeCommitStatements,
  writeInBatches,
} from "./commit/write-commit-statements.ts";
export type {
  CommitCleanup,
  SqlWriteLimits,
} from "./commit/write-commit-statements.ts";
export type {
  SqlCommitDriver,
  SqlCommitOptions,
  SqlCommitSummary,
  SqlDialect,
  SqlProjectionOptions,
  SqlQuadPage,
} from "./commit/commit-types.ts";
