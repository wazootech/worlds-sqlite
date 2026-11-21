import type { Patch, TransactionContext } from "@worlds/sdk/quad-store";
import {
  isReplaceImportCommit,
  preparePatch,
  selectNovelQuads,
} from "@worlds/sdk/quad-store";
import { planSearchIndexing } from "@worlds/sdk/search-index";
import {
  chunkAndEmbedQuads,
  type EmbeddedChunk,
} from "@worlds/sdk/search-index/quad-chunker";
import type {
  SqlCommitDriver,
  SqlCommitOptions,
  SqlCommitSummary,
  SqlDialect,
} from "./commit-types.ts";
import { rebuildSqlSearchIndex } from "./rebuild-sql-search-index.ts";
import {
  type SqlWriteLimits,
  writeCommitStatements,
} from "./write-commit-statements.ts";

/** limitsFor lowers the driver's limits with the per-commit options; options can never raise them. */
function limitsFor<S>(
  driver: SqlCommitDriver<S>,
  options: SqlCommitOptions,
): SqlWriteLimits {
  const atomic = driver.maxAtomicStatements;
  const batch = driver.writeBatchSize;
  return {
    maxAtomicStatements: Math.min(
      options.maxAtomicStatements ?? atomic,
      atomic,
    ),
    writeBatchSize: Math.max(
      1,
      Math.min(options.writeBatchSize ?? batch, batch),
    ),
  };
}

/**
 * commitSqlPatch is the one commit sequence every SQL backend runs:
 *
 * 1. `preparePatch`: filter and hash (a failure here touches nothing).
 * 2. `selectNovelQuads` with `driver.lookupExisting` and `dialect.keyOf`.
 * 3. `planSearchIndexing`: project chunks in this commit, rebuild after it, or neither.
 * 4. `chunkAndEmbedQuads` for the novel quads, before any write: an embedding
 *    failure always throws and writes nothing.
 * 5. One statement list: replace-import wipe, deletions, clean-slate deletes and
 *    inserts for the novel quads, chunk rows.
 * 6. `writeCommitStatements`: one atomic batch, or chunked batches with cleanup
 *    (see its contract).
 * 7. `afterWrite`, then a full rebuild if the plan asked for one.
 */
export async function commitSqlPatch<S>(
  patch: Patch,
  context: TransactionContext | undefined,
  driver: SqlCommitDriver<S>,
  dialect: SqlDialect<S>,
  options: SqlCommitOptions = {},
): Promise<SqlCommitSummary> {
  const replacing = isReplaceImportCommit(context);
  const prepared = preparePatch(patch, options.filter);
  const { novelInsertions, novelQuadIds } = await selectNovelQuads(prepared, {
    replacing,
    keyOf: (quad, hash) => dialect.keyOf(quad, hash),
    lookupExisting: (keys) => driver.lookupExisting(keys),
  });
  const plan = planSearchIndexing(options.searchIndexOnImport, context, {
    defaultMode: options.defaultSearchIndexOnImport,
  });

  let rows: EmbeddedChunk[] = [];
  if (
    novelQuadIds.length > 0 && plan.projectDuringCommit && options.projection
  ) {
    ({ rows } = await chunkAndEmbedQuads(
      novelInsertions,
      novelQuadIds,
      options.projection,
    ));
  }

  const novelKeys = novelInsertions.map((q, i) =>
    dialect.keyOf(q, novelQuadIds[i]!)
  );
  const deletionKeys = prepared.deletions.map((q, i) =>
    dialect.keyOf(q, prepared.deletionIds[i]!)
  );
  const statements: S[] = [
    ...(replacing ? dialect.buildWipe() : []),
    ...(deletionKeys.length
      ? dialect.buildDeletions(deletionKeys, prepared.deletionIds)
      : []),
    ...(novelKeys.length
      ? [
        ...dialect.buildDeletions(novelKeys, novelQuadIds),
        ...dialect.buildInserts(novelInsertions, novelKeys, novelQuadIds),
        ...(rows.length ? dialect.buildChunkRows(rows) : []),
      ]
      : []),
  ];
  const limits = limitsFor(driver, options);
  if (statements.length > 0) {
    await writeCommitStatements(
      statements,
      { keys: novelKeys, hashes: novelQuadIds },
      driver,
      dialect,
      limits,
    );
  }

  const summary: SqlCommitSummary = {
    novelQuads: novelKeys.length,
    chunkRows: rows.length,
    rebuilt: false,
  };
  await options.afterWrite?.(summary);
  if (plan.reindexAfterCommit && options.projection) {
    await rebuildSqlSearchIndex(driver, dialect, options.projection, {
      pageSize: options.rebuildPageSize,
      writeBatchSize: limits.writeBatchSize,
    });
    summary.rebuilt = true;
  }
  return summary;
}
