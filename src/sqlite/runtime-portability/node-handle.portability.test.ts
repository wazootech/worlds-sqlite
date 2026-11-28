/**
 * node:sqlite leg of the runtime-portability suite — runs the shared
 * SqliteStore + SqliteConnectionDriver suite over node:sqlite DatabaseSync
 * handles under the toolchain Bun, which resolves node:sqlite. The bun:sqlite
 * leg lives in ./bun-handle.portability.test.ts (also run alone in CI on a Bun
 * that cannot resolve node:sqlite).
 */
import { test } from "node:test";
import { createNodeSqliteHandle } from "@/sqlite/node-sqlite-handle.ts";
import {
  runSqliteRuntimePortabilitySuite,
} from "./sqlite-runtime-portability-suite.ts";

runSqliteRuntimePortabilitySuite(
  (name, fn) => test(name, fn),
  {
    label: "node:sqlite",
    makeHandle: () => createNodeSqliteHandle(":memory:"),
    createHandleFromPath: (path) => createNodeSqliteHandle(path),
  },
);
