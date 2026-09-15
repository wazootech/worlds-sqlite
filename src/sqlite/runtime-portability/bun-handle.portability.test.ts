/**
 * bun:sqlite leg of the runtime-portability suite — runs the shared
 * SqliteStore + SqliteConnectionDriver suite over bun:sqlite Database
 * handles under Bun (the runtime the AnySyncSqliteHandle seam exists for:
 * Bun 1.3.x does not resolve node:sqlite at all).
 *
 * This file is bun-only: `deno test` discovery excludes it via deno.json's
 * `test.exclude`, and CI runs it with `bun test`. The file is unreachable
 * from any package export and is not typechecked by `deno check` — the real
 * protection is Bun's own runtime + typecheck on `bun test`.
 */
import { Database } from "bun:sqlite";
import { test } from "bun:test";
import {
  runSqliteRuntimePortabilitySuite,
} from "./sqlite-runtime-portability-suite.ts";

runSqliteRuntimePortabilitySuite(test, {
  label: "bun:sqlite",
  makeHandle: () => new Database(":memory:"),
  createHandleFromPath: (path) => new Database(path),
});
