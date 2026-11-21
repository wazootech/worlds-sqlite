import type * as rdfjs from "@rdfjs/types";
import { filterQuads, type QuadFilter } from "@worlds/sdk/quad-store";
import {
  DEFAULT_MAX_ATOMIC_STATEMENTS,
  DEFAULT_WRITE_BATCH_SIZE,
  type SqlCommitDriver,
} from "@/sql-core/mod.ts";
import type {
  SqliteConnectionDriver,
  SqlStatement,
} from "@/sqlite/sqlite-connection-driver.ts";
import { quadFromPayloadJson } from "@/sqlite/rdfjs-store/sqlite-store.ts";
import {
  buildMatchQuadsQuery,
  buildSelectExistingQuadKeys,
  type QuadKey,
} from "@/sqlite/quad-store/sqlite-quad-query-builder.ts";

/** SqliteCommitDriverOptions configures the sqlite execution surface. */
export interface SqliteCommitDriverOptions {
  /** connection is the SqliteConnectionDriver wrapping the SQLite handle. */
  connection: SqliteConnectionDriver;

  /** keys maps each key string the dialect produced back to its composite QuadKey. */
  keys: Map<string, QuadKey>;

  /** lookupChunkSize caps the IN-clause width of a presence lookup. */
  lookupChunkSize: number;

  /** filter limits a full rebuild to matching quads. */
  filter?: QuadFilter;

  /** onScanned receives the number of stored quads each rebuild page read. */
  onScanned?: (count: number) => void;
}

/**
 * createSqliteCommitDriver is the sqlite SqlCommitDriver: `connection.batch` is
 * one BEGIN IMMEDIATE transaction, so a commit up to the shared atomic limit
 * lands (or rolls back) as a whole, quads and chunks together.
 */
export function createSqliteCommitDriver(
  options: SqliteCommitDriverOptions,
): SqlCommitDriver<SqlStatement> {
  const { connection, keys, lookupChunkSize } = options;
  const matcher = filterQuads(options.filter ?? {});
  return {
    maxAtomicStatements: DEFAULT_MAX_ATOMIC_STATEMENTS,
    writeBatchSize: DEFAULT_WRITE_BATCH_SIZE,
    executeBatch: (statements) => connection.batch(statements),
    async lookupExisting(keyStrings) {
      const existing = new Set<string>();
      for (let at = 0; at < keyStrings.length; at += lookupChunkSize) {
        const chunk = keyStrings.slice(at, at + lookupChunkSize);
        const { rows } = await connection.execute(
          buildSelectExistingQuadKeys(chunk.map((key) => keys.get(key)!)),
        );
        for (const row of rows) {
          existing.add(
            [row.skey, row.pkey, row.okey, row.gkey].map(String).join("\u0000"),
          );
        }
      }
      return existing;
    },
    async streamQuads({ after, pageSize }) {
      const { rows } = await connection.execute(
        buildMatchQuadsQuery(
          { subject: null, predicate: null, object: null, graph: null },
          { afterKey: after as QuadKey | undefined, limit: pageSize },
        ),
      );
      const quads: rdfjs.Quad[] = [];
      for (const row of rows) {
        try {
          const quad = quadFromPayloadJson(String(row.payload));
          if (matcher(quad)) quads.push(quad);
        } catch (error) {
          console.warn(
            `sqlite rebuild: skipping corrupt row s="${row.skey}"`,
            error,
          );
        }
      }
      options.onScanned?.(rows.length);
      const last = rows.at(-1);
      const next = rows.length < pageSize || !last
        ? undefined
        : [last.skey, last.pkey, last.okey, last.gkey].map(String);
      return { quads, next };
    },
  };
}
