import type { DatabaseSync, SQLInputValue } from "node:sqlite";

/**
 * SqlStatement is a single parameterized SQL statement using `?` placeholders.
 */
export interface SqlStatement {
  /** sql is the statement text, using `?` placeholders. */
  sql: string;

  /** args are the positional bind values for the statement's placeholders. */
  args?: SQLInputValue[];
}

/**
 * SqlResult is the outcome of executing a single statement.
 */
export interface SqlResult<Row = Record<string, unknown>> {
  /** rows are the returned result rows (empty for plain writes). */
  rows: Row[];
}

/**
 * SqlExecutor is the minimal statement-execution surface used inside a
 * transaction scope.
 */
export interface SqlExecutor {
  /** execute runs a single parameterized statement and returns its rows. */
  execute<Row = Record<string, unknown>>(
    statement: SqlStatement,
  ): Promise<SqlResult<Row>>;
}

/** SqliteConnectionDriverOptions configures the sync SQLite driver. */
export interface SqliteConnectionDriverOptions {
  /**
   * vectorSupported reports whether the sqlite-vec extension is loaded on the
   * underlying handle. When false, the L2 search layer degrades to
   * keyword-only FTS5 and never emits vec0 SQL.
   */
  vectorSupported?: boolean;
}

/**
 * SqliteConnectionDriver adapts a `node:sqlite` DatabaseSync handle to the
 * uniform async SQL surface the L2 layer consumes (execute / batch /
 * transaction / close), mirroring LibsqlConnectionDriver over @libsql/client.
 *
 * node:sqlite is synchronous, so every method resolves immediately after the
 * statement runs; the async shape exists to keep the L2 pipeline portable
 * with the libsql reference and the @worlds/sdk seam.
 */
export class SqliteConnectionDriver {
  private readonly vectorSupported: boolean;

  public constructor(
    private readonly db: DatabaseSync,
    options?: SqliteConnectionDriverOptions,
  ) {
    this.vectorSupported = options?.vectorSupported ?? false;
  }

  /** database exposes the underlying node:sqlite handle (advanced use). */
  public get database(): DatabaseSync {
    return this.db;
  }

  /**
   * execute runs a single parameterized statement and returns its rows.
   * Statements that do not produce rows (plain INSERT/UPDATE/DELETE) return an
   * empty row set; INSERT ... RETURNING rows are returned like SELECT rows.
   */
  public execute<Row = Record<string, unknown>>(
    statement: SqlStatement,
  ): Promise<SqlResult<Row>> {
    try {
      const { sql, args } = statement;
      const rows = this.db.prepare(sql).all(...(args ?? [])) as Row[];
      return Promise.resolve({ rows });
    } catch (error) {
      return Promise.reject(error);
    }
  }

  /**
   * batch runs multiple write statements atomically inside one
   * BEGIN IMMEDIATE ... COMMIT (the sync mirror of @libsql/client's
   * write-transaction batch).
   */
  public batch(statements: readonly SqlStatement[]): Promise<void> {
    if (statements.length === 0) {
      return Promise.resolve();
    }
    try {
      this.db.exec("BEGIN IMMEDIATE");
      for (const statement of statements) {
        this.db.prepare(statement.sql).run(...(statement.args ?? []));
      }
      this.db.exec("COMMIT");
      return Promise.resolve();
    } catch (error) {
      this.db.exec("ROLLBACK");
      return Promise.reject(error);
    }
  }

  /**
   * transaction runs the given function inside one atomic write transaction.
   */
  public async transaction<T>(
    fn: (tx: SqlExecutor) => Promise<T>,
  ): Promise<T> {
    const tx: SqlExecutor = {
      execute: <Row = Record<string, unknown>>(
        statement: SqlStatement,
      ): Promise<SqlResult<Row>> => {
        try {
          const rows = this.db.prepare(statement.sql).all(
            ...(statement.args ?? []),
          ) as Row[];
          return Promise.resolve({ rows });
        } catch (error) {
          return Promise.reject(error);
        }
      },
    };
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = await fn(tx);
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * hasVectorSupport reports whether sqlite-vec is available on this handle.
   */
  public hasVectorSupport(): boolean {
    return this.vectorSupported;
  }

  /** close releases the underlying database handle. */
  public close(): Promise<void> {
    try {
      this.db.close();
      return Promise.resolve();
    } catch (error) {
      return Promise.reject(error);
    }
  }
}
