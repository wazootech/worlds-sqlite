import type * as rdfjs from "@rdfjs/types";
import type { EmbeddedChunk } from "@worlds/sdk/search-index/quad-chunker";
import type { SqlDialect } from "@/sql-core/mod.ts";

/** FakeStatement is the statement type of the in-memory fake backend. */
export type FakeStatement =
  | { kind: "wipe" }
  | { kind: "clearChunks" }
  | { kind: "delete"; keys: string[]; hashes: string[] }
  | { kind: "insert"; key: string; quad: rdfjs.Quad; hash: string }
  | { kind: "chunk"; quadId: string; text: string; vectorized: boolean }
  | { kind: "cleanup"; keys: string[]; hashes: string[] };

/** createFakeDialect builds the fake backend's statements; `keyPrefix` makes keys differ from content hashes. */
export function createFakeDialect(
  keyPrefix: string,
): SqlDialect<FakeStatement> {
  return {
    keyOf: (_quad, hash) => keyPrefix + hash,
    buildWipe: () => [{ kind: "wipe" }],
    buildClearChunks: () => [{ kind: "clearChunks" }],
    buildDeletions: (keys, hashes) => [{ kind: "delete", keys, hashes }],
    buildInserts: (quads, keys, hashes) =>
      quads.map((quad, i) => ({
        kind: "insert" as const,
        key: keys[i]!,
        quad,
        hash: hashes[i]!,
      })),
    buildChunkRows: (rows: EmbeddedChunk[]) =>
      rows.map((row) => ({
        kind: "chunk" as const,
        quadId: row.chunk.quad_id,
        text: row.ftsValue,
        vectorized: row.vector !== undefined,
      })),
    buildCleanup: (keys, hashes) => [{ kind: "cleanup", keys, hashes }],
  };
}
