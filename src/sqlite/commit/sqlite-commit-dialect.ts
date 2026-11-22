import type { EmbeddedChunk } from "@worlds/sdk/search-index/quad-chunker";
import type { SqlDialect } from "@/sql-core/mod.ts";
import type { SqlStatement } from "@/sqlite/sqlite-connection-driver.ts";
import type { SqliteSearchQueryBuilder } from "@/sqlite/search-index/sqlite-search-query-builder.ts";
import { quadToPayloadJson } from "@/sqlite/rdfjs-store/sqlite-store.ts";
import {
  buildBulkInsertQuads,
  buildDeleteQuadsByQuadKeys,
  buildWipeAllGraphDataStatements,
  type QuadKey,
  quadKeyFor,
  quadKeyString,
} from "@/sqlite/quad-store/sqlite-quad-query-builder.ts";

/** SqliteCommitDialectOptions configures the sqlite statement builders. */
export interface SqliteCommitDialectOptions {
  /** searchQueryBuilder supplies the chunk and vec statements. */
  searchQueryBuilder: SqliteSearchQueryBuilder;

  /** keys maps each key string `keyOf` produced back to its composite QuadKey. */
  keys: Map<string, QuadKey>;

  /** lookupChunkSize caps the keys per deletion statement. */
  lookupChunkSize: number;
}

/**
 * createSqliteCommitDialect builds the SqlDialect for the term-keyed `quads`
 * table and the `chunks` / `chunks_vec` search tables. A quad's identity is its
 * composite term key; chunk rows are swept by the quad's content hash.
 */
export function createSqliteCommitDialect(
  options: SqliteCommitDialectOptions,
): SqlDialect<SqlStatement> {
  const { searchQueryBuilder: builder, keys, lookupChunkSize } = options;

  const buildDeletions = (
    keyStrings: string[],
    hashes: string[],
  ): SqlStatement[] => {
    const statements: SqlStatement[] = [];
    for (let at = 0; at < keyStrings.length; at += lookupChunkSize) {
      const end = at + lookupChunkSize;
      statements.push(
        ...builder.buildDeleteByQuadIds(hashes.slice(at, end)),
        buildDeleteQuadsByQuadKeys(
          keyStrings.slice(at, end).map((key) => keys.get(key)!),
        ),
      );
    }
    return statements;
  };

  return {
    keyOf: (quad) => {
      const key = quadKeyFor(quad);
      const keyString = quadKeyString(key);
      keys.set(keyString, key);
      return keyString;
    },
    buildWipe: () =>
      buildWipeAllGraphDataStatements({
        vectorSupported: builder.vectorSupported,
      }),
    buildClearChunks: () => builder.buildClearChunks(),
    buildDeleteChunks: (hashes) => {
      const statements: SqlStatement[] = [];
      for (let at = 0; at < hashes.length; at += lookupChunkSize) {
        statements.push(
          ...builder.buildDeleteByQuadIds(
            hashes.slice(at, at + lookupChunkSize),
          ),
        );
      }
      return statements;
    },
    buildDeletions,
    buildInserts: (quads, keyStrings) =>
      buildBulkInsertQuads(
        quads.map((quad, i) => ({
          key: keys.get(keyStrings[i]!)!,
          payload: quadToPayloadJson(quad),
        })),
      ),
    buildChunkRows: (rows: EmbeddedChunk[]) =>
      rows.flatMap(({ chunk, ftsValue, vector }) => [
        builder.buildInsertChunk({
          quad_id: chunk.quad_id,
          subject: chunk.subject,
          predicate: chunk.predicate,
          graph: chunk.graph,
          value: chunk.value,
          fts_value: ftsValue,
        }),
        // The vec row pairs with the chunk row inserted just before it.
        ...(vector
          ? [builder.buildInsertVecForLastChunk(
            JSON.stringify(Array.from(vector)),
          )]
          : []),
      ]),
    buildCleanup: buildDeletions,
  };
}
