import type { QuadFilter } from "@worlds/sdk";
import type { SqlStatement } from "./sql-statement.ts";

/**
 * RRF_FUSION_K is the reciprocal rank fusion constant shared by every
 * keyword/vector rank formula emitted by sql-core (k = 60 per the hybrid
 * search plan).
 */
export const RRF_FUSION_K = 60;

/** ColumnMapping maps QuadFilter dimensions to SQL column names. */
export interface ColumnMapping {
  subjects: string;
  predicates: string;
  graphs: string;
}

/**
 * generatePlaceholders generates a comma-delimited set of parameterized
 * SQLite bound variables.
 */
export function generatePlaceholders(count: number): string {
  return Array(count).fill("?").join(", ");
}

/**
 * buildIncludeExcludeFilterClauses builds parameterized WHERE fragments from a
 * QuadFilter using the given column mapping (shared verbatim across the
 * sqlite and libsql query builders).
 */
export function buildIncludeExcludeFilterClauses(
  filter: QuadFilter | undefined,
  columnMapping: ColumnMapping,
): { whereClauses: string[]; filterArgs: string[] } {
  const whereClauses: string[] = [];
  const filterArgs: string[] = [];

  const filterConfigurations = [
    {
      values: filter?.exclude?.subjects,
      column: columnMapping.subjects,
      operator: "NOT IN",
    },
    {
      values: filter?.exclude?.predicates,
      column: columnMapping.predicates,
      operator: "NOT IN",
    },
    {
      values: filter?.exclude?.graphs,
      column: columnMapping.graphs,
      operator: "NOT IN",
    },
    {
      values: filter?.include?.subjects,
      column: columnMapping.subjects,
      operator: "IN",
    },
    {
      values: filter?.include?.predicates,
      column: columnMapping.predicates,
      operator: "IN",
    },
    {
      values: filter?.include?.graphs,
      column: columnMapping.graphs,
      operator: "IN",
    },
  ] as const;

  for (const { values, column, operator } of filterConfigurations) {
    if (values?.length) {
      const placeholders = generatePlaceholders(values.length);
      whereClauses.push(`${column} ${operator} (${placeholders})`);
      filterArgs.push(...values);
    }
  }

  return { whereClauses, filterArgs };
}

/** BuildKeywordFtsStatementOptions configures the keyword branch plan. */
export interface BuildKeywordFtsStatementOptions {
  /** sanitizedQuery is the quoted FTS5 match expression from sanitizeFtsQuery. */
  sanitizedQuery: string;

  /** limit caps the candidate window inside the FTS CTE and the final rows. */
  limit: number;

  /** whereFilter is the pre-rendered QuadFilter WHERE fragment (may be empty). */
  whereFilter: string;

  /** filterArgs are the bind values referenced by whereFilter. */
  filterArgs: string[];
}

/**
 * buildKeywordFtsStatement emits the FTS5 keyword branch plan over the
 * `chunks`/`chunks_fts` pair: an fts_matches CTE ranked by FTS5 rank, joined
 * back to chunks so subject/predicate/graph/value ride along, scored with
 * reciprocal rank fusion. Callers fuse this branch with their own vector
 * branch (JS-side or in-SQL) — sql-core never assumes a fusion locus.
 */
export function buildKeywordFtsStatement(
  options: BuildKeywordFtsStatementOptions,
): SqlStatement {
  const { sanitizedQuery, limit, whereFilter, filterArgs } = options;

  const args: (string | number)[] = [
    sanitizedQuery,
    limit,
    ...filterArgs,
    limit,
  ];

  const sql = `
      WITH fts_matches AS (
        SELECT
          rowid,
          row_number() OVER (ORDER BY rank) AS rank_number
        FROM
          chunks_fts
        WHERE
          chunks_fts MATCH ?
        LIMIT ?
      ), final AS (
        SELECT
          chunks.id AS chunk_id,
          chunks.subject,
          chunks.predicate,
          chunks.graph,
          chunks.value,
          COALESCE(1.0 / (${RRF_FUSION_K} + fts_matches.rank_number), 0.0) AS combined_rank
        FROM
          fts_matches
          JOIN chunks ON chunks.id = fts_matches.rowid
        ${whereFilter}
        ORDER BY
          combined_rank DESC
        LIMIT ?
      )
      SELECT * FROM final;
    `;
  return { sql, args };
}
