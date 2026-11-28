import { test } from "node:test";
import { assertEquals } from "@std/assert";
import { type BatchWeighing, partitionBatches } from "./partition-batches.ts";

const byValue = (max: number): BatchWeighing<number> => ({
  max,
  weigh: (n) => n,
});

test("partitionBatches without weights splits by count only", () => {
  assertEquals(partitionBatches([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assertEquals(partitionBatches([], 2), []);
  assertEquals(partitionBatches([1, 2], 0), [[1], [2]], "size is at least 1");
});

test("partitionBatches fills each batch up to both limits, in order", () => {
  assertEquals(partitionBatches([3, 3, 3, 3, 3], 10, byValue(7)), [
    [3, 3],
    [3, 3],
    [3],
  ]);
  assertEquals(partitionBatches([1, 1, 1, 1, 1], 2, byValue(100)), [
    [1, 1],
    [1, 1],
    [1],
  ]);
});

test("partitionBatches puts an over-budget item alone and always terminates", () => {
  assertEquals(partitionBatches([1, 9, 1, 1], 10, byValue(5)), [
    [1],
    [9],
    [1, 1],
  ]);
  assertEquals(partitionBatches([9, 9], 10, byValue(5)), [[9], [9]]);
  assertEquals(partitionBatches([1, 1], 10, byValue(0)), [[1], [1]]);
});

test("partitionBatches accepts a batch of exactly the budget", () => {
  assertEquals(partitionBatches([2, 3, 5], 10, byValue(5)), [[2, 3], [5]]);
});
