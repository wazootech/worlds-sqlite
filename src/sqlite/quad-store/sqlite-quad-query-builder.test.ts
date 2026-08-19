import { assertEquals } from "@std/assert";
import { DataFactory } from "n3";
import {
  buildBulkInsertQuads,
  buildCountQuadsQuery,
  buildDeleteQuadsByQuadKeys,
  buildMatchQuadsQuery,
  buildSelectExistingQuadKeys,
  buildSqliteQuadPatternWhereClause,
  buildWipeAllGraphDataStatements,
  generatePlaceholders,
  quadKeyFor,
} from "./sqlite-quad-query-builder.ts";

const { quad, namedNode, literal } = DataFactory;

Deno.test("SqliteQuadQueryBuilder - placeholders and match SQL shape", () => {
  assertEquals(generatePlaceholders(3), "?, ?, ?");

  const pattern = {
    subject: namedNode("urn:s"),
    predicate: null,
    object: literal("hello"),
    graph: null,
  };
  const { conditions, args } = buildSqliteQuadPatternWhereClause(pattern);
  assertEquals(conditions, ["skey = ?", "okey = ?"]);
  assertEquals(args.length, 2);

  const query = buildMatchQuadsQuery(pattern, { limit: 100 });
  assertEquals(
    query.sql.includes("SELECT skey, pkey, okey, gkey, payload FROM quads"),
    true,
  );
  assertEquals(query.sql.includes("ORDER BY skey, pkey, okey, gkey ASC"), true);
  assertEquals(query.sql.endsWith("LIMIT ?"), true);
  assertEquals(query.args.at(-1), "100");
});

Deno.test("SqliteQuadQueryBuilder - match with keyset paging", () => {
  const query = buildMatchQuadsQuery(
    { subject: null, predicate: null, object: null, graph: null },
    { afterKey: ["a", "b", "c", "d"], limit: 50 },
  );
  assertEquals(
    query.sql.includes("(skey, pkey, okey, gkey) > (?, ?, ?, ?)"),
    true,
  );
  assertEquals(query.args.slice(0, 4), ["a", "b", "c", "d"]);
});

Deno.test("SqliteQuadQueryBuilder - count and bulk insert statements", () => {
  const count = buildCountQuadsQuery({
    subject: null,
    predicate: null,
    object: null,
    graph: null,
  });
  assertEquals(count.sql, "SELECT COUNT(*) AS count FROM quads ");
  assertEquals(count.args, []);

  const quadOne = quad(namedNode("urn:a"), namedNode("urn:p"), literal("v1"));
  const quadTwo = quad(namedNode("urn:b"), namedNode("urn:p"), literal("v2"));
  const statements = buildBulkInsertQuads([
    { key: quadKeyFor(quadOne), payload: "{}" },
    { key: quadKeyFor(quadTwo), payload: "{}" },
  ]);
  assertEquals(statements.length, 1);
  assertEquals(
    statements[0].sql.startsWith(
      "INSERT OR REPLACE INTO quads (skey, pkey, okey, gkey, payload) VALUES",
    ),
    true,
  );
  assertEquals(statements[0].args.length, 10);
});

Deno.test("SqliteQuadQueryBuilder - presence, deletion, and wipe statements", () => {
  const keys: Array<[string, string, string, string]> = [
    ["a", "b", "c", "d"],
    ["e", "f", "g", "h"],
  ];
  const select = buildSelectExistingQuadKeys(keys);
  assertEquals(
    select.sql.includes(
      "(skey, pkey, okey, gkey) IN ((?, ?, ?, ?), (?, ?, ?, ?))",
    ),
    true,
  );
  assertEquals(select.args, ["a", "b", "c", "d", "e", "f", "g", "h"]);

  const del = buildDeleteQuadsByQuadKeys(keys);
  assertEquals(
    del.sql.startsWith("DELETE FROM quads WHERE (skey, pkey, okey, gkey) IN"),
    true,
  );

  const wipe = buildWipeAllGraphDataStatements({ vectorSupported: true });
  assertEquals(wipe.map((s) => s.sql), [
    "DELETE FROM chunks_vec",
    "DELETE FROM chunks",
    "DELETE FROM quads",
  ]);
  const keywordOnlyWipe = buildWipeAllGraphDataStatements({
    vectorSupported: false,
  });
  assertEquals(keywordOnlyWipe.map((s) => s.sql), [
    "DELETE FROM chunks",
    "DELETE FROM quads",
  ]);
});
