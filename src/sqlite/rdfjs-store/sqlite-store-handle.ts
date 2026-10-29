import { createRequire } from "node:module";
import type { AnySyncSqliteHandle } from "@/sqlite/any-sync-sqlite-handle.ts";
import { requireBase } from "@/sqlite/rdfjs-store/require-base.ts";

/**
 * openNodeSqliteHandle opens the default node:sqlite DatabaseSync for a path.
 *
 * This is the package's single default node:sqlite construction site.
 * createSqliteWorldsSdk and SqliteStore both route through this function so
 * the default handle is constructed identically everywhere. node:sqlite is
 * resolved lazily (never at module load), so this module stays loadable on
 * runtimes without it (Bun).
 *
 * On runtimes without node:sqlite the error surfaces only when no `db` /
 * `createHandle` was provided.
 */
export function openNodeSqliteHandle(path: string): AnySyncSqliteHandle {
  const { DatabaseSync } = createRequire(requireBase(import.meta.url))(
    "node:sqlite",
  ) as typeof import("node:sqlite");
  // Default construction mirrors createNodeSqliteHandle(options) with
  // allowExtension: false so this fallback is byte-identical to the SDK path.
  return new DatabaseSync(path, {
    allowExtension: false,
  });
}
