import type { SqlStatement } from "@/sqlite/sqlite-connection-driver.ts";

/** buildVectorStatement builds the sqlite-vec KNN statement with chunk filters. */
export function buildVectorStatement(
  vectorJson: string,
  limit: number,
  whereFilter: string,
  filterArgs: string[],
): SqlStatement {
  const args: (string | number)[] = [
    vectorJson,
    limit,
    ...filterArgs,
    limit,
  ];

  const sql = `
    WITH vec_matches AS (
      SELECT
        rowid,
        row_number() OVER (ORDER BY distance) AS rank_number
      FROM
        chunks_vec
      WHERE
        embedding MATCH ? AND k = ?
    ), final AS (
      SELECT
        chunks.id AS chunk_id,
        chunks.subject,
        chunks.predicate,
        chunks.graph,
        chunks.value,
        COALESCE(1.0 / (60 + vec_matches.rank_number), 0.0) AS combined_rank
      FROM
        vec_matches
        JOIN chunks ON chunks.id = vec_matches.rowid
      ${whereFilter}
      ORDER BY
        combined_rank DESC
      LIMIT ?
    )
    SELECT * FROM final;
  `;
  return { sql, args };
}
