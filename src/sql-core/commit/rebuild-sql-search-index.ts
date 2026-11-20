import { hashQuads } from "@worlds/sdk/quad-store";
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

/**
 * rebuildSqlSearchIndex rebuilds every chunk row from the stored quads: it pages
 * them with `driver.streamQuads`, chunks and embeds each page before writing it,
 * and clears the old chunk rows just before the first write (so an embedding
 * failure on the first page changes nothing). Each `executeBatch` call is
 * atomic, but the rebuild as a whole is not: a failure on a later page leaves
 * the earlier pages indexed, and running the rebuild again repairs it. It
 * returns the number of chunk rows written.
 */
export async function rebuildSqlSearchIndex<S>(
  driver: SqlCommitDriver<S>,
  dialect: SqlDialect<S>,
  projection: SqlProjectionOptions,
  options: { pageSize?: number; writeBatchSize?: number } = {},
): Promise<number> {
  const pageSize = Math.max(1, options.pageSize ?? DEFAULT_REBUILD_PAGE_SIZE);
  const batchSize = options.writeBatchSize ?? driver.writeBatchSize ??
    DEFAULT_WRITE_BATCH_SIZE;
  let after: unknown;
  let cleared = false;
  let written = 0;
  for (;;) {
    const page = await driver.streamQuads({ after, pageSize });
    if (page.quads.length > 0) {
      const { rows } = await chunkAndEmbedQuads(
        page.quads,
        hashQuads(page.quads),
        projection,
      );
      const statements = cleared
        ? dialect.buildChunkRows(rows)
        : [...dialect.buildClearChunks(), ...dialect.buildChunkRows(rows)];
      cleared = true;
      await writeInBatches(driver, statements, batchSize);
      written += rows.length;
    }
    if (page.next === undefined) break;
    after = page.next;
  }
  if (!cleared) await driver.executeBatch(dialect.buildClearChunks());
  return written;
}
