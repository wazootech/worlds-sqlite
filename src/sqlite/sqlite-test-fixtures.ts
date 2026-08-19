import type { DatabaseSync } from "node:sqlite";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { SqliteConnectionDriver } from "./sqlite-connection-driver.ts";
import { initializeSqliteSchema } from "./initialize-sqlite-schema.ts";
import { SqliteSchemaBuilder } from "./schema/sqlite-schema-builder.ts";
import { SqliteSearchQueryBuilder } from "./search-index/sqlite-search-query-builder.ts";

/** testVectorDimensions is the dimension used by the shared test builders. */
export const testVectorDimensions = 32;

/** testSqliteSchemaBuilder is a 32-dimension schema builder (vector support set by the driver). */
export const testSqliteSchemaBuilder = new SqliteSchemaBuilder(
  testVectorDimensions,
  { vectorSupported: true },
);

/** testSqliteSearchQueryBuilder is a 32-dimension search query builder (vector support set by the driver). */
export const testSqliteSearchQueryBuilder = new SqliteSearchQueryBuilder(
  testVectorDimensions,
  { vectorSupported: true },
);

/** keywordOnlySearchQueryBuilder emits no vec0 SQL (keyword-only degradation). */
export const keywordOnlySearchQueryBuilder = new SqliteSearchQueryBuilder(
  testVectorDimensions,
  { vectorSupported: false },
);

/** sharedTextSplitter is the default text splitter for sqlite search commit tests. */
export const sharedTextSplitter = new RecursiveCharacterTextSplitter({
  chunkSize: 1000,
});

/**
 * tryLoadVectorExtension attempts to load the bundled sqlite-vec extension on
 * the handle and reports whether vector search is available. Vec-dependent
 * tests gate on the result so runs degrade cleanly without the extension.
 */
export async function tryLoadVectorExtension(
  db: DatabaseSync,
): Promise<boolean> {
  try {
    const { load } = await import("sqlite-vec");
    load(db);
    return true;
  } catch {
    return false;
  }
}

/**
 * createTestSqliteConnectionDriver wraps a raw DatabaseSync in a
 * SqliteConnectionDriver for adapter tests.
 */
export function createTestSqliteConnectionDriver(
  db: DatabaseSync,
  options?: { vectorSupported?: boolean },
): SqliteConnectionDriver {
  return new SqliteConnectionDriver(db, options);
}

/**
 * testSearchQueryBuilderFor returns a search query builder whose vector flag
 * matches the connection (so deletion sweeps never emit vec0 SQL against a
 * keyword-only handle).
 */
export function testSearchQueryBuilderFor(
  connection: SqliteConnectionDriver,
): SqliteSearchQueryBuilder {
  return new SqliteSearchQueryBuilder(testVectorDimensions, {
    vectorSupported: connection.hasVectorSupport(),
  });
}

/**
 * setupSqliteSchemaForTest initializes the sqlite L2 schema for adapter tests
 * (search tables + FTS + vec when the extension is available on the handle).
 */
export async function setupSqliteSchemaForTest(
  connection: SqliteConnectionDriver,
  schemaBuilder?: SqliteSchemaBuilder,
): Promise<void> {
  const builder = schemaBuilder ??
    new SqliteSchemaBuilder(testVectorDimensions, {
      vectorSupported: connection.hasVectorSupport(),
    });
  await initializeSqliteSchema(connection, builder);
}
