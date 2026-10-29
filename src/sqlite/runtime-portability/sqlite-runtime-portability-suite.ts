/**
 * SqliteRuntimePortabilitySuite — the core SqliteStore + SqliteConnectionDriver
 * surface run against ANY synchronous SQLite handle (AnySyncSqliteHandle), so
 * the "works on node:sqlite AND bun:sqlite" claim is continuously enforced
 * rather than asserted once.
 *
 * The body is deliberately runtime-agnostic:
 * - it never imports Deno or bun APIs — tests are registered through the
 *   injected registrar (Deno.test on Deno, bun:test's `test` on Bun);
 * - it asserts with node:assert (a zero-dependency builtin on Node, Bun, and
 *   Deno's node-compat layer) instead of @std/assert, keeping the Bun CI job
 *   free of jsr-only test dependencies;
 * - handles come from the injected `makeHandle` / `createHandleFromPath`, so
 *   each runtime wrapper supplies its own builtin.
 *
 * Every case mirrors an existing Deno-side test (sqlite-store.test.ts /
 * sqlite-connection-driver.test.ts) so the two suites can drift apart loudly.
 */
import type {
  SqlitePortabilityTestRegistrar,
  SqliteRuntimePortabilitySuiteOptions,
} from "./sqlite-runtime-portability-shared.ts";
import { registerStoreCases } from "./sqlite-runtime-portability-store-cases.ts";
import { registerDriverCases } from "./sqlite-runtime-portability-driver-cases.ts";

export type {
  SqlitePortabilityTestRegistrar,
  SqliteRuntimePortabilitySuiteOptions,
} from "./sqlite-runtime-portability-shared.ts";

/** runSqliteRuntimePortabilitySuite registers the whole portability suite. */
export function runSqliteRuntimePortabilitySuite(
  test: SqlitePortabilityTestRegistrar,
  options: SqliteRuntimePortabilitySuiteOptions,
): void {
  registerStoreCases(test, options);
  registerDriverCases(test, options);
}
