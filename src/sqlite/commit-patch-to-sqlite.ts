import type * as rdfjs from "@rdfjs/types";
import type {
  Patch,
  QuadFilter,
  TransactionContext,
} from "@worlds/sdk/quad-store";
import {
  isReplaceImportCommit,
  preparePatch,
  selectNovelQuads,
} from "@worlds/sdk/quad-store";
import type { SqliteConnectionDriver } from "./sqlite-connection-driver.ts";
import { SqliteBatchExecutor } from "./sqlite-batch-executor.ts";
import type { SqliteSearchQueryBuilder } from "./search-index/sqlite-search-query-builder.ts";
import {
  buildWipeAllGraphDataStatements,
  type QuadKey,
  quadKeyFor,
  quadKeyString,
} from "./quad-store/sqlite-quad-query-builder.ts";
import {
  buildRelationalStatements,
  queryQuadPresence,
  stageDeletionStatementsChunked,
} from "./commit-patch-statements.ts";

export { stageDeletionStatementsChunked };

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
 * executeReplaceImportWipe clears all quads and search chunks before a
 * replace-mode import commit.
 */
async function executeReplaceImportWipe(
  connection: SqliteConnectionDriver,
  vectorSupported: boolean,
): Promise<void> {
  const executor = new SqliteBatchExecutor({ connection });
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
    include,
    exclude,
    searchQueryBuilder,
  } = options;
  const lookupChunkSize = maxLookupChunkSize ?? 800;

  // Filter and hash BEFORE the replace-import wipe: a throw here leaves the
  // store untouched instead of wiped.
  const prepared = preparePatch(patch, { include, exclude });

  const batchExecutor = new SqliteBatchExecutor({ connection });

  if (isReplaceImportCommit(context)) {
    await executeReplaceImportWipe(
      connection,
      searchQueryBuilder.vectorSupported,
    );
  }

  // 1. Stage sweeping deletion operations (search chunks + durable quads).
  if (prepared.deletions.length) {
    await stageDeletionStatementsChunked(
      batchExecutor,
      prepared.deletions.map(quadKeyFor),
      prepared.deletionIds,
      searchQueryBuilder,
      lookupChunkSize,
    );
  }

  // 2. Stage content-addressed novel insertion operations. SQLite identifies a
  // quad by its composite term key, so the shared novelty rule runs on those
  // keys and the lookup maps them back to QuadKeys.
  const keyed = new Map<string, QuadKey>();
  const keyOf = (quad: rdfjs.Quad): string => {
    const key = quadKeyFor(quad);
    const keyString = quadKeyString(key);
    keyed.set(keyString, key);
    return keyString;
  };
  const { novelInsertions, novelQuadIds } = await selectNovelQuads(prepared, {
    keyOf,
    lookupExisting: (keys) =>
      queryQuadPresence(
        connection,
        keys.map((keyString) => keyed.get(keyString)!),
        lookupChunkSize,
      ),
  });

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

  // 3. Flush any remaining staged writes.
  try {
    await batchExecutor.flush();
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`failed to execute sync batch: ${detail}`, { cause });
  }

  return { novelInsertions, novelQuadIds };
}
