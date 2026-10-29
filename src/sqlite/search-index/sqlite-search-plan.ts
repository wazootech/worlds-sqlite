import type { SqlStatement } from "@/sqlite/sqlite-connection-driver.ts";

/**
 * SqliteSearchPlan is the executable plan SqliteSearchIndex consumes. The
 * hybrid mode runs the keyword and vector branches separately and fuses them
 * with JS-side reciprocal rank fusion (per the Layer 2 plan); the single
 * modes execute one branch directly.
 */
export type SqliteSearchPlan =
  | {
    mode: "hybrid";
    keyword: SqlStatement;
    vector: SqlStatement;
    limit: number;
  }
  | { mode: "keyword"; statement: SqlStatement; limit: number }
  | { mode: "vector"; statement: SqlStatement; limit: number }
  | { mode: "none"; limit: number };

/** SqliteSearchQueryBuilderOptions configures vector SQL generation. */
export interface SqliteSearchQueryBuilderOptions {
  /**
   * vectorSupported gates every vec0 statement. When false the builder never
   * references chunks_vec (keyword-only degradation).
   */
  vectorSupported?: boolean;
}
