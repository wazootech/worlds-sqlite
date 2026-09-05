/**
 * node:sqlite leg of the runtime-portability suite — runs the shared
 * SqliteStore + SqliteConnectionDriver suite over node:sqlite DatabaseSync
 * handles under Deno (Deno >= 2.1 resolves node:sqlite). The bun:sqlite leg
 * lives in ./bun-handle.portability.test.ts (excluded from `deno test`
 * discovery via deno.json; run under `bun test` in CI).
 */
import { createNodeSqliteHandle } from "@/sqlite/node-sqlite-handle.ts";
import {
  runSqliteRuntimePortabilitySuite,
} from "./sqlite-runtime-portability-suite.ts";

runSqliteRuntimePortabilitySuite(
  (name, fn) => Deno.test(name, fn),
  {
    label: "node:sqlite",
    makeHandle: () => createNodeSqliteHandle(":memory:"),
    createHandleFromPath: (path) => createNodeSqliteHandle(path),
  },
);
