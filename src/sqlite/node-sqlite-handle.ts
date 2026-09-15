import { DatabaseSync } from "node:sqlite";
import type { AnySyncSqliteHandle } from "./any-sync-sqlite-handle.ts";

/** CreateNodeSqliteHandleOptions configures the node:sqlite default handle. */
export interface CreateNodeSqliteHandleOptions {
  /**
   * allowExtension permits loading shared extensions (e.g. sqlite-vec).
   * Default false, matching node:sqlite's own default.
   */
  allowExtension?: boolean;
}

/**
 * createNodeSqliteHandle opens a node:sqlite DatabaseSync — the default
 * handle used when createSqliteWorldsSdk / SqliteStore receive a path with no
 * pre-constructed `db` or `createHandle`.
 *
 * This module is the package's single default node:sqlite construction site.
 * createSqliteWorldsSdk and SqliteStore both route through this function so
 * the default handle is constructed identically everywhere.
 *
 * This module is the only place in the package that statically imports
 * node:sqlite, and it is only ever reached through a dynamic import on the
 * default-construction path. Bun consumers passing their own bun:sqlite
 * Database (or a bun-based createHandle) never load this module.
 */
export function createNodeSqliteHandle(
  path: string,
  options?: CreateNodeSqliteHandleOptions,
): AnySyncSqliteHandle {
  return new DatabaseSync(path, {
    allowExtension: options?.allowExtension ?? false,
  });
}
