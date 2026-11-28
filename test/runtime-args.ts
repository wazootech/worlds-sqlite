/**
 * runtimeArgs are the arguments that make `process.execPath` run a script:
 * Deno needs a subcommand and permissions, Bun takes the file directly.
 */
import process from "node:process";

export function runtimeArgs(): string[] {
  return process.versions["bun"] ? [] : ["run", "--allow-all"];
}
