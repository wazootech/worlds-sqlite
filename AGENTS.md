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
