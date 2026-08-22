import { assertEquals } from "@std/assert";
import {
  buildIncludeExcludeFilterClauses,
  buildKeywordFtsStatement,
  generatePlaceholders,
  RRF_FUSION_K,
} from "./keyword-fts-plan.ts";

Deno.test("generatePlaceholders - comma-delimited bound variables", () => {
  assertEquals(generatePlaceholders(1), "?");
  assertEquals(generatePlaceholders(3), "?, ?, ?");
});

Deno.test("buildIncludeExcludeFilterClauses - renders IN/NOT IN with args", () => {
  const { whereClauses, filterArgs } = buildIncludeExcludeFilterClauses(
    {
      include: { graphs: ["urn:g1", "urn:g2"] },
      exclude: { subjects: ["urn:secret"] },
    },
    {
      subjects: "chunks.subject",
      predicates: "chunks.predicate",
      graphs: "chunks.graph",
    },
  );
  assertEquals(whereClauses, [
    "chunks.subject NOT IN (?)",
    "chunks.graph IN (?, ?)",
  ]);
  assertEquals(filterArgs, ["urn:secret", "urn:g1", "urn:g2"]);
});

Deno.test("buildKeywordFtsStatement - FTS5 plan with RRF scoring and stable arg order", () => {
  const statement = buildKeywordFtsStatement({
    sanitizedQuery: '"needle"',
    limit: 5,
    whereFilter: "WHERE chunks.graph IN (?)",
    filterArgs: ["urn:g"],
  });
  assertEquals(statement.sql.includes("chunks_fts MATCH ?"), true);
  assertEquals(
    statement.sql.includes(`1.0 / (${RRF_FUSION_K} + fts_matches.rank_number)`),
    true,
  );
  // Match expression, candidate limit, filter binds, then the final limit.
  assertEquals(statement.args, ['"needle"', 5, "urn:g", 5]);
});
