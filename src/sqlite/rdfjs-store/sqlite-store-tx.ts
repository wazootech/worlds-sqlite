import type * as rdfjs from "@rdfjs/types";
import type { SqliteStore } from "@/sqlite/rdfjs-store/sqlite-store.ts";
import { quadKey } from "@/sqlite/rdfjs-store/sqlite-store-codec.ts";

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

/**
 * SqliteTransactionImpl buffers a SPARQL update patch and applies it
 * atomically on commit. Deletes run before inserts, and a delete followed by
 * an insert of the same quad nets to the insert.
 */
export class SqliteTransactionImpl implements SqliteTransaction {
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
