import { assertEquals } from "@std/assert";
import { SqliteSearchQueryBuilder } from "./sqlite-search-query-builder.ts";

const builder = new SqliteSearchQueryBuilder(32, { vectorSupported: true });

Deno.test("SqliteSearchQueryBuilder - validates vector dimensions", () => {
  assertEquals(new SqliteSearchQueryBuilder(32).vectorDimensions, 32);
  try {
    new SqliteSearchQueryBuilder(0);
    throw new Error("expected rejection");
  } catch (error) {
    assertEquals((error as Error).message.includes("vectorDimensions"), true);
  }
});

Deno.test("SqliteSearchQueryBuilder - keyword plan with filters and limits", () => {
  const plan = builder.buildSearchQuery(
    { query: "needle", include: { graphs: ["urn:g"] }, topK: 5 },
    { limit: 5 },
  );
  assertEquals(plan.mode, "keyword");
  if (plan.mode === "keyword") {
    assertEquals(plan.statement.sql.includes("chunks_fts MATCH ?"), true);
    assertEquals(plan.statement.sql.includes("chunks.graph IN (?)"), true);
    assertEquals(plan.statement.args, ['"needle"', 5, "urn:g", 5]);
  }
});

Deno.test("SqliteSearchQueryBuilder - vector-only plan when no keyword tokens", () => {
  const plan = builder.buildSearchQuery(
    { query: "!!!" },
    { vectorJson: "[0,0]", limit: 10 },
  );
  assertEquals(plan.mode, "vector");
  if (plan.mode === "vector") {
    assertEquals(
      plan.statement.sql.includes("embedding MATCH ? AND k = ?"),
      true,
    );
  }
});

Deno.test("SqliteSearchQueryBuilder - hybrid plan emits both branches", () => {
  const plan = builder.buildSearchQuery(
    { query: "needle" },
    { vectorJson: "[0,0]", limit: 10 },
  );
  assertEquals(plan.mode, "hybrid");
  if (plan.mode === "hybrid") {
    assertEquals(plan.keyword.sql.includes("chunks_fts MATCH ?"), true);
    assertEquals(plan.vector.sql.includes("embedding MATCH ? AND k = ?"), true);
    assertEquals(plan.limit, 10);
  }
});

Deno.test("SqliteSearchQueryBuilder - none plan for empty query without vector", () => {
  const plan = builder.buildSearchQuery({ query: "" }, { limit: 10 });
  assertEquals(plan.mode, "none");
  const punct = builder.buildSearchQuery({ query: "???" }, { limit: 10 });
  assertEquals(punct.mode, "none");
});

Deno.test("SqliteSearchQueryBuilder - keyword-only builder never emits vec0 SQL", () => {
  const keywordOnly = new SqliteSearchQueryBuilder(32, {
    vectorSupported: false,
  });
  const plan = keywordOnly.buildSearchQuery(
    { query: "needle" },
    { vectorJson: "[0,0]", limit: 10 },
  );
  // Vector JSON is ignored when the vec0 table does not exist.
  assertEquals(plan.mode, "keyword");
  if (plan.mode === "keyword") {
    assertEquals(plan.statement.sql.includes("chunks_vec"), false);
  }
  const deletions = keywordOnly.buildDeleteByQuadIds(["q1"]);
  for (const statement of deletions) {
    assertEquals(statement.sql.includes("chunks_vec"), false);
  }
  const vecEnabled = new SqliteSearchQueryBuilder(32, {
    vectorSupported: true,
  });
  const vecDeletions = vecEnabled.buildDeleteByQuadIds(["q1"]);
  assertEquals(vecDeletions.length, 2);
  assertEquals(vecDeletions[0].sql.startsWith("DELETE FROM chunks_vec"), true);
});

Deno.test("SqliteSearchQueryBuilder - chunk insert returns rowid and vec insert binds bigint rowid", () => {
  const insert = builder.buildInsertChunk({
    quad_id: "q1",
    subject: "s",
    predicate: "p",
    graph: "",
    value: "v",
    fts_value: "v",
  });
  assertEquals(insert.sql.includes("RETURNING id"), true);

  const vec = builder.buildInsertVecChunk({ chunkId: 1, vectorJson: "[0,0]" });
  assertEquals(vec.args[0], 1n);
});
