/**
 * Runs the two published examples and asserts their annotated outputs.
 *
 * This is the "test that runs the example to prevent regressions" path for
 * issue #13, chosen over a separate script because tests are already gated in
 * CI in this repo.
 */
import { spawn } from "node:child_process";
import process from "node:process";
import { test } from "node:test";
import { runtimeArgs } from "../test/runtime-args.ts";
import { assertEquals } from "@std/assert";

function runExample(relativePath: string): Promise<string> {
  const child = spawn(process.execPath, [...runtimeArgs(), relativePath], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout.trim());
      else {
        reject(
          new Error(`example failed: ${relativePath}\nstderr:\n${stderr}`),
        );
      }
    });
  });
}

test("examples/hello-world/main.ts runs and prints annotated outputs", () =>
  Promise.resolve(
    runExample("./examples/hello-world/main.ts").then((out) => {
      assertEquals(out, "1\nselect\n1\nAlice");
    }),
  ));

test("examples/hybrid-search/main.ts runs and prints annotated outputs", () =>
  Promise.resolve(
    runExample("./examples/hybrid-search/main.ts").then((out) => {
      assertEquals(out, "2\nAlice the explorer\nselect\n2");
    }),
  ));
