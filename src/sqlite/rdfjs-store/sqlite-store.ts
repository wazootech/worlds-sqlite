/**
 * SqliteStore — durable, zero-extra-dependency RDF/JS Store over SQLite.
 *
 * The SQLite quad primitive for the Worlds ecosystem, packaged with the
 * worlds impl per the agreed pattern (the RDF/JS store lives inside the
 * worlds backend: `LibsqlRdfjsStore` in `@worlds/libsql`, `PostgresRdfjsStore`
 * in `@worlds/postgres`, `SqliteStore` here). Extracted from
 * `@wazoo/sparql-engine/sqlite` (v0.3.x) and re-based on the shared Worlds
 * stack: the engine's zero-dependency `DataFactory` (the same one
 * `@worlds/sdk` uses) and the term identity in
 * `src/sqlite/term/term-key.ts` (parity-tested against the engine).
 *
 * The engine remains store-agnostic and consumes this store through its
 * `createTransaction` hook:
 *
 *   const store = new SqliteStore({ path: "data.sqlite" });
 *   const engine = new WazooSparqlEngine({
 *     store,
 *     createTransaction: () => store.createTransaction(),
 *   });
 *
 * Design notes
 * ------------
 * - Runs over a synchronous SQLite handle: `node:sqlite` DatabaseSync (Deno
 *   >= 2.1 / Node >= 22.5, the default) or `bun:sqlite` Database passed via
 *   `db` / a `createHandle` factory — both are builtins, not dependencies,
 *   and both structurally satisfy AnySyncSqliteHandle. Server-side
 *   deployments only; browser bundles should keep using an in-memory store.
 * - node:sqlite is resolved lazily (never at module load), so this module
 *   stays loadable on runtimes without it (Bun). On such runtimes, path-only
 *   construction throws and callers must pass `db` or `createHandle`.
 * - `PRAGMA busy_timeout` lets concurrent writers wait for the write lock
 *   instead of failing with SQLITE_BUSY when a transaction is in flight.
 * - Rows are keyed by a sound RDF-term equality key per position (`termKey`),
 *   with a composite primary key over all four positions so quads that
 *   differ only by graph never collide.
 * - `match` reconstructs quads from a lossless JSON payload; literal language
 *   and datatype are preserved exactly (RDF-star triple terms included).
 * - Transactions run `BEGIN IMMEDIATE` ... `COMMIT` so a failed commit
 *   (`ROLLBACK`) leaves the dataset untouched, and WAL journaling keeps the
 *   database consistent across process crashes.
 */
import type * as rdfjs from "@rdfjs/types";
import { DataFactory } from "@wazoo/sparql-engine";
import type {
  AnySyncSqliteHandle,
  SyncSqliteHandleFactory,
} from "@/sqlite/any-sync-sqlite-handle.ts";
import { termKey } from "@/sqlite/term/term-key.ts";
import { MemoryStream } from "@/sqlite/rdfjs-store/memory-stream.ts";
import { openNodeSqliteHandle } from "@/sqlite/rdfjs-store/sqlite-store-handle.ts";
import {
  quadKey,
  quadToPayloadJson,
} from "@/sqlite/rdfjs-store/sqlite-store-codec.ts";
import {
  type SqliteTransaction,
  SqliteTransactionImpl,
} from "@/sqlite/rdfjs-store/sqlite-store-tx.ts";
import { queryQuads } from "@/sqlite/rdfjs-store/sqlite-store-query.ts";
import { SQLITE_STORE_INIT_SQL } from "@/sqlite/rdfjs-store/sqlite-store-sql.ts";

export type { SqliteTransaction };
export {
  quadFromPayloadJson,
  quadToPayloadJson,
} from "@/sqlite/rdfjs-store/sqlite-store-codec.ts";

/** SqliteStoreOptions configures SqliteStore. */
export interface SqliteStoreOptions {
  /** Path to the SQLite database file, or ":memory:" for a temp database. */
  path: string;

  /**
   * Pre-created synchronous SQLite handle to share instead of opening a new
   * one: a node:sqlite DatabaseSync, a bun:sqlite Database, or any other
   * AnySyncSqliteHandle. Used by createSqliteWorldsSdk so the L2 quad store,
   * search layer, and RDF/JS read path share a single handle (required for
   * ":memory:" and for a handle opened with allowExtension so sqlite-vec can
   * load). When provided, `path` is ignored.
   */
  db?: AnySyncSqliteHandle;

  /**
   * createHandle supplies the default handle when `db` is absent — the
   * injectable construction seam. Defaults to opening a node:sqlite
   * DatabaseSync for `path`; Bun callers can pass a factory over
   * bun:sqlite's Database instead. When provided, `path` is used as its
   * argument.
   */
  createHandle?: SyncSqliteHandleFactory;

  /** matchPageSize limits rows per getQuads SQL round-trip (default 1000). */
  matchPageSize?: number;

  /**
   * Test seam invoked inside commit(), after BEGIN IMMEDIATE and before any
   * row is written. Throw to exercise the atomic-rollback path.
   */
  beforeCommit?: (db: AnySyncSqliteHandle) => void;
}

