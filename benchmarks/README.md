# worlds-sqlite benchmarks (L3)

Mirrors the six bench groups of the libsql reference per the shared
parity/benchmark definition
([workspace#72](https://github.com/wazootech/workspace/issues/72)).

| Group (file)                        | Status | Notes                                                                                          |
| ----------------------------------- | ------ | ---------------------------------------------------------------------------------------------- |
| `hybrid-search.bench.ts`            | ✅     | FTS5 keyword-only, hybrid RRF fusion and degrade-to-keyword.                                   |
| `idempotency-guard.bench.ts`        | ✅     | Novel vs redundant insert through the shared `WorldsSdk` facade.                               |
| `index-maintenance.bench.ts`        | ✅     | Full index rebuild (1,000 quads).                                                              |
| `sparql-perf-sqlite.bench.ts`       | ✅     | 1k–50k quads, selective (subject-bound) BGP; full-scan via `BENCH_HEXASTORE_PERF_FULL_SCAN=1`. |
| `sparql-perf-large-sqlite.bench.ts` | ✅     | 100k–250k quads (500k/1M omitted: in-memory fixtures, ~2 min + multi-GB at 500k).              |
| `synchronization.bench.ts`          | ✅     | Consolidated batch commits (10/100/1,000 quads).                                               |

## Tasks

- `bun run bench` — run all benches.
- `bun run bench:record` — re-record `baseline.json` from a clean run (commit
  it).
- `bun run bench:check` — the L3 gate: fails on missing groups or a ≥50%
  regression vs the committed baseline, or on a baseline bench that was not
  measured (new benches are reported as baseline-pending, not failed).

## Baseline

`baseline.json` holds each bench's lowest result across five CI runs, because
shared runners differ by about 2x. The gate therefore fails when a bench drops
below half of the slowest of those runs. Take new numbers from CI, not from a
faster local machine: `bench:record` there would raise the floor for runners. A
local `bench:check` compares your machine with those runners, so it can fail on
a slower or busy one; judge a change by the CI job.
