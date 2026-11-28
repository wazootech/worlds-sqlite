/**
 * bench:check — the L3 gate per the shared parity/benchmark definition
 * (wazootech/workspace#72):
 *
 *   1. FAILS if any of the six canonical bench groups is missing from
 *      benchmarks/ (the libsql mirror: hybrid-search, idempotency-guard,
 *      index-maintenance, sparql-perf, sparql-perf-large, synchronization).
 *   2. FAILS if any bench regresses >=50% vs the committed baseline
 *      (benchmarks/baseline.json) — throughput drops to <=50% of recorded
 *      ops/sec.
 *   3. FAILS if a bench in the baseline was not measured (renamed or dropped),
 *      so it cannot leave the gate unnoticed.
 *   4. New benches absent from the baseline are reported as "baseline
 *      pending" and do not fail the gate.
 *
 * Re-record the baseline with: bun run bench:record
 */

import { readFile } from "node:fs/promises";
import process from "node:process";
import { benchFiles, opsPerSecond } from "./shared/collect.ts";

const CANONICAL_BENCH_FILES = [
  "hybrid-search.bench.ts",
  "idempotency-guard.bench.ts",
  "index-maintenance.bench.ts",
  "sparql-perf-sqlite.bench.ts",
  "sparql-perf-large-sqlite.bench.ts",
  "synchronization.bench.ts",
] as const;

const BASELINE_PATH = new URL("./baseline.json", import.meta.url);

const results = opsPerSecond();

// 1. Missing-group check.
const presentFiles = new Set(benchFiles());
const missing = CANONICAL_BENCH_FILES.filter((f) => !presentFiles.has(f));

let failures = 0;
if (missing.length > 0) {
  failures += missing.length;
  console.error(
    `MISSING BENCH GROUP(S) (${missing.length}/6): ${missing.join(", ")}`,
  );
} else {
  console.log("All 6 canonical bench groups present.");
}

// 2. Regression check vs the committed baseline.
let baseline: Record<string, number> = {};
try {
  baseline = JSON.parse(await readFile(BASELINE_PATH, "utf8")) as Record<
    string,
    number
  >;
} catch {
  console.warn(
    "No committed baseline found (benchmarks/baseline.json). Run `bun run bench:record`. Skipping regression gate.",
  );
}

let regressions = 0;
const newBenches: string[] = [];
for (const [name, current] of Object.entries(results)) {
  const recorded = baseline[name];
  if (recorded === undefined) {
    newBenches.push(name);
    continue;
  }
  const ratio = current / recorded;
  if (ratio < 0.5) {
    regressions++;
    console.error(
      `❌ ${name}: ${current.toFixed(0)} ops/s vs baseline ${recorded.toFixed(
        0,
      )} (${(ratio * 100).toFixed(0)}%)`,
    );
  } else {
    console.log(
      `✅ ${name}: ${current.toFixed(0)} ops/s vs baseline ${recorded.toFixed(
        0,
      )} (${(ratio * 100).toFixed(0)}%)`,
    );
  }
}

// 3. Every baseline bench must have been measured.
const unmeasured = Object.keys(baseline).filter((name) => !(name in results));
if (unmeasured.length > 0) {
  failures += unmeasured.length;
  for (const name of unmeasured) {
    console.error(`❌ ${name}: in the baseline but not measured`);
  }
  console.error("If a bench was renamed or removed, re-record the baseline.");
}

if (regressions > 0) {
  failures += regressions;
  console.error(
    `REGRESSION(S) >=50%: ${regressions} bench(es) below the baseline gate.`,
  );
}
if (newBenches.length > 0) {
  console.log(
    `ℹ️ ${newBenches.length} bench(es) not in baseline (baseline pending — run bun run bench:record).`,
  );
}

if (failures > 0) {
  console.error(`bench:check FAILED — ${failures} issue(s).`);
  process.exit(1);
}
console.log("bench:check PASSED.");
