import type { ChunkRowPayload } from "@worlds/sdk/search-index/quad-chunker";

/**
 * buildChunkFtsValue returns the exact text indexed for FTS and semantic
 * search: the chunk's own object-derived value text, and nothing else.
 *
 * Search surface contract (parity #22): keyword search matches object literal
 * text only. Subject IRIs, predicate IRIs, and subject label aliases are never
 * searchable — mirroring the reference `RdfjsSearchIndex` shape so identical
 * worlds produce identical search result sets across backends.
 */
export function buildChunkFtsValue(chunk: ChunkRowPayload): string {
  return chunk.value;
}
