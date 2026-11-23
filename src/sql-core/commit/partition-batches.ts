import type { SqlCommitDriver } from "./commit-types.ts";

/** BatchWeighing is a driver's active weight limit: the estimator and the budget. */
export interface BatchWeighing<S> {
  /** weigh is the estimated weight of one statement, never negative. */
  weigh(statement: S): number;
  /** max is the weight budget of one batch. */
  max: number;
}

/**
 * batchWeighing returns the driver's weight limit, or undefined when it has
 * none. Weighing needs both `statementWeight` and `maxBatchWeight`; a driver
 * that declares only one of them is treated as unweighted.
 */
export function batchWeighing<S>(
  driver: SqlCommitDriver<S>,
): BatchWeighing<S> | undefined {
  const max = driver.maxBatchWeight;
  const estimate = driver.statementWeight;
  if (estimate === undefined || max === undefined || !(max >= 0)) {
    return undefined;
  }
  return {
    max,
    weigh: (statement) => {
      const weight = estimate.call(driver, statement);
      return weight > 0 ? weight : 0;
    },
  };
}

/**
 * fitsOneBatch is true when `statements` fit in a single batch under the
 * weight budget (always true without a weight limit). The count limit is the
 * caller's.
 */
export function fitsOneBatch<S>(
  statements: readonly S[],
  weighing: BatchWeighing<S> | undefined,
): boolean {
  if (!weighing) return true;
  let total = 0;
  for (const statement of statements) {
    total += weighing.weigh(statement);
    if (total > weighing.max) return false;
  }
  return true;
}

/**
 * partitionBatches splits `statements`, in order, into consecutive batches of
 * at most `size` statements and, with a weight limit, at most `weighing.max`
 * total weight. Each batch is filled greedily. A statement heavier than the
 * budget cannot be split, so it goes alone in its own batch (and the driver
 * decides whether to accept it) instead of stalling the split.
 */
export function partitionBatches<S>(
  statements: readonly S[],
  size: number,
  weighing?: BatchWeighing<S>,
): S[][] {
  const step = Math.max(1, size);
  const batches: S[][] = [];
  let current: S[] = [];
  let weight = 0;
  for (const statement of statements) {
    const w = weighing ? weighing.weigh(statement) : 0;
    const full = current.length >= step ||
      (weighing !== undefined && weight + w > weighing.max);
    if (current.length > 0 && full) {
      batches.push(current);
      current = [];
      weight = 0;
    }
    current.push(statement);
    weight += w;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}
