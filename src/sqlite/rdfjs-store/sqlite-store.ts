/**
 * SqliteStore — durable, zero-extra-dependency RDF/JS Store over SQLite.
 *
 * The SQLite quad primitive for the Worlds ecosystem, packaged with the
 * worlds impl per the agreed pattern (the RDF/JS store lives inside the
 * worlds backend: `LibsqlRdfjsStore` in `@worlds/libsql`, `PostgresRdfjsStore`
 * in `@worlds/postgres`, `SqliteStore` here). Extracted from
 * `@wazoo/sparql-engine/sqlite` (v0.3.x) and re-based on the shared Worlds
 * stack: `n3`'s DataFactory (the same one `@worlds/sdk` uses) and the term
 * identity in `src/sqlite/term/term-key.ts` (parity-tested against the
 * engine).
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
 * - Uses Deno/Node's built-in `node:sqlite` (DatabaseSync) — a builtin, not
 *   a dependency. Server-side (Deno >= 2.1 / Node >= 22.5) deployments only;
 *   browser bundles should keep using an in-memory store.
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
import { DatabaseSync } from "node:sqlite";
import { DataFactory } from "n3";
import { termKey } from "@/sqlite/term/term-key.ts";
import { MemoryStream } from "@/sqlite/rdfjs-store/memory-stream.ts";

/**
 * SqliteTransaction is the atomic patch contract a SPARQL update uses to
 * buffer writes. It is structurally identical to the engine's
 * `WazooSparqlTransaction` (and the worlds client's Transaction), so a store
 * producing it satisfies the engine's `createTransaction` hook with no
 * cross-package import.
 */
export interface SqliteTransaction {
  /** add buffers a single quad for insertion on the next commit. */
  add(quad: rdfjs.Quad): unknown;

  /** delete buffers a single quad for deletion on the next commit. */
  delete(quad: rdfjs.Quad): unknown;

  /** commit persists the buffered patch. */
  commit(): Promise<void>;

  /** rollback discards any uncommitted insertions and deletions. */
  rollback(): void;
}

/** Lossless, JSON-serializable term encoding (kept private to this module). */
type TermRecord =
  | { t: "N"; v: string } // NamedNode
  | { t: "B"; v: string } // BlankNode
  | { t: "V"; v: string } // Variable
  | { t: "D" } // DefaultGraph
  | { t: "L"; v: string; lang: string; dt: string } // Literal
  | { t: "Q"; s: TermRecord; p: TermRecord; o: TermRecord }; // RDF-star triple term

type QuadRecord = {
  s: TermRecord;
  p: TermRecord;
  o: TermRecord;
  g: TermRecord;
};

function toTermRecord(term: rdfjs.Term): TermRecord {
  switch (term.termType) {
    case "NamedNode":
      return { t: "N", v: term.value };
    case "BlankNode":
      return { t: "B", v: term.value };
    case "Variable":
      return { t: "V", v: term.value };
    case "DefaultGraph":
      return { t: "D" };
    case "Literal":
      return {
        t: "L",
        v: term.value,
        lang: term.language,
        dt: term.datatype.value,
      };
    case "Quad":
      return {
        t: "Q",
        s: toTermRecord(term.subject),
        p: toTermRecord(term.predicate),
        o: toTermRecord(term.object),
      };
  }
}

function fromTermRecord(rec: TermRecord): rdfjs.Term {
  switch (rec.t) {
    case "N":
      return DataFactory.namedNode(rec.v);
    case "B":
      return DataFactory.blankNode(rec.v);
    case "V":
      return DataFactory.variable(rec.v);
    case "D":
      return DataFactory.defaultGraph();
    case "L":
      return rec.lang
        ? DataFactory.literal(rec.v, rec.lang)
        : DataFactory.literal(rec.v, DataFactory.namedNode(rec.dt));
    case "Q":
      // n3's quad() types are strict about positions, but RDF 1.2 triple
      // terms allow any term in any position (literal subjects included) —
      // cast to the position types, which is always sound here.
      return DataFactory.quad(
        fromTermRecord(rec.s) as rdfjs.Quad_Subject,
        fromTermRecord(rec.p) as rdfjs.Quad_Predicate,
        fromTermRecord(rec.o) as rdfjs.Quad_Object,
      );
  }
}

function toQuadRecord(quad: rdfjs.Quad): QuadRecord {
  return {
    s: toTermRecord(quad.subject),
    p: toTermRecord(quad.predicate),
    o: toTermRecord(quad.object),
    g: toTermRecord(quad.graph),
  };
}

