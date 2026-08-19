import type * as rdfjs from "@rdfjs/types";
import type {
  ExportRequest,
  ExportResponse,
  ImportRequest,
  QuadFilter,
  QuadStoreInterface,
} from "@worlds/sdk/quad-store";
import {
  exportFromRdfjsStore,
  hashQuads,
  importViaTransaction,
  Transaction,
} from "@worlds/sdk/quad-store";
import type { SqliteConnectionDriver } from "../sqlite-connection-driver.ts";
import { SqliteBatchExecutor } from "../sqlite-batch-executor.ts";
import type { SqliteStore } from "../rdfjs-store/sqlite-store.ts";
import type { SqliteSearchQueryBuilder } from "../search-index/sqlite-search-query-builder.ts";
import type { SqliteSearchIndexProjector } from "../search-index/mod.ts";
import {
  commitPatchToSqlite,
  stageDeletionStatementsChunked,
} from "../commit-patch-to-sqlite.ts";
import { quadKeyFor } from "./sqlite-quad-query-builder.ts";
import type { QuadKey } from "./sqlite-quad-query-builder.ts";

/** SqliteQuadStoreOptions configures the sqlite quad store. */
export interface SqliteQuadStoreOptions extends QuadFilter {
  /** connection is the SqliteConnectionDriver wrapping the SQLite handle. */
  connection: SqliteConnectionDriver;

  /** store is the underlying SQLite RDF/JS read store (the L1 SqliteStore). */
  store: SqliteStore;

  /** searchQueryBuilder supplies dimension-aware SQL for deletions and chunk replication. */
  searchQueryBuilder: SqliteSearchQueryBuilder;

  /** searchIndexProjector manages vector embedding and text chunk synchronisation. */
  searchIndexProjector?: SqliteSearchIndexProjector;

  /** maxWriteBatchSize caps how many statements are sent per SQLite write batch. Defaults to 500. */
  maxWriteBatchSize?: number;

  /** maxLookupChunkSize caps IN-clause widths. Defaults to 800. */
  maxLookupChunkSize?: number;

  /**
   * searchIndexOnImport controls when FTS/vector chunk projection runs during
   * import: "incremental" (default), "deferred" (one rebuild pass after the
   * import), or "disabled".
   */
  searchIndexOnImport?: "incremental" | "deferred" | "disabled";
}

/**
 * SqliteQuadStore implements the QuadStoreInterface for the sqlite L2
 * surface: durable quads through commitPatchToSqlite with search-chunk
 * projection on commit, reads through the shared L1 SqliteStore.
 */
export class SqliteQuadStore implements QuadStoreInterface {
  public constructor(
    private readonly options: SqliteQuadStoreOptions,
  ) {}

  /**
   * import merges or replaces the underlying store with provided RDF source
   * data.
   */
  public async import(request: ImportRequest): Promise<void> {
    await importViaTransaction(request, {
      createTransaction: () => this.createTransaction(),
    });
  }

  /**
   * export extracts the graph contents in raw quads or serialized formats.
   */
  public async export(request: ExportRequest): Promise<ExportResponse> {
    return await exportFromRdfjsStore(
      this.options.store as unknown as rdfjs.Store,
      request,
    );
  }

  /**
   * createTransaction returns a pre-configured Transaction bound to internal
   * commit hooks (commitPatchToSqlite + search projection).
   */
  public createTransaction(): Transaction {
    return new Transaction({
      commit: async (patch, context) => {
        const isImport = context?.importMode !== undefined;
        const searchIndexOnImport = this.options.searchIndexOnImport ??
          "incremental";
        const skipSearchIndexProjection =
          this.options.searchIndexOnImport === "disabled" ||
          (isImport && searchIndexOnImport === "deferred");

        const { novelInsertions, novelQuadIds } = await commitPatchToSqlite(
          patch,
          this.options,
          context,
        );

        if (!skipSearchIndexProjection && this.options.searchIndexProjector) {
          try {
            await this.options.searchIndexProjector.projectNovelQuads(
              novelInsertions,
              novelQuadIds,
            );
          } catch (error) {
            // Clean up persisted quads if search projection fails.
            await this.rollbackNovelQuads(novelInsertions);
            throw error;
          }
        }

        if (
          isImport && searchIndexOnImport === "deferred" &&
          this.options.searchIndexProjector
        ) {
          await this.options.searchIndexProjector.reindexAll();
        }
      },
    });
  }

  /** rollbackNovelQuads deletes search chunks and durable quads for a failed projection. */
  private async rollbackNovelQuads(
    novelInsertions: rdfjs.Quad[],
  ): Promise<void> {
    if (novelInsertions.length === 0) {
      return;
    }
    const connection = this.options.connection;
    const batchExecutor = new SqliteBatchExecutor({
      connection,
      writeBatchSize: this.options.maxWriteBatchSize ?? 500,
    });
    const quadKeys: QuadKey[] = novelInsertions.map(quadKeyFor);
    const quadIds = await hashQuads(novelInsertions);
    await stageDeletionStatementsChunked(
      batchExecutor,
      quadKeys,
      quadIds,
      this.options.searchQueryBuilder,
      this.options.maxLookupChunkSize ?? 800,
    );
    await batchExecutor.flush();
  }
}
