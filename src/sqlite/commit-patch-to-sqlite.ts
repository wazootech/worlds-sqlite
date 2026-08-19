import type * as rdfjs from "@rdfjs/types";
import type {
  Patch,
  QuadFilter,
  TransactionContext,
} from "@worlds/sdk/quad-store";
import {
  filterQuads,
  hashQuads,
  isReplaceImportCommit,
} from "@worlds/sdk/quad-store";
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
  quadKeyFor,
  quadKeyString,
} from "./quad-store/sqlite-quad-query-builder.ts";

/** CommitPatchToSqliteOptions configures the durable commit path. */
export interface CommitPatchToSqliteOptions extends QuadFilter {
  /** connection is the SqliteConnectionDriver wrapping the SQLite handle. */
  connection: SqliteConnectionDriver;

  /** maxWriteBatchSize caps statements per SQLite write batch (default 500). */
  maxWriteBatchSize?: number;

  /** maxLookupChunkSize caps IN-clause widths (default 800). */
  maxLookupChunkSize?: number;

  /** searchQueryBuilder supplies dimension-aware chunk deletion SQL. */
  searchQueryBuilder: SqliteSearchQueryBuilder;
}

/** CommitPatchToSqliteResult reports the novel rows for search projection. */
export interface CommitPatchToSqliteResult {
  novelInsertions: rdfjs.Quad[];
  novelQuadIds: string[];
}

/**
 * executeReplaceImportWipe clears all quads and search chunks before a
 * replace-mode import commit.
 */
async function executeReplaceImportWipe(
  connection: SqliteConnectionDriver,
  writeBatchSize: number,
  vectorSupported: boolean,
): Promise<void> {
  const executor = new SqliteBatchExecutor({ connection, writeBatchSize });
  await executor.stage(buildWipeAllGraphDataStatements({ vectorSupported }));
  await executor.flush();
}

/**
 * commitPatchToSqlite commits additions and removals exclusively for SQLite
 * quads, and returns the novel insertions (with their content-addressed ids)
 * to be processed by independent search projection.
 *
 * The quads table is the L1 term-keyed shape (skey/pkey/okey/gkey/payload):
 * presence checks and deletions use the composite key while search chunks are
 * swept by the same canonical quad hash the projector writes.
 */
export async function commitPatchToSqlite(
  patch: Patch,
  options: CommitPatchToSqliteOptions,
  context?: TransactionContext,
): Promise<CommitPatchToSqliteResult> {
  const {
    connection,
    maxLookupChunkSize,
    maxWriteBatchSize,
    include,
    exclude,
    searchQueryBuilder,
  } = options;
  const lookupChunkSize = maxLookupChunkSize ?? 800;
  const writeBatchSize = maxWriteBatchSize ?? 500;

  const batchExecutor = new SqliteBatchExecutor({ connection, writeBatchSize });

  if (isReplaceImportCommit(context)) {
    await executeReplaceImportWipe(
      connection,
      writeBatchSize,
      searchQueryBuilder.vectorSupported,
    );
  }

  const matcher = filterQuads({ include, exclude });

  const targetedDeletions = patch.deletions?.filter(matcher) ?? [];
  const targetedInsertions = patch.insertions?.filter(matcher) ?? [];

  // 1. Stage sweeping deletion operations (search chunks + durable quads).
  const deletionQuadKeys = new Set<string>();
  if (targetedDeletions.length) {
    const deletionKeys = targetedDeletions.map(quadKeyFor);
    const deletionQuadIds = await hashQuads(targetedDeletions);
    for (const key of deletionKeys) {
      deletionQuadKeys.add(quadKeyString(key));
    }
    if (deletionQuadIds.length > 0) {
      await stageDeletionStatementsChunked(
        batchExecutor,
        deletionKeys,
        deletionQuadIds,
        searchQueryBuilder,
        lookupChunkSize,
      );
    }
  }

  // 2. Stage content-addressed novel insertion operations.
  const novelInsertions: rdfjs.Quad[] = [];
  const novelQuadIds: string[] = [];

  if (targetedInsertions.length) {
    const insertionKeys = targetedInsertions.map(quadKeyFor);
    const proposedQuadIds = await hashQuads(targetedInsertions);
    const existingKeys = await queryQuadPresence(
      connection,
      insertionKeys,
      lookupChunkSize,
    );

    // Deduplication filter: process ONLY truly novel facts not yet persistent.
    for (let i = 0; i < targetedInsertions.length; i++) {
      const keyString = quadKeyString(insertionKeys[i]!);
      if (!existingKeys.has(keyString) || deletionQuadKeys.has(keyString)) {
        novelInsertions.push(targetedInsertions[i]!);
        novelQuadIds.push(proposedQuadIds[i]!);
      }
    }

    if (novelQuadIds.length > 0) {
      const novelKeys = novelInsertions.map(quadKeyFor);
      // Ensure a relational clean slate for new items (idempotent re-import).
      await stageDeletionStatementsChunked(
        batchExecutor,
        novelKeys,
        novelQuadIds,
        searchQueryBuilder,
        lookupChunkSize,
      );

      // Stage fact decompositions (relational index).
      await batchExecutor.stage(
        buildRelationalStatements(novelInsertions, novelKeys),
      );
    }
  }

  // 3. Flush any remaining staged writes.
  try {
    await batchExecutor.flush();
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`failed to execute sync batch: ${detail}`, { cause });
  }

  return {
    novelInsertions,
    novelQuadIds,
  };
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
async function queryQuadPresence(
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
function buildRelationalStatements(
  quads: rdfjs.Quad[],
  quadKeys: QuadKey[],
): Array<{ sql: string; args: (string | null)[] }> {
  const insertQuadRows = quads.map((quad, index) => ({
    key: quadKeys[index]!,
    payload: quadToPayloadJson(quad),
  }));

  return buildBulkInsertQuads(insertQuadRows);
}
