import { assertEquals } from "@std/assert";
import { createRequire } from "node:module";
import { requireBase } from "@/sqlite/rdfjs-store/require-base.ts";

Deno.test("requireBase keeps a file: module URL", () => {
  const url = new URL("./require-base.ts", import.meta.url).href;
  assertEquals(requireBase(url), url);
});

Deno.test("requireBase gives a remote (JSR) module a base createRequire accepts", () => {
  // jsr: imports resolve to https://jsr.io/..., which createRequire rejects;
  // 0.7.1 and 0.7.2 failed every default `new SqliteStore({ path })` there.
  const base = requireBase(
    "https://jsr.io/@worlds/sqlite/0.7.2/src/sqlite/rdfjs-store/sqlite-store.ts",
  );
  assertEquals(base.startsWith("file:"), true);
  const { DatabaseSync } = createRequire(base)(
    "node:sqlite",
  ) as typeof import("node:sqlite");
  assertEquals(typeof DatabaseSync, "function");
});
