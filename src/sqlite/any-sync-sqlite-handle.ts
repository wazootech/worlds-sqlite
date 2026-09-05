/**
 * AnySyncSqliteHandle — the minimal synchronous SQLite handle surface shared
 * by node:sqlite's DatabaseSync and bun:sqlite's Database.
 *
 * Both builtins are synchronous with the same local-file story, and both
 * structurally satisfy this interface (exec / prepare / close, plus optional
 * loadExtension), so any layer typed against it runs unchanged on either
 * runtime — and on any other sync SQLite handle exposing the same surface.
 *
 * This module is deliberately driver-free (no node:sqlite import): runtimes
 * without node:sqlite (Bun) can still load and use the L2 surface with a
 * pre-constructed handle or an injected handle factory.
 */

/**
 * AnySyncSqliteStatement is the minimal synchronous prepared-statement
 * surface shared by node:sqlite StatementSync and bun:sqlite Statement
 * (positional `?` binding, `.all()` / `.get()` row reads, `.run()` writes).
 */
export interface AnySyncSqliteStatement {
  /** all runs the statement and returns every result row. */
  all(...params: unknown[]): unknown[];

  /** get runs the statement and returns the first row (or null/undefined). */
  get(...params: unknown[]): unknown;

  /** run executes a write statement and reports its change count + rowid. */
  run(...params: unknown[]): {
    changes: number | bigint;
    lastInsertRowid: number | bigint;
  };
}

/**
 * AnySyncSqliteHandle is the minimal synchronous SQLite handle surface the
 * sqlite layer consumes: exec (DDL / batching / transaction framing),
 * prepare (parameterized statements), and close (handle ownership).
 *
 * loadExtension is optional because the layer itself never calls it — it
 * exists so extension loaders (sqlite-vec's `load`) can structurally accept
 * the same handles.
 */
export interface AnySyncSqliteHandle {
  /** exec runs one or more SQL statements directly. */
  exec(sql: string): void;

  /** prepare compiles a parameterized statement for repeated execution. */
  prepare(sql: string): AnySyncSqliteStatement;

  /** close releases the underlying database handle. */
  close(): void;

  /** loadExtension loads a shared library extension (e.g. sqlite-vec). */
  loadExtension?(path: string, entryPoint?: string): void;
}

/**
 * SyncSqliteHandleFactory opens a synchronous SQLite handle for a path.
 * Injectable default construction: runtime-specific factories
 * (node:sqlite, bun:sqlite) can be swapped in without touching the layer.
 */
export type SyncSqliteHandleFactory = (path: string) => AnySyncSqliteHandle;
