/**
 * Runs the two published examples and asserts their annotated outputs.
 *
 * This is the "deno test that runs the example to prevent regressions" path
 * for issue #13, chosen over a `deno task` because tests are already gated by
 * `deno task ci` in this repo.
 */
import { assertEquals } from "@std/assert";

async function runExample(relativePath: string): Promise<string> {
  const command = new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-all", relativePath],
    cwd: Deno.cwd(),
    stdout: "piped",
    stderr: "piped",
  });

  const { code, stdout, stderr } = await command.output();
  if (code !== 0) {
    throw new Error(
      `example failed: ${relativePath}\nstderr:\n${
        new TextDecoder().decode(stderr)
      }`,
    );
  }

  return new TextDecoder().decode(stdout).trim();
}

Deno.test("examples/hello-world/main.ts runs and prints annotated outputs", () =>
  Promise.resolve(
    runExample("./examples/hello-world/main.ts").then((out) => {
      assertEquals(out, "1\nselect\n1\nAlice");
    }),
  ));

Deno.test("examples/hybrid-search/main.ts runs and prints annotated outputs", () =>
  Promise.resolve(
    runExample("./examples/hybrid-search/main.ts").then((out) => {
      assertEquals(out, "2\nAlice the explorer\nselect\n2");
    }),
  ));
