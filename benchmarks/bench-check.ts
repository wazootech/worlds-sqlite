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
 *   3. New benches absent from the baseline are reported as "baseline
 *      pending" and do not fail the gate.
 *
 * Re-record the baseline with: deno task bench:record
 */

import { join } from "@std/path";

const REPO_ROOT = Deno.cwd();

const CANONICAL_BENCH_FILES = [
  "hybrid-search.bench.ts",
  "idempotency-guard.bench.ts",
  "index-maintenance.bench.ts",
  "sparql-perf-sqlite.bench.ts",
  "sparql-perf-large-sqlite.bench.ts",
  "synchronization.bench.ts",
] as const;

const BASELINE_PATH = new URL("./baseline.json", import.meta.url);

interface BenchEntry {
  name: string;
  results?: Array<{ ok?: { avg?: number } }>;
}

function opsPerSecond(entry: BenchEntry): number | undefined {
  const avgNs = entry.results?.[0]?.ok?.avg;
  if (typeof avgNs !== "number" || avgNs <= 0) return undefined;
  return 1_000_000_000 / avgNs;
}

async function benchJson(): Promise<BenchEntry[]> {
  const command = new Deno.Command("deno", {
    args: ["bench", "--allow-all", "--json", "benchmarks/"],
    cwd: REPO_ROOT,
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout, stderr } = await command.output();
  if (code !== 0) {
    throw new Error(
      `deno bench failed (exit ${code}): ${new TextDecoder().decode(stderr)}`,
    );
  }
  const parsed = JSON.parse(new TextDecoder().decode(stdout));
  return Array.isArray(parsed) ? parsed : (parsed.benches ?? []);
}

const results = await benchJson();

// 1. Missing-group check.
const presentFiles = new Set<string>();
for (const file of Deno.readDirSync(join(REPO_ROOT, "benchmarks"))) {
  if (file.name.endsWith(".bench.ts")) presentFiles.add(file.name);
}
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
  baseline = JSON.parse(
    await Deno.readTextFile(BASELINE_PATH),
  ) as Record<string, number>;
} catch {
  console.warn(
    "No committed baseline found (benchmarks/baseline.json). Run `deno task bench:record`. Skipping regression gate.",
  );
}

let regressions = 0;
const newBenches: string[] = [];
for (const result of results) {
  const current = opsPerSecond(result);
  const recorded = baseline[result.name];
  if (recorded === undefined) {
    if (current !== undefined) newBenches.push(result.name);
    continue;
  }
  if (current === undefined) continue;
  const ratio = current / recorded;
  if (ratio < 0.5) {
    regressions++;
    console.error(
      `❌ ${result.name}: ${current.toFixed(0)} ops/s vs baseline ${
        recorded.toFixed(0)
      } (${(ratio * 100).toFixed(0)}%)`,
    );
  } else {
    console.log(
      `✅ ${result.name}: ${current.toFixed(0)} ops/s vs baseline ${
        recorded.toFixed(0)
      } (${(ratio * 100).toFixed(0)}%)`,
    );
  }
}

if (regressions > 0) {
  failures += regressions;
  console.error(
    `REGRESSION(S) >=50%: ${regressions} bench(es) below the baseline gate.`,
  );
}
if (newBenches.length > 0) {
  console.log(
    `ℹ️ ${newBenches.length} bench(es) not in baseline (baseline pending — run deno task bench:record).`,
  );
}

if (failures > 0) {
  console.error(`bench:check FAILED — ${failures} issue(s).`);
  Deno.exit(1);
}
console.log("bench:check PASSED.");
