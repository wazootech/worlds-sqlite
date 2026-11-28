/** collect runs every bench file in its own process and gathers ops/second. */
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";
import type { BenchResult } from "./bench.ts";

const BENCH_DIRECTORY = fileURLToPath(new URL("../", import.meta.url));

/** benchFiles lists the bench files present in benchmarks/. */
export function benchFiles(): string[] {
  return readdirSync(BENCH_DIRECTORY)
    .filter((name) => name.endsWith(".bench.ts"))
    .sort();
}

/** opsPerSecond maps each bench name to its average operations per second. */
export function opsPerSecond(): Record<string, number> {
  const ops: Record<string, number> = {};
  for (const file of benchFiles()) {
    const run = spawnSync(
      process.execPath,
      [`${BENCH_DIRECTORY}${file}`, "--json"],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    if (run.status !== 0) {
      throw new Error(`${file} failed (exit ${run.status}): ${run.stderr}`);
    }
    const last = run.stdout.trim().split("\n").at(-1) ?? "[]";
    for (const result of JSON.parse(last) as BenchResult[]) {
      if (result.avg > 0) ops[result.name] = 1e9 / result.avg;
    }
  }
  return ops;
}
