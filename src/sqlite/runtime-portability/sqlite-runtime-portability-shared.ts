import { DataFactory } from "n3";
import type { AnySyncSqliteHandle } from "@/sqlite/any-sync-sqlite-handle.ts";

export const { namedNode, literal, quad, defaultGraph } = DataFactory;

export const ex = (suffix: string) => namedNode(`http://example.org/${suffix}`);

/**
 * plainRows spreads null-prototype rows (node:sqlite) into plain objects so
 * node:assert's deepStrictEqual compares them equally with bun:sqlite's
 * ordinary plain-object rows.
 */
export function plainRows<Row extends Record<string, unknown>>(
  rows: Row[],
): Row[] {
  return rows.map((row) => ({ ...row }));
}

/** SqlitePortabilityTestRegistrar registers one test on the host runtime. */
export interface SqlitePortabilityTestRegistrar {
  (name: string, fn: () => void | Promise<void>): void;
}

/** SqliteRuntimePortabilitySuiteOptions supplies the runtime under test. */
export interface SqliteRuntimePortabilitySuiteOptions {
  /** label identifies the runtime under test in test names (e.g. "node:sqlite"). */
  label: string;

  /** makeHandle opens a fresh in-memory handle on the runtime under test. */
  makeHandle: () => AnySyncSqliteHandle;

  /**
   * createHandleFromPath mirrors the injectable default-construction seam
   * (SqliteStoreOptions.createHandle / SqliteWorldsSdkOptions.createHandle)
   * on the runtime under test.
   */
  createHandleFromPath: (path: string) => AnySyncSqliteHandle;
}
