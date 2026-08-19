import type { SqliteConnectionDriver } from "./sqlite-connection-driver.ts";
import type { SqliteSchemaBuilder } from "./schema/sqlite-schema-builder.ts";

/**
 * initializeSqliteSchema idempotently creates the full set of persistent
 * tables for the L2 search surface: the L1 quads table (already owned by
 * SqliteStore), the materialized chunks table, the external-content FTS5
 * index with sync triggers, and — when sqlite-vec is loaded — the vec0
 * chunks_vec table.
 *
 * Unlike initializeLibsqlSchema, no legacy migration is needed: the search
 * tables are new in 0.4.0, and every DDL is CREATE IF NOT EXISTS.
 */
export async function initializeSqliteSchema(
  connection: SqliteConnectionDriver,
  schemaBuilder: SqliteSchemaBuilder,
): Promise<void> {
  for (const ddl of schemaBuilder.buildTables()) {
    await connection.execute({ sql: ddl });
  }
  for (const ddl of schemaBuilder.buildIndexes()) {
    await connection.execute({ sql: ddl });
  }
  await connection.execute({ sql: schemaBuilder.buildSqliteChunksFtsTable() });
  for (const triggerSql of schemaBuilder.buildSqliteChunksTriggers()) {
    await connection.execute({ sql: triggerSql });
  }
}
