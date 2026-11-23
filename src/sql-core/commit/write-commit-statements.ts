import type { SqlCommitDriver, SqlDialect } from "./commit-types.ts";
import {
  batchWeighing,
  fitsOneBatch,
  partitionBatches,
} from "./partition-batches.ts";

/** DEFAULT_MAX_ATOMIC_STATEMENTS is the atomic limit the SQLite-family drivers use (10,000, the largest batch they sent before worlds-libsql#66). */
export const DEFAULT_MAX_ATOMIC_STATEMENTS = 10_000;

/** DEFAULT_WRITE_BATCH_SIZE is the statements per batch on the chunked fallback path. */
export const DEFAULT_WRITE_BATCH_SIZE = 500;

/** SqlWriteLimits are the effective limits for one commit. */
export interface SqlWriteLimits {
  maxAtomicStatements: number;
  writeBatchSize: number;
}

/** CommitCleanup identifies the novel quads a failed fallback write must remove again. */
export interface CommitCleanup {
  keys: string[];
  hashes: string[];
}

/**
 * writeInBatches runs `statements` as consecutive `executeBatch` calls of at
 * most `size` statements and, when the driver declares `statementWeight` and
 * `maxBatchWeight`, at most that weight (see `partitionBatches`: a statement
 * heavier than the budget goes alone). Each call is atomic; the sequence is not.
 * `onCommitted` is called after each call that succeeded.
 */
export async function writeInBatches<S>(
  driver: SqlCommitDriver<S>,
  statements: readonly S[],
  size: number,
  onCommitted?: () => void,
): Promise<void> {
  const batches = partitionBatches(statements, size, batchWeighing(driver));
  for (const batch of batches) {
    await driver.executeBatch(batch);
    onCommitted?.();
  }
}

/**
 * writeCommitStatements writes a commit's statements.
 *
 * When they fit in ONE batch under every limit the driver declares (at most
 * `maxAtomicStatements` statements and, if the driver sets `statementWeight`
 * and `maxBatchWeight`, at most that total weight) they go in one
 * `executeBatch`, which commits or rolls back as a whole: no cleanup, no
 * double-failure case, and a replace import keeps its old graph on failure.
 * Otherwise (or when the limit is 0) they are written in batches filled up to
 * `writeBatchSize` statements and the weight budget, which is NOT atomic: if a
 * later batch fails, earlier batches stay committed, so `dialect.buildCleanup`
 * removes the novel quads written so far. That cleanup cannot restore deletions
 * or a replace-import wipe an earlier batch already applied (the graph is left
 * empty). A failure in the first batch wrote nothing and runs no cleanup. If
 * the cleanup also fails, an AggregateError carrying both errors is thrown and
 * the quads and search index may be inconsistent.
 */
export async function writeCommitStatements<S>(
  statements: readonly S[],
  cleanup: CommitCleanup,
  driver: SqlCommitDriver<S>,
  dialect: SqlDialect<S>,
  limits: SqlWriteLimits,
): Promise<void> {
  if (
    statements.length <= limits.maxAtomicStatements &&
    fitsOneBatch(statements, batchWeighing(driver))
  ) {
    await driver.executeBatch(statements);
    return;
  }
  let committed = 0;
  try {
    await writeInBatches(driver, statements, limits.writeBatchSize, () => {
      committed++;
    });
  } catch (failure) {
    if (committed === 0) throw failure;
    try {
      const undo = dialect.buildCleanup(cleanup.keys, cleanup.hashes);
      await writeInBatches(driver, undo, limits.writeBatchSize);
    } catch (cleanupFailure) {
      throw new AggregateError(
        [failure, cleanupFailure],
        "commit failed and cleaning up its partial write also failed; quads and search index may be inconsistent",
      );
    }
    throw failure;
  }
}
