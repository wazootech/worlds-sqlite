import { hashQuads } from "@worlds/sdk/quad-store";
import type * as rdfjs from "@rdfjs/types";
import type { ProjectSearchChunksOptions } from "./project-search-chunks-options.ts";
import {
  buildChunkDeletionStatementsChunked,
  flushVecStatements,
  projectChunks,
} from "./project-search-chunks-write.ts";

export type { ProjectSearchChunksOptions } from "./project-search-chunks-options.ts";

/**
 * projectSearchChunks processes novel quads to create, embed, and store
 * FTS/vector chunks. Chunk rows are inserted individually (RETURNING the
 * rowid so the vec0 insert can pair with it); vec inserts are staged on the
 * batch executor and flushed once. When sqlite-vec is unavailable the
 * embedding service is never called — keyword-only degradation skips vector
 * work entirely.
 */
export async function projectSearchChunks(
  novelInsertions: rdfjs.Quad[],
  novelQuadIds: string[],
  options: ProjectSearchChunksOptions,
): Promise<void> {
  const { vecStatements } = await projectChunks(
    novelInsertions,
    novelQuadIds,
    options,
  );
  await flushVecStatements(options, vecStatements);
}

/**
 * refreshSearchChunksForQuads deletes existing chunk rows for the given quads
 * and rebuilds FTS/vector projections. Durable `quads` rows are not modified.
 * Returns the number of chunk rows written.
 *
 * Deletion runs in its own batch BEFORE the new chunk inserts: refresh
 * re-projects the same quad_ids, so inserting first would let the deletion
 * sweep the fresh rows.
 */
export async function refreshSearchChunksForQuads(
  quads: rdfjs.Quad[],
  options: ProjectSearchChunksOptions,
): Promise<number> {
  if (quads.length === 0) {
    return 0;
  }

  const lookupChunkSize = options.maxLookupChunkSize ?? 800;

  const quadIds = await hashQuads(quads);

  // Phase 1: sweep the old chunks (vec rows first, then chunks + FTS rows).
  await flushVecStatements(
    options,
    buildChunkDeletionStatementsChunked(
      quadIds,
      options.searchQueryBuilder,
      lookupChunkSize,
    ),
  );

  // Phase 2: project fresh chunk rows for the same quads.
  const { chunkRowCount, vecStatements } = await projectChunks(
    quads,
    quadIds,
    options,
  );
  await flushVecStatements(options, vecStatements);

  return chunkRowCount;
}
