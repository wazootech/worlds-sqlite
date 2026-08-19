import type { SqliteConnectionDriver } from "./sqlite-connection-driver.ts";
import type { SqlStatement } from "./sqlite-connection-driver.ts";

/** DEFAULT_MAX_LOOKUP_CHUNK_SIZE is the default IN-clause and deletion chunk width. */
export const DEFAULT_MAX_LOOKUP_CHUNK_SIZE = 800;

/** STAGING_FLUSH_THRESHOLD flushes staged SQL during large commits to avoid huge in-memory arrays. */
export const STAGING_FLUSH_THRESHOLD = 10_000;

/** SqliteBatchExecutorOptions defines the configuration for the batch executor. */
export interface SqliteBatchExecutorOptions {
  /** connection is the SqliteConnectionDriver used for executing writes. */
  connection: SqliteConnectionDriver;
}

/**
 * SqliteBatchExecutor encapsulates statement buffering and chunked execution
 * for node:sqlite. It prevents memory blowouts by eagerly flushing when the
 * staging buffer reaches the threshold (mirror of LibsqlBatchExecutor).
 */
export class SqliteBatchExecutor {
  private readonly statements: SqlStatement[] = [];

  public constructor(private readonly options: SqliteBatchExecutorOptions) {}

  /**
   * stage appends statements and flushes eagerly when the staging buffer grows
   * too large.
   */
  public async stage(source: readonly SqlStatement[]): Promise<void> {
    for (const statement of source) {
      this.statements.push(statement);
      if (this.statements.length >= STAGING_FLUSH_THRESHOLD) {
        await this.flush();
      }
    }
  }

  /**
   * flush executes and clears all currently staged write statements.
   */
  public async flush(): Promise<void> {
    if (this.statements.length === 0) {
      return;
    }

    const { connection } = this.options;

    try {
      await connection.batch(this.statements);
    } finally {
      this.statements.length = 0;
    }
  }
}
