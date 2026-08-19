import type {
  ChunkRowPayload,
  TextSplitterInterface,
} from "@worlds/sdk/search-index/quad-chunker";
import { chunkQuads } from "@worlds/sdk/search-index/quad-chunker";
import type { EmbeddingService } from "@worlds/sdk/search-index/embedding-service";
import type { QuadFilter } from "@worlds/sdk/quad-store";
import { hashQuads } from "@worlds/sdk/quad-store";
import type * as rdfjs from "@rdfjs/types";
import { SqliteBatchExecutor } from "@/sqlite/sqlite-batch-executor.ts";
import type { SqliteConnectionDriver } from "@/sqlite/sqlite-connection-driver.ts";
import type { SqlStatement } from "@/sqlite/sqlite-connection-driver.ts";
import type { SqliteSearchQueryBuilder } from "./sqlite-search-query-builder.ts";
import { buildChunkFtsValue } from "./search-chunk-fts.ts";

/** ProjectSearchChunksOptions configures search chunk projection. */
export interface ProjectSearchChunksOptions extends QuadFilter {
  /** connection is the SqliteConnectionDriver wrapping the SQLite handle. */
  connection: SqliteConnectionDriver;

  /** textSplitter splits long literal values into chunk rows (required for projection/rebuild). */
  textSplitter?: TextSplitterInterface;

  /** maxLookupChunkSize caps IN-clause widths (default 800). */
  maxLookupChunkSize?: number;

  /** searchQueryBuilder supplies dimension-aware chunk/vec SQL. */
  searchQueryBuilder: SqliteSearchQueryBuilder;

  /** embeddingService optionally projects chunk text into comparison vectors. */
  embeddingService?: EmbeddingService;
}

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

/** flushVecStatements stages and flushes vec/delete statements on one executor. */
async function flushVecStatements(
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

function buildChunkDeletionStatementsChunked(
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

async function projectChunks(
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

  let vectorLookupMap: Map<string, Float32Array | number[]> | undefined;

  // Keyword-only degradation: never call the embedding service when the vec0
  // table does not exist — there is nowhere to store the vectors.
  if (options.embeddingService && options.searchQueryBuilder.vectorSupported) {
    const uniqueTexts = Array.from(
      new Set(
        chunksWithFtsValue.flatMap(({ chunk, fts_value }) => [
          fts_value,
          chunk.value,
        ]),
      ),
    );
    let uniqueVectors: Array<Float32Array | number[]>;
    try {
      uniqueVectors = await options.embeddingService.embed(uniqueTexts);
      for (const projectedVector of uniqueVectors) {
        const embeddingLength = projectedVector.length;
        if (
          embeddingLength !== options.searchQueryBuilder.vectorDimensions
        ) {
          throw new Error(
            `embedding length ${embeddingLength} does not match configured vectorDimensions ${options.searchQueryBuilder.vectorDimensions}`,
          );
        }
      }
    } catch (cause) {
      throw new Error("failed to vectorize literal chunk blocks", { cause });
    }

    vectorLookupMap = new Map<string, Float32Array | number[]>();
    for (let textIndex = 0; textIndex < uniqueTexts.length; textIndex++) {
      vectorLookupMap.set(uniqueTexts[textIndex], uniqueVectors[textIndex]!);
    }
  }

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
