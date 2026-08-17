// Child-process helper for the SqliteStore crash-recovery suite
// (src/sqlite/rdfjs-store/sqlite-store-recovery.test.ts). Each mode simulates
// a different failure point from inside a fresh Deno process; the parent test
// reopens the database file and asserts what survived.
//
// Usage: deno run --allow-all test/sqlite-recovery-child.ts <mode> <dbPath> [tag]
import { DatabaseSync } from "node:sqlite";
import { SqliteStore } from "@/sqlite/rdfjs-store/sqlite-store.ts";
import { DataFactory } from "n3";
import { WazooSparqlEngine } from "@wazoo/sparql-engine";

const { namedNode, literal, quad } = DataFactory;

const [mode, path, tag] = Deno.args;

switch (mode) {
  case "commit-exit": {
    // Commit one update, then hard-exit WITHOUT close(). The COMMIT is
    // synchronous (WAL + synchronous=FULL), so the write is durable before
    // the process dies — a reopen must see it.
    const store = new SqliteStore({ path });
    const engine = new WazooSparqlEngine({
      store,
      createTransaction: () => store.createTransaction(),
    });
    await engine.execute({
      query:
        `INSERT DATA { <http://example.org/s> <http://example.org/p> "v" }`,
    });
    Deno.exit(0);
    break;
  }
  case "buffered-exit": {
    // Buffer writes inside a transaction, then die before commit(). The
    // SqliteTransaction keeps its patch in memory — nothing has touched the
    // database — so a reopen must find the dataset untouched.
    const store = new SqliteStore({ path });
    const transaction = store.createTransaction();
    transaction.add(
      quad(
        namedNode("http://example.org/s"),
        namedNode("http://example.org/p"),
        literal("v"),
      ),
    );
    Deno.exit(1);
    break;
  }
  case "raw-mid-transaction": {
    // Crash with an uncommitted transaction at the SQLite level: rows are
    // written into the WAL inside BEGIN IMMEDIATE but never committed. WAL
    // recovery must roll the interrupted transaction back on reopen.
    const store = new SqliteStore({ path });
    store.close();
    const db = new DatabaseSync(path);
    db.exec(
      "BEGIN IMMEDIATE;" +
        "INSERT INTO quads (skey, pkey, okey, gkey, payload) " +
        "VALUES ('k', 'k', 'k', 'k', '{}');",
    );
    Deno.exit(1);
    break;
  }
  case "concurrent-writer": {
    // Commit several small transactions with a yield between them so two
    // writers genuinely overlap on the write lock. busy_timeout makes the
    // second writer wait instead of failing with SQLITE_BUSY; the parent
    // asserts both writers' data lands in full — no interleaved partials.
    // Both commit() and the store's open/close can hit "database is locked"
    // under contention, so the whole sequence is retried with a fresh store
    // (writes are upserts, so a partial retry is idempotent). The parent's
    // 200-quad completeness assertion is what proves no interleaving.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const store = new SqliteStore({ path });
        for (let round = 0; round < 5; round++) {
          await commitWithRetry(store, tag, round);
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        store.close();
        Deno.exit(0);
      } catch (error) {
        if (attempt === 2) {
          console.error(error);
          Deno.exit(1);
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    break;
  }
  default:
    throw new Error(`unknown recovery child mode: ${mode}`);
}

/**
 * commitWithRetry commits one 20-quad round, retrying with a 200ms backoff
 * (10 attempts ≈ 2s) when the write lock is contended past busy_timeout. A
 * fresh transaction is created per attempt; a failed commit already rolled
 * back at the SQLite level, and each transaction is atomic, so a retry can
 * never interleave partial writes.
 */
async function commitWithRetry(
  store: SqliteStore,
  tag: string,
  round: number,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 10; attempt++) {
    const transaction = store.createTransaction();
    for (let index = 0; index < 20; index++) {
      transaction.add(
        quad(
          namedNode(`http://example.org/${tag}-${round}-${index}`),
          namedNode("http://example.org/p"),
          literal(`${index}`),
        ),
      );
    }
    try {
      await transaction.commit();
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 9) {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
  }
  throw lastError;
}
