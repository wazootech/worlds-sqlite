import type { Patch, TransactionContext } from "@worlds/sdk/quad-store";
import { prepareCommit } from "@worlds/sdk/search-index";
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
 * 1. `prepareCommit` from `@worlds/sdk`, entirely before any write: filter and
 *    hash, plan (project chunks in this commit, rebuild after it, or neither),
 *    select the novel quads with `driver.lookupExisting` and `dialect.keyOf`,
 *    then chunk and embed them. An embedding failure always throws and writes
 *    nothing.
 * 2. One statement list: replace-import wipe, deletions, clean-slate deletes and
 *    inserts for the novel quads, chunk rows.
 * 3. `writeCommitStatements`: one atomic batch, or chunked batches with cleanup
 *    (see its contract).
 * 4. `afterWrite`, then a full rebuild if the plan asked for one.
 */
export async function commitSqlPatch<S>(
  patch: Patch,
  context: TransactionContext | undefined,
  driver: SqlCommitDriver<S>,
  dialect: SqlDialect<S>,
  options: SqlCommitOptions = {},
): Promise<SqlCommitSummary> {
  const { prepared, plan, novel, rows, replacing } = await prepareCommit(
    patch,
    {
      ...options.filter,
      context,
      searchIndexOnImport: options.searchIndexOnImport,
      defaultMode: options.defaultSearchIndexOnImport,
      keyOf: (quad, hash) => dialect.keyOf(quad, hash),
      lookupExisting: (keys) => driver.lookupExisting(keys),
      projection: options.projection,
    },
  );
  const { novelInsertions, novelQuadIds } = novel;

  const novelKeys = novelInsertions.map((q, i) =>
    dialect.keyOf(q, novelQuadIds[i]!),
  );
  const deletionKeys = prepared.deletions.map((q, i) =>
    dialect.keyOf(q, prepared.deletionIds[i]!),
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
