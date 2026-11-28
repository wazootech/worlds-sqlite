/**
 * bench is the one harness for the bench files: a
 * file registers benches with `bench(definition, fn, setup?)` and ends with
 * `await runBenches()`. mitata measures each in turn. `setup` builds a fresh
 * argument for every iteration and is not timed.
 *
 *   bun benchmarks/synchronization.bench.ts          # table on stdout
 *   bun benchmarks/synchronization.bench.ts --json   # results as JSON
 */
import process from "node:process";
import { measure } from "mitata";

/** BenchDefinition names one bench and the group it is compared in. */
export interface BenchDefinition {
  name: string;
  group: string;
}

/** BenchResult is one measured bench; `avg` is nanoseconds per iteration. */
export interface BenchResult extends BenchDefinition {
  avg: number;
}

type Run = () => Promise<number>;

const registered: { definition: BenchDefinition; run: Run }[] = [];

/** bench registers one bench; runBenches measures everything registered. */
export function bench(
  definition: BenchDefinition,
  fn: () => unknown,
): void;
export function bench<T>(
  definition: BenchDefinition,
  fn: (input: T) => unknown,
  setup: () => T,
): void;
export function bench<T>(
  definition: BenchDefinition,
  fn: (input?: T) => unknown,
  setup?: () => T,
): void {
  const run: Run = async () => {
    // mitata awaits only a function declared async, so the wrappers must be.
    if (!setup) return (await measure(async () => await fn())).avg;
    // mitata's computed parameter: `[0]` is recomputed outside the timing.
    const stats = await measure(function* () {
      yield { [0]: setup, bench: async (input: T) => await fn(input) };
    });
    return stats.avg;
  };
  registered.push({ definition, run });
}

/** runBenches measures every registered bench in order and reports them. */
export async function runBenches(
  argv: string[] = process.argv.slice(2),
): Promise<void> {
  const results: BenchResult[] = [];
  for (const { definition, run } of registered) {
    console.error(`bench ${definition.group} / ${definition.name}`);
    results.push({ ...definition, avg: await run() });
  }
  if (argv.includes("--json")) {
    console.log(JSON.stringify(results));
    return;
  }
  for (const { name, avg } of results) {
    console.log(`${name.padEnd(72)} ${(avg / 1e6).toFixed(3)} ms`);
  }
}
