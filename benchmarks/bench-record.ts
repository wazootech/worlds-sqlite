/**
 * bench:record — re-records benchmarks/baseline.json from a clean run: every
 * bench file's average operations per second, as a name to number map. Commit
 * the result.
 */
import { writeFile } from "node:fs/promises";
import { opsPerSecond } from "./shared/collect.ts";

const BASELINE_PATH = new URL("./baseline.json", import.meta.url);

const baseline = opsPerSecond();
await writeFile(BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`);
console.error(`Recorded ${Object.keys(baseline).length} bench baselines.`);
