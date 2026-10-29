import type { ChunkRowPayload } from "@worlds/sdk/search-index/quad-chunker";
import { chunkQuads } from "@worlds/sdk/search-index/quad-chunker";
import type * as rdfjs from "@rdfjs/types";
import { SqliteBatchExecutor } from "@/sqlite/sqlite-batch-executor.ts";
import type { SqlStatement } from "@/sqlite/sqlite-connection-driver.ts";
import type { SqliteSearchQueryBuilder } from "./sqlite-search-query-builder.ts";
import { buildChunkFtsValue } from "@/sql-core/mod.ts";
import type { ProjectSearchChunksOptions } from "./project-search-chunks-options.ts";
import { embedChunkTexts } from "./project-search-chunks-embed.ts";

/** flushVecStatements stages and flushes vec/delete statements on one executor. */
export async function flushVecStatements(
  options: ProjectSearchChunksOptions,
  statements: SqlStatement[],
): Promise<void> {
  if (statements.length === 0) {
    return;
  }
  try {
    const executor = new SqliteBatchExecutor({
      connection: options.connection,
    });
    await executor.stage(statements);
    await executor.flush();
  } catch (cause) {
    throw new Error("failed to execute search chunk sync batch", { cause });
  }
}

export function buildChunkDeletionStatementsChunked(
  quadIds: string[],
  queryBuilder: SqliteSearchQueryBuilder,
  chunkSize: number,
): SqlStatement[] {
  const statements: SqlStatement[] = [];
  for (let index = 0; index < quadIds.length; index += chunkSize) {
    const quadIdBatch = quadIds.slice(index, index + chunkSize);
    statements.push(...queryBuilder.buildDeleteByQuadIds(quadIdBatch));
  }
  return statements;
}

/** ProjectChunksResult reports chunk rows written and pending vec inserts. */
interface ProjectChunksResult {
  /** chunkRowCount is the number of chunk rows inserted. */
  chunkRowCount: number;
  /** vecStatements are staged chunks_vec inserts keyed by fresh chunk rowids. */
  vecStatements: SqlStatement[];
}

export async function projectChunks(
  quads: rdfjs.Quad[],
  quadIds: string[],
  options: ProjectSearchChunksOptions,
): Promise<ProjectChunksResult> {
  const vecStatements: SqlStatement[] = [];

  const textSplitter = options.textSplitter;
  if (!textSplitter) {
    throw new Error(
      "projectSearchChunks requires textSplitter in ProjectSearchChunksOptions",
    );
  }

  let chunks: ChunkRowPayload[];
  try {
    chunks = await chunkQuads(quads, textSplitter, quadIds);
  } catch (cause) {
    throw new Error("failed to chunk novel textual facts", { cause });
  }

  if (chunks.length === 0) {
    return { chunkRowCount: 0, vecStatements };
  }

  const chunksWithFtsValue = chunks.map((chunk) => ({
    chunk,
    fts_value: buildChunkFtsValue(chunk),
  }));

  const vectorLookupMap = await embedChunkTexts(
    chunksWithFtsValue,
    options,
  );

  for (const { chunk, fts_value } of chunksWithFtsValue) {
    const insertStatement = options.searchQueryBuilder.buildInsertChunk({
      quad_id: chunk.quad_id,
      subject: chunk.subject,
      predicate: chunk.predicate,
      graph: chunk.graph,
      value: chunk.value,
      fts_value,
    });
    const resultSet = await options.connection.execute<{ id: number | bigint }>(
      insertStatement,
    );
    const chunkId = resultSet.rows[0]?.id;

    const vector = vectorLookupMap?.get(fts_value);
    if (vector && chunkId != null) {
      vecStatements.push(
        options.searchQueryBuilder.buildInsertVecChunk({
          chunkId: BigInt(chunkId),
          vectorJson: JSON.stringify(Array.from(vector)),
        }),
      );
    }
  }

  return { chunkRowCount: chunksWithFtsValue.length, vecStatements };
}
