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
import type { SqliteConnectionDriver } from "./sqlite-connection-driver.ts";
import { SqliteBatchExecutor } from "./sqlite-batch-executor.ts";
import type { SqliteSearchQueryBuilder } from "./search-index/sqlite-search-query-builder.ts";
import {
  quadKeyFor,
  quadKeyString,
} from "./quad-store/sqlite-quad-query-builder.ts";
import {
  buildRelationalStatements,
  executeReplaceImportWipe,
  queryQuadPresence,
  stageDeletionStatementsChunked,
} from "./commit-patch-to-sqlite-helpers.ts";

export { stageDeletionStatementsChunked } from "./commit-patch-to-sqlite-helpers.ts";

/** CommitPatchToSqliteOptions configures the durable commit path. */
export interface CommitPatchToSqliteOptions extends QuadFilter {
  /** connection is the SqliteConnectionDriver wrapping the SQLite handle. */
  connection: SqliteConnectionDriver;

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
    include,
    exclude,
    searchQueryBuilder,
  } = options;
  const lookupChunkSize = maxLookupChunkSize ?? 800;

  const batchExecutor = new SqliteBatchExecutor({ connection });

  if (isReplaceImportCommit(context)) {
    await executeReplaceImportWipe(
      connection,
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