/**
 * SqliteStore is a durable RDF/JS Store. It implements the read side of
 * rdfjs.Store plus addQuad/removeQuad, and offers createTransaction() for
 * atomic, restart-safe SPARQL updates.
 */
export class SqliteStore implements rdfjs.Store<rdfjs.Quad> {
  public readonly db: AnySyncSqliteHandle;

  public constructor(public readonly options: SqliteStoreOptions) {
    this.db = options.db ??
      (options.createHandle?.(options.path) ??
        openNodeSqliteHandle(options.path));
    // busy_timeout goes first: switching to WAL takes an exclusive lock, and
    // without a timeout already set, a second process opening the same new
    // database fails at once with "database is locked" instead of waiting.
    this.db.exec(SQLITE_STORE_INIT_SQL);
  }

  /** createTransaction returns a fresh transaction over this store. */
  public createTransaction(): SqliteTransaction {
    return new SqliteTransactionImpl(this);
  }

  public addQuad(quad: rdfjs.Quad): this;
  public addQuad(
    subject: rdfjs.Term,
    predicate: rdfjs.Term,
    object: rdfjs.Term,
    graph?: rdfjs.Term,
  ): this;
  public addQuad(
    quadOrSubject: rdfjs.Quad | rdfjs.Term,
    predicate?: rdfjs.Term,
    object?: rdfjs.Term,
    graph?: rdfjs.Term,
  ): this {
    const quad = predicate !== undefined && object !== undefined
      ? DataFactory.quad(
        // RDF 1.2 allows any term in any position (literal subjects in
        // quoted triples); the engine's position types are narrower, so cast.
        quadOrSubject as rdfjs.Quad_Subject,
        predicate as rdfjs.Quad_Predicate,
        object as rdfjs.Quad_Object,
        graph as rdfjs.Quad_Graph,
      )
      : quadOrSubject as rdfjs.Quad;
    this.insertQuad(quad);
    return this;
  }

  public removeQuad(quad: rdfjs.Quad): this {
    this.removeQuadByKey(quadKey(quad));
    return this;
  }

  public remove(stream: rdfjs.Stream<rdfjs.Quad>): rdfjs.Stream<rdfjs.Quad> {
    stream.on("data", (q: rdfjs.Quad) => this.removeQuad(q));
    return stream;
  }

  public import(stream: rdfjs.Stream<rdfjs.Quad>): rdfjs.Stream<rdfjs.Quad> {
    stream.on("data", (q: rdfjs.Quad) => this.addQuad(q));
    return stream;
  }

  public match(
    subject?: rdfjs.Term | null,
    predicate?: rdfjs.Term | null,
    object?: rdfjs.Term | null,
    graph?: rdfjs.Term | null,
  ): MemoryStream {
    return new MemoryStream(this.getQuads(subject, predicate, object, graph));
  }

  public getQuads(
    subject?: rdfjs.Term | null,
    predicate?: rdfjs.Term | null,
    object?: rdfjs.Term | null,
    graph?: rdfjs.Term | null,
  ): rdfjs.Quad[] {
    return queryQuads(
      this.db,
      this.options.matchPageSize,
      subject,
      predicate,
      object,
      graph,
    );
  }

  public countQuads(
    subject?: rdfjs.Term | null,
    predicate?: rdfjs.Term | null,
    object?: rdfjs.Term | null,
    graph?: rdfjs.Term | null,
  ): number {
    return this.getQuads(subject, predicate, object, graph).length;
  }

  public removeMatches(
    subject?: rdfjs.Term | null,
    predicate?: rdfjs.Term | null,
    object?: rdfjs.Term | null,
    graph?: rdfjs.Term | null,
  ): MemoryStream {
    const matches = this.getQuads(subject, predicate, object, graph);
    for (const quad of matches) {
      this.removeQuad(quad);
    }
    return new MemoryStream(matches);
  }

  public deleteGraph(graph: rdfjs.Quad_Graph | string): MemoryStream {
    const graphTerm = typeof graph === "string"
      ? DataFactory.namedNode(graph)
      : graph;
    return this.removeMatches(null, null, null, graphTerm);
  }

  public get size(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM quads").get() as
      | Record<string, number>
      | undefined;
    return row?.n ?? 0;
  }

  /** close releases the underlying database handle. */
  public close(): void {
    this.db.close();
  }

  /** insertQuad writes one row (upsert semantics). */
  public insertQuad(quad: rdfjs.Quad): void {
    this.db.prepare(
      "INSERT OR REPLACE INTO quads (skey, pkey, okey, gkey, payload)" +
        " VALUES (?, ?, ?, ?, ?)",
    ).run(
      termKey(quad.subject),
      termKey(quad.predicate),
      termKey(quad.object),
      termKey(quad.graph),
      quadToPayloadJson(quad),
    );
  }

  /** removeQuadByKey deletes one row by its four-position key. */
  public removeQuadByKey(key: string): void {
    const [skey, pkey, okey, gkey] = key.split("\u0000");
    this.db.prepare(
      "DELETE FROM quads WHERE skey = ? AND pkey = ? AND okey = ? AND gkey = ?",
    ).run(skey, pkey, okey, gkey);
  }
}
