import type { SqlCommitDriver, SqlDialect } from "./commit-types.ts";

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
 * most `size`. Each call is atomic; the sequence is not. `onCommitted` is called
 * after each call that succeeded.
 */
export async function writeInBatches<S>(
  driver: SqlCommitDriver<S>,
  statements: readonly S[],
  size: number,
  onCommitted?: () => void,
): Promise<void> {
  const step = Math.max(1, size);
  for (let start = 0; start < statements.length; start += step) {
    await driver.executeBatch(statements.slice(start, start + step));
    onCommitted?.();
  }
}

/**
 * writeCommitStatements writes a commit's statements.
 *
 * Up to `maxAtomicStatements` they go in one `executeBatch`, which commits or
 * rolls back as a whole: no cleanup, no double-failure case, and a replace
 * import keeps its old graph on failure. Above that (or when the limit is 0)
 * they are written in batches of `writeBatchSize`, which is NOT atomic: if a
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
  if (statements.length <= limits.maxAtomicStatements) {
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
