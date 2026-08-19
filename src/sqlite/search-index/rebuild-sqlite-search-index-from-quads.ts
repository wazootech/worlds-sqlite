import type * as rdfjs from "@rdfjs/types";
import { filterQuads } from "@worlds/sdk/quad-store";
import {
  type ProjectSearchChunksOptions,
  refreshSearchChunksForQuads,
} from "./project-search-chunks.ts";
import { quadFromPayloadJson } from "@/sqlite/rdfjs-store/sqlite-store.ts";
import {
  buildMatchQuadsQuery,
  DEFAULT_SQLITE_MATCH_PAGE_SIZE,
} from "@/sqlite/quad-store/sqlite-quad-query-builder.ts";

/** RebuildSqliteSearchIndexFromQuadsResult reports how many quads and chunk rows were processed. */
export interface RebuildSqliteSearchIndexFromQuadsResult {
  /** processedQuadCount is the number of quads read from durable storage. */
  processedQuadCount: number;
  /** chunkRowCount is the number of chunk rows written to FTS/vector tables. */
  chunkRowCount: number;
}

/** ReadProjectSearchChunksOptions extends projection options with paging. */
export interface ReadProjectSearchChunksOptions
  extends ProjectSearchChunksOptions {
  readPageSize?: number;
}

/**
 * rebuildSqliteSearchIndexFromQuads rebuilds FTS and vector chunk rows from
 * the `quads` table without re-importing graph data (keyset-paged over the
 * composite primary key).
 *
 * Use after schema upgrades, label predicate changes, or discovery-index
 * tuning so existing corpora pick up refreshed `fts_value` and vectors.
 */
export async function rebuildSqliteSearchIndexFromQuads(
  options: ReadProjectSearchChunksOptions,
): Promise<RebuildSqliteSearchIndexFromQuadsResult> {
  const {
    connection,
    include,
    exclude,
    readPageSize,
  } = options;
  const pageSize = Math.max(
    1,
    Math.floor(readPageSize ?? DEFAULT_SQLITE_MATCH_PAGE_SIZE),
  );
  const matcher = filterQuads({ include, exclude });

  let processedQuadCount = 0;
  let chunkRowCount = 0;
  let afterKey: [string, string, string, string] | undefined;

  for (;;) {
    const query = buildMatchQuadsQuery(
      { subject: null, predicate: null, object: null, graph: null },
      { afterKey, limit: pageSize },
    );
    const resultSet = await connection.execute(query);

    if (resultSet.rows.length === 0) {
      break;
    }

    const pageQuads: rdfjs.Quad[] = [];
    for (const row of resultSet.rows) {
      afterKey = [
        String(row.skey),
        String(row.pkey),
        String(row.okey),
        String(row.gkey),
      ];
      try {
        const reconstructedQuad = quadFromPayloadJson(String(row.payload));
        if (matcher(reconstructedQuad)) {
          pageQuads.push(reconstructedQuad);
        }
        processedQuadCount++;
      } catch (error) {
        console.warn(
          `rebuildSqliteSearchIndexFromQuads: skipping corrupt row s="${row.skey}"`,
          error,
        );
      }
    }

    if (pageQuads.length > 0) {
      chunkRowCount += await refreshSearchChunksForQuads(pageQuads, options);
    }

    if (resultSet.rows.length < pageSize) {
      break;
    }
  }

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
