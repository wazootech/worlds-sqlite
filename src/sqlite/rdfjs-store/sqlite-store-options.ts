import type {
  AnySyncSqliteHandle,
  SyncSqliteHandleFactory,
} from "@/sqlite/any-sync-sqlite-handle.ts";

/** SqliteStoreOptions configures SqliteStore. */
export interface SqliteStoreOptions {
  /** Path to the SQLite database file, or ":memory:" for a temp database. */
  path: string;

  /**
   * Pre-created synchronous SQLite handle to share instead of opening a new
   * one: a node:sqlite DatabaseSync, a bun:sqlite Database, or any other
   * AnySyncSqliteHandle. Used by createSqliteWorldsSdk so the L2 quad store,
   * search layer, and RDF/JS read path share a single handle (required for
   * ":memory:" and for a handle opened with allowExtension so sqlite-vec can
   * load). When provided, `path` is ignored.
   */
  db?: AnySyncSqliteHandle;

  /**
   * createHandle supplies the default handle when `db` is absent — the
   * injectable construction seam. Defaults to opening a node:sqlite
   * DatabaseSync for `path`; Bun callers can pass a factory over
   * bun:sqlite's Database instead. When provided, `path` is used as its
   * argument.
   */
  createHandle?: SyncSqliteHandleFactory;

  /** matchPageSize limits rows per getQuads SQL round-trip (default 1000). */
  matchPageSize?: number;

  /**
   * Test seam invoked inside commit(), after BEGIN IMMEDIATE and before any
   * row is written. Throw to exercise the atomic-rollback path.
   */
  beforeCommit?: (db: AnySyncSqliteHandle) => void;
}
