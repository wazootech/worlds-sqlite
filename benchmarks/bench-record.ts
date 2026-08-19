/**
 * bench:record — re-records benchmarks/baseline.json from a clean run.
 *
 * Runs `deno bench --json` over benchmarks/, reduces each bench to its
 * average ops/sec (from results[0].ok.avg, ns per iteration), and writes the
 * committed baseline as a name -> opsPerSecond map. Commit the result.
 */

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

const command = new Deno.Command("deno", {
  args: ["bench", "--allow-all", "--json", "benchmarks/"],
  cwd: Deno.cwd(),
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
const entries: BenchEntry[] = Array.isArray(parsed)
  ? parsed
  : (parsed.benches ?? []);

const baseline: Record<string, number> = {};
for (const entry of entries) {
  const ops = opsPerSecond(entry);
  if (ops !== undefined) baseline[entry.name] = ops;
}

await Deno.writeTextFile(
  BASELINE_PATH,
  `${JSON.stringify(baseline, null, 2)}\n`,
);
console.error(`Recorded ${Object.keys(baseline).length} bench baselines.`);
