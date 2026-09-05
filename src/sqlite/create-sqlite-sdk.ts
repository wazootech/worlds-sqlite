import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import type * as rdfjs from "@rdfjs/types";
import type { QuadCriteria, WorldsSdkInterface } from "@worlds/sdk";
import { WorldsSdk } from "@worlds/sdk";
import type { SearchIndexOnImport } from "@worlds/sdk/search-index";
import type { EmbeddingService } from "@worlds/sdk/search-index/embedding-service";
import type { TextSplitterInterface } from "@worlds/sdk/search-index/quad-chunker";
import { WazooSparqlEngine } from "@wazoo/sparql-engine";
import type {
  AnySyncSqliteHandle,
  SyncSqliteHandleFactory,
} from "./any-sync-sqlite-handle.ts";
import { SqliteConnectionDriver } from "./sqlite-connection-driver.ts";
import { initializeSqliteSchema } from "./initialize-sqlite-schema.ts";
import { SqliteSchemaBuilder } from "./schema/sqlite-schema-builder.ts";
import { SqliteSearchQueryBuilder } from "./search-index/sqlite-search-query-builder.ts";
import {
  SqliteSearchIndex,
  SqliteSearchIndexProjector,
} from "./search-index/mod.ts";
import { SqliteQuadStore } from "./quad-store/mod.ts";
import { SqliteStore } from "./rdfjs-store/mod.ts";

/**
 * SqliteWorldsSdkOptions configures sqlite execution through SqliteStore and the
 * materialized quad/search indexes.
 */
export interface SqliteWorldsSdkOptions {
  /** path is the SQLite database file path, or ":memory:" for a temp database. */
  path: string;

  /**
   * db adopts an existing synchronous SQLite handle instead of opening one
   * from `path` (path is then ignored): a node:sqlite DatabaseSync, a
   * bun:sqlite Database, or any other AnySyncSqliteHandle. The SDK owns the
   * handle it uses and close() releases it. Useful for sharing one handle
   * across the SDK and raw connection access in tests/benches, and for Bun
   * callers passing `new Database(path)` from bun:sqlite (mirrors
   * createLibsqlSdk accepting a pre-created client).
   */
  db?: AnySyncSqliteHandle;

  /**
   * createHandle supplies the default handle when `db` is absent — the
   * injectable construction seam. Defaults to opening a node:sqlite
   * DatabaseSync for `path` with allowExtension; Bun callers can pass a
   * factory over bun:sqlite's Database instead. The factory constructs at
   * most one handle, shared across the connection, store, and search layers.
   */
  createHandle?: SyncSqliteHandleFactory;

  /** embeddingService is an optional service projecting text literals into comparison vectors. */
  embeddingService?: EmbeddingService;

  /** textSplitter is an optional custom text splitter; defaults to a 1000-char character splitter. */
  textSplitter?: TextSplitterInterface;

  /** maxLookupChunkSize caps IN-clause widths (default 800). */
  maxLookupChunkSize?: number;

  /**
   * vectorDimensions pins the vec0 embedding width and must match every
   * embedding produced when embeddingService is set (default 1536).
   */
  vectorDimensions?: number;

  /** matchPageSize limits rows per SqliteStore.match SQL round-trip (default 1000). */
  matchPageSize?: number;

  /**
   * searchIndexOnImport controls when FTS/vector chunk projection runs during
   * import ("incremental" default, "deferred", or "disabled").
   */
  searchIndexOnImport?: SearchIndexOnImport;

  /**
   * loadVectorExtension attempts to load the bundled sqlite-vec extension
   * (default true). On failure — or when set to false — search degrades to
   * keyword-only FTS5 and no vec tables are created.
   */
  loadVectorExtension?: boolean;

  /** include limits ingested/projected facts to matching subjects/predicates/graphs. */
  include?: QuadCriteria;

  /** exclude rejects facts matching any declared subject/predicate/graph. */
  exclude?: QuadCriteria;
}

/**
 * SqliteWorldsSdk is the WorldsSdkInterface surface plus ownership of the underlying
 * database handle: call close() to release the file/`:memory:` database.
 */
export type SqliteWorldsSdk = WorldsSdkInterface & { close(): void };

/**
 * createSqliteWorldsSdk synthesizes a WorldsSdk for the sqlite L2 surface over one shared
 * synchronous SQLite handle (node:sqlite DatabaseSync by default, or any
 * AnySyncSqliteHandle — e.g. a bun:sqlite Database — via `db` / `createHandle`).
 *
 * The factory assembles the strategy objects internally: a
 * SqliteConnectionDriver over the handle, a SqliteSchemaBuilder, a
 * SqliteSearchQueryBuilder (FTS5 keyword + optional sqlite-vec vector, JS-side
 * RRF), and a SqliteStore read path — mirroring createLibsqlSdk from
 * @worlds/libsql. When the sqlite-vec extension cannot be loaded, the whole
 * vector surface degrades to keyword-only.
 */
export async function createSqliteWorldsSdk(
  options: SqliteWorldsSdkOptions,
): Promise<SqliteWorldsSdk> {
  const vectorDimensions = options.vectorDimensions ?? 1536;
  const db = options.db ??
    (options.createHandle
      ? options.createHandle(options.path)
      : (await import("./node-sqlite-handle.ts")).createNodeSqliteHandle(
        options.path,
        { allowExtension: true },
      ));

  let vectorSupported = false;
  if (options.loadVectorExtension !== false) {
    try {
      // sqlite-vec ships platform prebuilt binaries as optional dependencies;
      // load() calls handle.loadExtension with the right path. The cast keeps
      // sqlite-vec's structural Db (loadExtension required) compatible with
      // the wider AnySyncSqliteHandle surface.
      const { load } = await import("sqlite-vec");
      load(db as Parameters<typeof load>[0]);
      vectorSupported = true;
    } catch (error) {
      console.warn(
        `[Sqlite Warning] sqlite-vec extension unavailable; degrading to keyword-only search. Reason: ${
          (error as Error).message
        }`,
      );
    }
  }

  const connection = new SqliteConnectionDriver(db, { vectorSupported });
  const schema = new SqliteSchemaBuilder(vectorDimensions, {
    vectorSupported,
  });
  const searchQuery = new SqliteSearchQueryBuilder(vectorDimensions, {
    vectorSupported,
  });

  await initializeSqliteSchema(connection, schema);

  const textSplitter = options.textSplitter ??
    new RecursiveCharacterTextSplitter({ chunkSize: 1000 });

  const searchIndex = new SqliteSearchIndex({
    ...options,
    connection,
    searchQueryBuilder: searchQuery,
    textSplitter,
  });

  const searchIndexProjector = new SqliteSearchIndexProjector({
    ...options,
    connection,
    searchQueryBuilder: searchQuery,
    textSplitter,
  });

  const store = new SqliteStore({
    path: options.path,
    db,
    matchPageSize: options.matchPageSize,
  });

  const quadStore = new SqliteQuadStore({
    ...options,
    connection,
    store,
    searchQueryBuilder: searchQuery,
    searchIndexProjector,
  });

  const sparqlEngine = new WazooSparqlEngine({
    store: store as unknown as rdfjs.Store,
    createTransaction: () => quadStore.createTransaction(),
  });

  const sdk = new WorldsSdk({
    quadStore,
    searchIndex,
    sparqlEngine,
  });

  return Object.assign(sdk, {
    close: (): void => {
      store.close();
    },
  });
}
