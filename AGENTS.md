# AI agent coding guidelines

- This repo is the standalone `@worlds/sqlite` package and the **source of truth
  for SQLite-family SQL logic**. Keep imports local to this repo and use
  `@/sqlite/...` for in-repo absolute imports.
- **`src/sql-core/` must stay driver-free.** Modules there may only emit inert
  `{sql, args}` plans or pure strings — never import `node:sqlite`,
  `@libsql/client`, `sqlite-vec`, or any other driver/extension. The
  allowlist-based gate is `bun run sql-core:purity`; extend its allowlist only
  for shared, driver-free dependencies.
- Public exports live in `jsr.json` and are mirrored in `package.json`; keep
  `src/mod.ts` as the root barrel and `src/sql-core/mod.ts` as the
  `./sql-core` barrel.
- Follow the existing JSDoc and naming style in the source files (symbol-name
  first sentence; file names match the dominant exported symbol).
- Set up with `bun install` (Bun 1.4.5 or newer). Run `bun run fmt` before
  committing, then `bun run ci` before merging. Benchmarks that could shift with
  query changes: check the CI bench gate (see `benchmarks/README.md`).
- `code-health.yml` fails on a file over 120 lines of code (300 for tests);
  files that were already over it are listed there with a ceiling that only
  shrinks. A `TODO`/`FIXME` without an issue link only warns. The family-wide
  rules are in the
  [wazootech workspace constitution](https://github.com/wazootech/workspace/blob/main/AGENTS.md#code-health-standards).
