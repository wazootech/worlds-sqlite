# worlds-sqlite benchmarks (L3)

Mirrors the six bench groups of the libsql reference per the shared
parity/benchmark definition
([workspace#72](https://github.com/wazootech/workspace/issues/72)).

| Group (file)                        | Status     | Notes                                                                                                                                                                                                             |
| ----------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hybrid-search.bench.ts`            | Partial    | Scan-based keyword through `RdfjsSearchIndex` (the shipped search path today). FTS5 keyword-only, hybrid RRF fusion, and degrade-to-keyword benches land with `SqliteSearchIndex` (workspace#64, plan items 2–3). |
| `idempotency-guard.bench.ts`        | ✅         | Novel vs redundant insert through the shared `Sdk` facade.                                                                                                                                                        |
| `index-maintenance.bench.ts`        | ⛔ Missing | Needs the search-index projector/rebuild machinery (workspace#64, plan item 3). `bench:check` fails on this until it lands.                                                                                       |
| `sparql-perf-sqlite.bench.ts`       | ✅         | 1k–50k quads, selective (subject-bound) BGP; full-scan via `BENCH_HEXASTORE_PERF_FULL_SCAN=1`.                                                                                                                    |
| `sparql-perf-large-sqlite.bench.ts` | ✅         | 100k–250k quads (500k/1M omitted: in-memory fixtures, ~2 min + multi-GB at 500k).                                                                                                                                 |
| `synchronization.bench.ts`          | ✅         | Consolidated batch commits (10/100/1,000 quads).                                                                                                                                                                  |

## Tasks

- `deno task bench` — run all benches.
- `deno task bench:record` — re-record `baseline.json` from a clean run (commit
  it).
- `deno task bench:check` — the L3 gate: fails on missing groups or a ≥50%
  regression vs the committed baseline (new benches are reported as
  baseline-pending, not failed).

## Honest status (2026-08-19)

`bench:check` **cannot pass yet**: `index-maintenance.bench.ts` is absent and
`hybrid-search` is scan-based only, because worlds-sqlite ships the RDF/JS store
alone — the libsql-shaped SDK surface (quad store, search index, factory,
reference subpaths) from workspace#64's build plan has not been built. The gate
is the mechanism that makes that gap fail loudly; it flips green when plan items
2–3 land.
