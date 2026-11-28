import { rebuildSqlSearchIndex } from "@/sql-core/mod.ts";
import {
  createSqliteCommit,
  type SqliteCommitCoreOptions,
} from "@/sqlite/commit/create-sqlite-commit.ts";

/** RebuildSqliteSearchIndexFromQuadsResult reports how many quads and chunk rows were processed. */
export interface RebuildSqliteSearchIndexFromQuadsResult {
  /** processedQuadCount is the number of quads read from durable storage. */
  processedQuadCount: number;
  /** chunkRowCount is the number of chunk rows written to FTS/vector tables. */
  chunkRowCount: number;
}

/** ReadProjectSearchChunksOptions extends the commit options with paging. */
export interface ReadProjectSearchChunksOptions extends SqliteCommitCoreOptions {
  readPageSize?: number;
}

/**
 * rebuildSqliteSearchIndexFromQuads rebuilds FTS and vector chunk rows from
 * the `quads` table without re-importing graph data, through the shared
 * rebuildSqlSearchIndex (keyset-paged over the composite primary key, each
 * page chunked and embedded before it is written).
 *
 * An include/exclude filter (from `options`) scopes the rebuild: it replaces
 * only the chunk rows of the matching quads and leaves every other row alone,
 * and `processedQuadCount` still counts every stored quad scanned. A filter
 * with no criteria is not a scope: the rebuild clears and rebuilds everything.
 *
 * Use after schema upgrades, label predicate changes, or discovery-index
 * tuning so existing corpora pick up refreshed `fts_value` and vectors.
 */
export async function rebuildSqliteSearchIndexFromQuads(
  options: ReadProjectSearchChunksOptions,
): Promise<RebuildSqliteSearchIndexFromQuadsResult> {
  let processedQuadCount = 0;
  const { driver, dialect, projection, filter } = createSqliteCommit(
    options,
    (count) => (processedQuadCount += count),
  );
  if (!projection) {
    throw new Error(
      "rebuildSqliteSearchIndexFromQuads requires textSplitter in its options",
    );
  }
  const chunkRowCount = await rebuildSqlSearchIndex(
    driver,
    dialect,
    projection,
    { pageSize: options.readPageSize, scope: filter },
  );
  return { processedQuadCount, chunkRowCount };
}

/**
 * createSqliteSearchIndexRebuilder returns a closure that rebuilds search
 * chunks using stable sqlite dependencies.
 */
export function createSqliteSearchIndexRebuilder(
  dependencies: ReadProjectSearchChunksOptions,
): () => Promise<RebuildSqliteSearchIndexFromQuadsResult> {
  return () => rebuildSqliteSearchIndexFromQuads(dependencies);
}
