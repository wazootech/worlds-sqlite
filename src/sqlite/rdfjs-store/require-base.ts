import process from "node:process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * requireBase returns a `createRequire` base for loading a builtin such as
 * node:sqlite from the module at `moduleUrl`.
 *
 * createRequire accepts only a file URL or absolute path. Imported from
 * source the module URL is `file:`, but a JSR consumer loads this package
 * from `https://jsr.io/...`, which createRequire rejects. A builtin resolves
 * the same from any base, so a remote module falls back to the working
 * directory.
 */
export function requireBase(moduleUrl: string): string {
  return moduleUrl.startsWith("file:")
    ? moduleUrl
    : pathToFileURL(join(process.cwd(), "noop.js")).href;
}