function fromQuadRecord(rec: QuadRecord): rdfjs.Quad {
  // Reconstructed positions may be any term (RDF 1.2 quoted triples allow
  // literal subjects); n3's position types are narrower, so cast.
  return DataFactory.quad(
    fromTermRecord(rec.s) as rdfjs.Quad_Subject,
    fromTermRecord(rec.p) as rdfjs.Quad_Predicate,
    fromTermRecord(rec.o) as rdfjs.Quad_Object,
    fromTermRecord(rec.g) as rdfjs.Quad_Graph,
  );
}

/** SqliteStoreOptions configures SqliteStore. */
export interface SqliteStoreOptions {
  /** Path to the SQLite database file, or ":memory:" for a temp database. */
  path: string;

  /**
   * Test seam invoked inside commit(), after BEGIN IMMEDIATE and before any
   * row is written. Throw to exercise the atomic-rollback path.
   */
  beforeCommit?: (db: DatabaseSync) => void;
}

/**
 * SqliteTransactionImpl buffers a SPARQL update patch and applies it
 * atomically on commit. Deletes run before inserts, and a delete followed by
 * an insert of the same quad nets to the insert.
 */
class SqliteTransactionImpl implements SqliteTransaction {
  /** quad key -> quad, for insert; a Map keeps the last insert of a key. */
  private readonly inserted = new Map<string, rdfjs.Quad>();
  /** quad keys buffered for deletion (net of any insert of the same key). */
  private readonly deleted = new Set<string>();

  public constructor(private readonly store: SqliteStore) {}

  public add(quad: rdfjs.Quad): void {
    this.deleted.delete(quadKey(quad));
    this.inserted.set(quadKey(quad), quad);
  }

  public delete(quad: rdfjs.Quad): void {
    if (this.inserted.delete(quadKey(quad))) {
      return; // add + delete of the same quad nets to nothing
    }
    this.deleted.add(quadKey(quad));
  }

  public commit(): Promise<void> {
    // node:sqlite is synchronous, so commit resolves once the COMMIT lands.
    const db = this.store.db;
    db.exec("BEGIN IMMEDIATE");
    try {
      this.store.options.beforeCommit?.(db);
      for (const key of this.deleted) {
        this.store.removeQuadByKey(key);
      }
      for (const quad of this.inserted.values()) {
        this.store.insertQuad(quad);
      }
      db.exec("COMMIT");
      return Promise.resolve();
    } catch (error) {
      db.exec("ROLLBACK");
      return Promise.reject(error);
    }
  }

  public rollback(): void {
    this.inserted.clear();
    this.deleted.clear();
  }
}

function quadKey(quad: rdfjs.Quad): string {
  return [
    termKey(quad.subject),
    termKey(quad.predicate),
    termKey(quad.object),
    termKey(quad.graph),
  ].join("\u0000");
}

/**
 * SqliteStore is a durable RDF/JS Store. It implements the read side of
 * rdfjs.Store plus addQuad/removeQuad, and offers createTransaction() for
 * atomic, restart-safe SPARQL updates.
 */
export class SqliteStore implements rdfjs.Store<rdfjs.Quad> {
  public readonly db: DatabaseSync;

  public constructor(public readonly options: SqliteStoreOptions) {
    this.db = new DatabaseSync(options.path);
    this.db.exec(
      "PRAGMA journal_mode = WAL;" +
        "PRAGMA busy_timeout = 5000;" +
        "CREATE TABLE IF NOT EXISTS quads (" +
        "  skey TEXT NOT NULL," +
        "  pkey TEXT NOT NULL," +
        "  okey TEXT NOT NULL," +
        "  gkey TEXT NOT NULL," +
        "  payload TEXT NOT NULL," +
        "  PRIMARY KEY (skey, pkey, okey, gkey)" +
        ") STRICT;" +
        "CREATE INDEX IF NOT EXISTS idx_quads_pkey ON quads (pkey);" +
        "CREATE INDEX IF NOT EXISTS idx_quads_okey ON quads (okey);" +
        "CREATE INDEX IF NOT EXISTS idx_quads_gkey ON quads (gkey);",
    );
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
        // quoted triples); n3's position types are narrower, so cast.
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
    const where: string[] = [];
    const args: string[] = [];
    const bind = (
      column: string,
      term: rdfjs.Term | null | undefined,
    ): void => {
      if (term != null) {
        where.push(`${column} = ?`);
        args.push(termKey(term));
      }
    };
    bind("skey", subject);
    bind("pkey", predicate);
    bind("okey", object);
    bind("gkey", graph);
    const sql = "SELECT payload FROM quads" +
      (where.length > 0 ? " WHERE " + where.join(" AND ") : "");
    const rows = this.db.prepare(sql).all(...args) as Array<
      Record<string, string>
    >;
    return rows.map((row) => fromQuadRecord(JSON.parse(row.payload)));
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
      JSON.stringify(toQuadRecord(quad)),
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
