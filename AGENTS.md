# AI agent coding guidelines

- This repo is the standalone `@worlds/sqlite` package and the **source of truth
  for SQLite-family SQL logic**. Keep imports local to this repo and use
  `@/sqlite/...` for in-repo absolute imports.
- **`src/sql-core/` must stay driver-free.** Modules there may only emit inert
  `{sql, args}` plans or pure strings — never import `node:sqlite`,
  `@libsql/client`, `sqlite-vec`, or any other driver/extension. The
  allowlist-based gate is `deno task sql-core:purity`; extend its allowlist only
  for shared, driver-free dependencies.
- Public exports should live in `deno.json`; keep `src/mod.ts` as the root
  barrel and `src/sql-core/mod.ts` as the `./sql-core` barrel.
- Follow the existing JSDoc and naming style in the source files (symbol-name
  first sentence; file names match the dominant exported symbol).
- Run `deno fmt` before committing, then `deno task ci` before merging.
  Benchmarks that could shift with query changes: run `deno task bench:check`.

## Code health

Family-wide rules live in the
[wazootech workspace constitution](https://github.com/wazootech/workspace/blob/main/AGENTS.md#code-health-standards);
this repo's specifics:

- Before pushing, run `deno task ci` (fmt check, lint, type check, tests).
- Deno type checking is strict by default; do not weaken it.
- `deno task ci` does not cover the separate `bun-portability` job (SqliteStore
  suite under `bun:sqlite`, Bun pinned to 1.3.14,
  `bun install --frozen-lockfile`); keep that toolchain consistent.
  `tsconfig.json` sets `"strict": true`.
- Actions in `.github/workflows/` are pinned to full commit SHAs, CI pins Deno
  to `v2.9.8`, and installs are frozen (`deno ci`).
- `secret-scan.yml` runs gitleaks on every PR and push to `main`; report
  findings, never suppress them.
- `code-health.yml` enforces the file-length limit (120 lines of code per source
  file, 300 per test; a file over its limit fails the build, with a short
  explicit in-workflow allowlist that may only shrink). The TODO/FIXME check is
  still warn-only.
- `.github/CODEOWNERS` and `renovate.json` are present; Renovate only acts where
  the org has the Renovate GitHub App installed.
