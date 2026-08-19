import { DataFactory } from "n3";
import type { Quad } from "@rdfjs/types";

const { quad, namedNode, literal } = DataFactory;

/**
 * SYNTHETIC_CORPUS_VERSION bumps when generateSyntheticQuads output changes; invalidates bench DB cache manifests.
 */
export const SYNTHETIC_CORPUS_VERSION = 1;

/**
 * generateSyntheticQuads yields a deterministic set of RDF quads tailored for scientific repeatability.
 * Each quad contains a descriptive literal optimized for text splitting and indexing benchmarks.
 *
 * @param count The precise number of quads to generate.
 * @returns Array of populated RDF quads.
 */
export function generateSyntheticQuads(count: number): Quad[] {
  const syntheticQuads: Quad[] = [];
  for (let index = 0; index < count; index++) {
    syntheticQuads.push(
      quad(
        namedNode(`urn:entity:${index}`),
        namedNode(`urn:property:${index % 10}`),
        literal(
          `This is synthetic data entry number ${index}. It contains enough words to provide a realistic payload for text splitters and vector encoders. Every system should process this reliably. Sequential verification token: SYNT-${index}.`,
        ),
      ),
    );
  }

  return syntheticQuads;
}
