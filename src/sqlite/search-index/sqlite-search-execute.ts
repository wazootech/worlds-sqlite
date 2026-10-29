import type { SqliteConnectionDriver } from "@/sqlite/sqlite-connection-driver.ts";
import type { SqliteSearchPlan } from "./sqlite-search-plan.ts";

/** SearchRow is one result row returned by the keyword/vector SQL branches. */
export interface SearchRow {
  chunk_id: unknown;
  subject: unknown;
  predicate: unknown;
  graph: unknown;
  value: unknown;
  combined_rank: unknown;
}

export async function executeSearchPlan(
  connection: SqliteConnectionDriver,
  plan: SqliteSearchPlan,
): Promise<SearchRow[]> {
  switch (plan.mode) {
    case "none":
      return [];
    case "keyword":
    case "vector":
      return (await connection.execute(plan.statement))
        .rows as unknown as SearchRow[];
    case "hybrid": {
      const keywordRows = (await connection.execute(
        plan.keyword,
      )).rows as unknown as SearchRow[];
      const vectorRows = (await connection.execute(
        plan.vector,
      )).rows as unknown as SearchRow[];

      // JS-side reciprocal rank fusion: each row carries its single-branch
      // RRF contribution (1 / (60 + rank)); overlapping chunk ids sum both.
      const fused = new Map<number, SearchRow>();
      for (const row of keywordRows) {
        const chunkId = Number(row.chunk_id);
        fused.set(chunkId, { ...row, combined_rank: row.combined_rank });
      }
      for (const row of vectorRows) {
        const chunkId = Number(row.chunk_id);
        const existing = fused.get(chunkId);
        if (existing) {
          existing.combined_rank = Number(existing.combined_rank) +
            Number(row.combined_rank);
        } else {
          fused.set(chunkId, { ...row, combined_rank: row.combined_rank });
        }
      }

      return [...fused.values()]
        .sort((a, b) => {
          const scoreDelta = Number(b.combined_rank) -
            Number(a.combined_rank);
          if (scoreDelta !== 0) return scoreDelta;
          return String(a.subject).localeCompare(String(b.subject));
        })
        .slice(0, plan.limit);
    }
  }
}
