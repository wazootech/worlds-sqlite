import type { ChunkRowPayload } from "@worlds/sdk/search-index/quad-chunker";
import type { ProjectSearchChunksOptions } from "./project-search-chunks-options.ts";

/**
 * embedChunkTexts embeds the unique chunk texts and returns a text -> vector
 * lookup, or undefined when embedding is skipped (no service, or vec0 absent).
 */
export async function embedChunkTexts(
  chunksWithFtsValue: Array<{ chunk: ChunkRowPayload; fts_value: string }>,
  options: ProjectSearchChunksOptions,
): Promise<Map<string, Float32Array | number[]> | undefined> {
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

  return vectorLookupMap;
}
