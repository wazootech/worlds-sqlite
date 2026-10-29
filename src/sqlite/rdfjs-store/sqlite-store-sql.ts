import type * as rdfjs from "@rdfjs/types";
import type { AnySyncSqliteHandle } from "@/sqlite/any-sync-sqlite-handle.ts";
import { termKey } from "@/sqlite/term/term-key.ts";
import { quadToPayloadJson } from "@/sqlite/rdfjs-store/sqlite-store-codec.ts";

/** SQLITE_STORE_INIT_SQL configures pragmas and creates the quads table. */
export const SQLITE_STORE_INIT_SQL = "PRAGMA busy_timeout = 5000;" +
  "PRAGMA journal_mode = WAL;" +
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
  "CREATE INDEX IF NOT EXISTS idx_quads_gkey ON quads (gkey);";

/** insertQuadRow writes one quads row (upsert semantics). */
export function insertQuadRow(db: AnySyncSqliteHandle, quad: rdfjs.Quad): void {
  db.prepare(
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

/** deleteQuadRow deletes one quads row by its four-position key. */
export function deleteQuadRow(db: AnySyncSqliteHandle, key: string): void {
  const [skey, pkey, okey, gkey] = key.split("\u0000");
  db.prepare(
    "DELETE FROM quads WHERE skey = ? AND pkey = ? AND okey = ? AND gkey = ?",
  ).run(skey, pkey, okey, gkey);
}
