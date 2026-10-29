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
