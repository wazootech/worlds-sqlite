import type * as rdfjs from "@rdfjs/types";
import type {
  ExportRequest,
  ExportResponse,
  ImportRequest,
  QuadStoreInterface,
} from "@worlds/sdk/quad-store";
import {
  exportFromRdfjsStore,
  importViaTransaction,
  Transaction,
} from "@worlds/sdk/quad-store";
import type { SearchIndexOnImport } from "@worlds/sdk/search-index";
import { commitSqlPatch } from "@/sql-core/mod.ts";
import type { SqliteStore } from "../rdfjs-store/sqlite-store.ts";
import {
  createSqliteCommit,
  type SqliteCommitCoreOptions,
} from "../commit/create-sqlite-commit.ts";

/** SqliteQuadStoreOptions configures the sqlite quad store. */
export interface SqliteQuadStoreOptions extends SqliteCommitCoreOptions {
  /** store is the underlying SQLite RDF/JS read store (the L1 SqliteStore). */
  store: SqliteStore;

  /**
   * searchIndexOnImport controls when FTS/vector chunk projection runs during
   * import: "incremental" (default), "deferred" (one rebuild pass after the
   * import), or "disabled".
   */
  searchIndexOnImport?: SearchIndexOnImport;
}

/**
 * SqliteQuadStore implements the QuadStoreInterface for the sqlite L2
 * surface: every commit runs the shared commitSqlPatch, so quads, search
 * chunks and a replace-import wipe land in one atomic transaction (an
 * embedding failure throws before anything is written), and reads go through
 * the shared L1 SqliteStore.
 */
export class SqliteQuadStore implements QuadStoreInterface {
  public constructor(private readonly options: SqliteQuadStoreOptions) {}

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
   * createTransaction returns a Transaction whose commit hook is the shared
   * commitSqlPatch over the sqlite driver and dialect.
   */
  public createTransaction(): Transaction {
    return new Transaction({
      commit: async (patch, context) => {
        const { driver, dialect, projection, filter } = createSqliteCommit(
          this.options,
        );
        await commitSqlPatch(patch, context, driver, dialect, {
          filter,
          projection,
          searchIndexOnImport: this.options.searchIndexOnImport,
        });
      },
    });
  }
}
