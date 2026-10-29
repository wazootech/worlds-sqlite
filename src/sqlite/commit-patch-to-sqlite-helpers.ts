import type * as rdfjs from "@rdfjs/types";
import type {
  SqliteConnectionDriver,
  SqlStatement,
} from "./sqlite-connection-driver.ts";
import { SqliteBatchExecutor } from "./sqlite-batch-executor.ts";
import { quadToPayloadJson } from "./rdfjs-store/sqlite-store.ts";
import type { SqliteSearchQueryBuilder } from "./search-index/sqlite-search-query-builder.ts";
import {
  buildBulkInsertQuads,
  buildDeleteQuadsByQuadKeys,
  buildSelectExistingQuadKeys,
  buildWipeAllGraphDataStatements,
  type QuadKey,
} from "./quad-store/sqlite-quad-query-builder.ts";

/**
 * executeReplaceImportWipe clears all quads and search chunks before a
 * replace-mode import commit.
 */
export async function executeReplaceImportWipe(
  connection: SqliteConnectionDriver,
  vectorSupported: boolean,
): Promise<void> {
  const executor = new SqliteBatchExecutor({ connection });
  await executor.stage(buildWipeAllGraphDataStatements({ vectorSupported }));
  await executor.flush();
}

/**
 * buildDeletionStatements constructs parameterized deletion statements
 * sweeping search chunks (vec rows + chunks + FTS rows via trigger) and
 * durable quads.
 */
function buildDeletionStatements(
  quadKeys: QuadKey[],
  quadIds: string[],
  queryBuilder: SqliteSearchQueryBuilder,
): SqlStatement[] {
  return [
    ...queryBuilder.buildDeleteByQuadIds(quadIds),
    buildDeleteQuadsByQuadKeys(quadKeys),
  ];
}

/**
 * stageDeletionStatementsChunked slices large quad id sets and eagerly
 * streams them to the executor.
 */
export async function stageDeletionStatementsChunked(
  executor: SqliteBatchExecutor,
  quadKeys: QuadKey[],
  quadIds: string[],
  queryBuilder: SqliteSearchQueryBuilder,
  chunkSize: number,
): Promise<void> {
  for (let index = 0; index < quadIds.length; index += chunkSize) {
    const quadIdBatch = quadIds.slice(index, index + chunkSize);
    const quadKeyBatch = quadKeys.slice(index, index + chunkSize);
    await executor.stage(
      buildDeletionStatements(quadKeyBatch, quadIdBatch, queryBuilder),
    );
  }
}

/**
 * queryQuadPresence polls SQLite to check which composite quad keys are
 * already persistent, using bounded row-value IN clauses.
 */
export async function queryQuadPresence(
  connection: SqliteConnectionDriver,
  quadKeys: QuadKey[],
  lookupChunkSize: number,
): Promise<Set<string>> {
  const existingKeys = new Set<string>();
  try {
    for (let i = 0; i < quadKeys.length; i += lookupChunkSize) {
      const batchKeys = quadKeys.slice(i, i + lookupChunkSize);
      const query = buildSelectExistingQuadKeys(batchKeys);
      const resultSet = await connection.execute(query);
      for (const row of resultSet.rows) {
        existingKeys.add(
          [row.skey, row.pkey, row.okey, row.gkey].map(String).join("\u0000"),
        );
      }
    }
  } catch (cause) {
    throw new Error("failed to query existing cache state", { cause });
  }

  return existingKeys;
}

/**
 * buildRelationalStatements decomposes structured quads into raw term-keyed
 * relational rows with the store's lossless payload encoding.
 */
export function buildRelationalStatements(
  quads: rdfjs.Quad[],
  quadKeys: QuadKey[],
): Array<{ sql: string; args: (string | null)[] }> {
  const insertQuadRows = quads.map((quad, index) => ({
    key: quadKeys[index]!,
    payload: quadToPayloadJson(quad),
  }));

  return buildBulkInsertQuads(insertQuadRows);
}
