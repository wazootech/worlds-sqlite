import type { SqliteConnectionDriver } from "@/sqlite/sqlite-connection-driver.ts";
import type { SqliteSearchQueryBuilder } from "./sqlite-search-query-builder.ts";

/** InsertChunkRowOptions describes one directly-inserted search chunk row. */
export interface InsertChunkRowOptions {
  quad_id: string;
  subject: string;
  predicate: string;
  graph: string;
  value: string;
  /** vector is the optional embedding value (first element used, then zeros). */
  vector?: number[];
}

/** testVectorDimensions matches the shared 32-dim test builders. */
const TEST_VECTOR_DIMENSIONS = 32;

/**
 * insertChunkRowForTest inserts a chunks row (with FTS sync via trigger) and,
 * when a vector is supplied, the paired chunks_vec row — the sqlite mirror of
 * the libsql tests' direct `INSERT INTO chunks ... vector32(?)` fixtures.
 */
export async function insertChunkRowForTest(
  connection: SqliteConnectionDriver,
  queryBuilder: SqliteSearchQueryBuilder,
  options: InsertChunkRowOptions,
): Promise<void> {
  const insertStatement = queryBuilder.buildInsertChunk({
    quad_id: options.quad_id,
    subject: options.subject,
    predicate: options.predicate,
    graph: options.graph,
    value: options.value,
    fts_value: options.value,
  });
  const resultSet = await connection.execute<{ id: number | bigint }>(
    insertStatement,
  );
  const chunkId = resultSet.rows[0]?.id;

  if (options.vector && chunkId != null) {
    const padded = new Array(TEST_VECTOR_DIMENSIONS).fill(0);
    for (let index = 0; index < options.vector.length; index++) {
      padded[index] = options.vector[index]!;
    }
    await connection.execute(
      queryBuilder.buildInsertVecChunk({
        chunkId: BigInt(chunkId),
        vectorJson: JSON.stringify(padded),
      }),
    );
  }
}
