import type * as rdfjs from "@rdfjs/types";
import type { QuadFilter } from "@worlds/sdk/quad-store";
import type { SearchIndexOnImport } from "@worlds/sdk/search-index";
import type {
  ChunkAndEmbedOptions,
  EmbeddedChunk,
} from "@worlds/sdk/search-index/quad-chunker";

/** SqlQuadPage is one page of stored quads, in a stable order, for a full rebuild. */
export interface SqlQuadPage {
  /** quads are the quads on this page. */
  quads: rdfjs.Quad[];

  /** next is the cursor for the following page, or undefined after the last one. */
  next?: unknown;
}

/**
 * SqlCommitDriver is a backend's execution surface. The core never builds SQL
 * and never opens a connection: it hands the driver statements the dialect
 * built, in batches. `S` is the backend's statement type.
 */
export interface SqlCommitDriver<S> {
  /**
   * maxAtomicStatements is the most statements one commit may hold and still be
   * written as a single `executeBatch` call (with `maxBatchWeight`, it must also
   * fit that weight in the one batch). Larger commits take the chunked,
   * non-atomic fallback. Use 0 for a backend that cannot write a whole commit
   * atomically at all.
   */
  readonly maxAtomicStatements: number;

  /** writeBatchSize is the most statements per `executeBatch` call on the fallback path. */
  readonly writeBatchSize: number;
  /**
   * statementWeight estimates the cost of one statement in the unit
   * `maxBatchWeight` is expressed in (for D1, serialized bytes). Optional and
   * only used together with `maxBatchWeight`; a driver that sets one without the
   * other is treated as unweighted. It should be cheap, pure, and err high.
   */
  statementWeight?(statement: S): number;
  /**
   * maxBatchWeight is the most total `statementWeight` one `executeBatch` call
   * may carry, in addition to the statement-count limits. A commit is atomic
   * only if it fits in one batch under both; the fallback fills each batch up to
   * both, and a single statement over the budget goes alone in its own batch
   * (the driver then accepts or rejects it). Cleanup and rebuild batches obey it
   * too. Omit it for a backend with no byte-like limit.
   */
  readonly maxBatchWeight?: number;

  /**
   * executeBatch runs the statements as one unit: all of them apply or none do.
   * A rejection means nothing in this call was applied. Backends wrap their
   * transport errors here if they want a specific message.
   */
  executeBatch(statements: readonly S[]): Promise<void>;

  /** lookupExisting returns which of `keys` the store already holds; the backend chunks its own IN clauses. */
  lookupExisting(keys: string[]): Promise<Set<string>>;

  /** streamQuads returns one page of every stored quad, in a stable order. */
  streamQuads(
    request: { after?: unknown; pageSize: number },
  ): Promise<SqlQuadPage>;
}

/**
 * SqlDialect turns the core's decisions into the backend's statements. Table
 * layout, term keys, tenancy (`worldId`), vector columns, and inference live
 * here, never in the core.
 */
export interface SqlDialect<S> {
  /** keyOf is the identity the store recognises a quad by (the content hash for most backends). */
  keyOf(quad: rdfjs.Quad, hash: string): string;

  /** buildWipe removes every quad and chunk row, for a replace-mode import. */
  buildWipe(): S[];

  /** buildClearChunks removes every chunk row, at the start of a full rebuild. */
  buildClearChunks(): S[];

  /**
   * buildDeleteChunks removes the chunk rows of the quads with these content
   * hashes (a chunk's `quad_id`), leaving every other row. A scoped rebuild
   * needs it; a backend that omits it supports only the clear-all rebuild. The
   * backend chunks its own IN clauses.
   */
  buildDeleteChunks?(hashes: string[]): S[];

  /** buildDeletions removes the quads with these keys and their chunk rows. */
  buildDeletions(keys: string[], hashes: string[]): S[];

  /** buildInserts writes the novel quads. The three arrays are index for index. */
  buildInserts(quads: rdfjs.Quad[], keys: string[], hashes: string[]): S[];

  /** buildChunkRows writes the embedded chunk rows. */
  buildChunkRows(rows: EmbeddedChunk[]): S[];

  /** buildCleanup undoes a partial fallback write: it removes the novel quads (and chunks, as the backend sees fit). */
  buildCleanup(keys: string[], hashes: string[]): S[];
}

/** SqlProjectionOptions configures chunking and embedding; it is the SDK's ChunkAndEmbedOptions. */
export type SqlProjectionOptions = ChunkAndEmbedOptions;

/** SqlCommitSummary reports what one commit did. */
export interface SqlCommitSummary {
  /** novelQuads is how many quads were written. */
  novelQuads: number;

  /** chunkRows is how many chunk rows were written in the commit. */
  chunkRows: number;

  /** rebuilt is true when a deferred import ran a full search-index rebuild. */
  rebuilt: boolean;
}

/** SqlCommitOptions configures one backend's commit. Every field is optional. */
export interface SqlCommitOptions {
  /** filter is the include/exclude filter applied to both sides of a patch. */
  filter?: QuadFilter;

  /** searchIndexOnImport is the indexing mode; unset uses `defaultSearchIndexOnImport`. */
  searchIndexOnImport?: SearchIndexOnImport;

  /** defaultSearchIndexOnImport is the backend's default mode ("incremental" when omitted, including on D1). */
  defaultSearchIndexOnImport?: SearchIndexOnImport;

  /** projection enables chunk rows; without it no chunks are written or rebuilt. */
  projection?: SqlProjectionOptions;

  /** maxAtomicStatements lowers the driver's atomic limit for this commit. */
  maxAtomicStatements?: number;

  /** writeBatchSize lowers the driver's fallback batch size for this commit. */
  writeBatchSize?: number;

  /** rebuildPageSize is the quads per page of a full rebuild (default 500). */
  rebuildPageSize?: number;

  /**
   * afterWrite runs once the write is durable, outside any batch: for work that
   * cannot join it (an external vector index, derived data). A rejection rejects
   * the commit even though the write already landed, so handle recoverable
   * errors inside the hook.
   */
  afterWrite?: (summary: SqlCommitSummary) => Promise<void>;
}
