import { filterQuads, hashQuads } from "@worlds/sdk/quad-store";
import type { QuadFilter } from "@worlds/sdk/quad-store";
import { chunkAndEmbedQuads } from "@worlds/sdk/search-index/quad-chunker";
import type {
  SqlCommitDriver,
  SqlDialect,
  SqlProjectionOptions,
} from "./commit-types.ts";
import {
  DEFAULT_WRITE_BATCH_SIZE,
  writeInBatches,
} from "./write-commit-statements.ts";

/** DEFAULT_REBUILD_PAGE_SIZE is the quads per page of a full rebuild. */
export const DEFAULT_REBUILD_PAGE_SIZE = 500;

/** SqlRebuildOptions tunes one rebuild. Every field is optional. */
export interface SqlRebuildOptions {
  /** pageSize is the quads read per page (default 500). */
  pageSize?: number;

  /** writeBatchSize is the statements per `executeBatch` call (default: the driver's). */
  writeBatchSize?: number;

  /**
   * scope limits the rebuild to the quads an include/exclude filter matches. A
   * scoped rebuild clears nothing: it replaces only the chunk rows of the
   * in-scope quads (via `dialect.buildDeleteChunks`) and leaves every other row
   * alone. A scope with no criteria is not a scope: the rebuild clears all.
   */
  scope?: QuadFilter;
}

/** SqlRebuildResult reports what a rebuild did. */
export interface SqlRebuildResult {
  /** processedQuadCount is how many stored quads the rebuild scanned, in scope or not. */
  processedQuadCount: number;

  /** chunkRowCount is how many chunk rows it wrote. */
  chunkRowCount: number;
}

/** hasCriteria is true when one side of a QuadFilter names anything to match. */
function hasCriteria(side: QuadFilter["include"]): boolean {
  return side !== undefined && Object.values(side).some((v) => v?.length);
}

/**
 * rebuildSqlSearchIndexWithCounts rebuilds chunk rows from the stored quads: it
 * pages them with `driver.streamQuads`, chunks and embeds each page before
 * writing it, and reports the quads scanned and chunk rows written. Each
 * `executeBatch` call is atomic, but the rebuild as a whole is not: a failure on
 * a later page leaves the earlier pages indexed, and running it again repairs it.
 *
 * Unscoped, it clears every old chunk row just before the first write (so an
 * embedding failure on the first page changes nothing), which also drops rows of
 * quads that no longer exist. With `options.scope` it clears nothing and, per
 * page, replaces only the rows of the in-scope quads: a scoped rebuild never
 * touches rows outside its scope. It needs `dialect.buildDeleteChunks`.
 */
export async function rebuildSqlSearchIndexWithCounts<S>(
  driver: SqlCommitDriver<S>,
  dialect: SqlDialect<S>,
  projection: SqlProjectionOptions,
  options: SqlRebuildOptions = {},
): Promise<SqlRebuildResult> {
  const { scope } = options;
  const scoped = scope !== undefined &&
    (hasCriteria(scope.include) || hasCriteria(scope.exclude));
  if (scoped && !dialect.buildDeleteChunks) {
    throw new Error(
      "a scoped rebuild needs dialect.buildDeleteChunks to replace rows by quad",
    );
  }
  const inScope = scoped ? filterQuads(scope) : () => true;
  const pageSize = Math.max(1, options.pageSize ?? DEFAULT_REBUILD_PAGE_SIZE);
  const batchSize = options.writeBatchSize ?? driver.writeBatchSize ??
    DEFAULT_WRITE_BATCH_SIZE;
  const result = { processedQuadCount: 0, chunkRowCount: 0 };
  let after: unknown;
  let cleared = false;
  for (;;) {
    const page = await driver.streamQuads({ after, pageSize });
    result.processedQuadCount += page.quads.length;
    const quads = page.quads.filter(inScope);
    if (quads.length > 0) {
      const hashes = hashQuads(quads);
      const { rows } = await chunkAndEmbedQuads(quads, hashes, projection);
      const prefix = scoped
        ? dialect.buildDeleteChunks!(hashes)
        : cleared
        ? []
        : dialect.buildClearChunks();
      cleared = true;
      await writeInBatches(
        driver,
        [...prefix, ...dialect.buildChunkRows(rows)],
        batchSize,
      );
      result.chunkRowCount += rows.length;
    }
    if (page.next === undefined) break;
    after = page.next;
  }
  if (!cleared && !scoped) {
    await driver.executeBatch(dialect.buildClearChunks());
  }
  return result;
}

/**
 * rebuildSqlSearchIndex is `rebuildSqlSearchIndexWithCounts` for callers that
 * only need the number of chunk rows written.
 */
export async function rebuildSqlSearchIndex<S>(
  driver: SqlCommitDriver<S>,
  dialect: SqlDialect<S>,
  projection: SqlProjectionOptions,
  options: SqlRebuildOptions = {},
): Promise<number> {
  const result = await rebuildSqlSearchIndexWithCounts(
    driver,
    dialect,
    projection,
    options,
  );
  return result.chunkRowCount;
}
