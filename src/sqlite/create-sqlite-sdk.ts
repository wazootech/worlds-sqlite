import { DatabaseSync } from "node:sqlite";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import type * as rdfjs from "@rdfjs/types";
import type { QuadCriteria, SdkInterface } from "@worlds/sdk";
import { Sdk } from "@worlds/sdk";
import type { SearchIndexOnImport } from "@worlds/sdk/search-index";
import type { EmbeddingService } from "@worlds/sdk/search-index/embedding-service";
import type { TextSplitterInterface } from "@worlds/sdk/search-index/quad-chunker";
import { WazooSparqlEngine } from "@wazoo/sparql-engine";
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
 * SqliteSdkOptions configures sqlite execution through SqliteStore and the
 * materialized quad/search indexes.
 */
export interface SqliteSdkOptions {
  /** path is the SQLite database file path, or ":memory:" for a temp database. */
  path: string;

  /**
   * db adopts an existing node:sqlite handle instead of opening one from
   * `path` (path is then ignored). The SDK owns the handle it uses and close()
   * releases it. Useful for sharing one handle across the SDK and raw
   * connection access in tests/benches (mirrors createLibsqlSdk accepting a
   * pre-created client).
   */
  db?: DatabaseSync;

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
 * SqliteSdk is the SdkInterface surface plus ownership of the underlying
 * database handle: call close() to release the file/`:memory:` database.
 */
export type SqliteSdk = SdkInterface & { close(): void };

/**
 * createSqliteSdk synthesizes a Sdk for the sqlite L2 surface over one shared
 * node:sqlite handle.
 *
 * The factory assembles the strategy objects internally: a
 * SqliteConnectionDriver over the DatabaseSync, a SqliteSchemaBuilder, a
 * SqliteSearchQueryBuilder (FTS5 keyword + optional sqlite-vec vector, JS-side
 * RRF), and a SqliteStore read path — mirroring createLibsqlSdk from
 * @worlds/libsql. When the sqlite-vec extension cannot be loaded, the whole
 * vector surface degrades to keyword-only.
 */
export async function createSqliteSdk(
  options: SqliteSdkOptions,
): Promise<SqliteSdk> {
  const vectorDimensions = options.vectorDimensions ?? 1536;
  const db = options.db ??
    new DatabaseSync(options.path, { allowExtension: true });

  let vectorSupported = false;
  if (options.loadVectorExtension !== false) {
    try {
      // sqlite-vec ships platform prebuilt binaries as optional dependencies;
      // load() calls DatabaseSync.loadExtension with the right path.
      const { load } = await import("sqlite-vec");
      load(db);
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

  const sdk = new Sdk({
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
