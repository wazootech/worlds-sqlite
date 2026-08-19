import { DatabaseSync } from "node:sqlite";
import { assertEquals, assertMatch } from "@std/assert";
import { SqliteSchemaBuilder } from "./sqlite-schema-builder.ts";
import { initializeSqliteSchema } from "../initialize-sqlite-schema.ts";
import {
  createTestSqliteConnectionDriver,
  tryLoadVectorExtension,
} from "../sqlite-test-fixtures.ts";

Deno.test("SqliteSchemaBuilder - validates vector dimensions", () => {
  const invalidDimensions = [0, 1537, Number.NaN, -1];
  for (const dimensions of invalidDimensions) {
    let threw = false;
    try {
      new SqliteSchemaBuilder(dimensions);
    } catch {
      threw = true;
    }
    assertEquals(threw, true, `expected rejection for ${dimensions}`);
  }
});

Deno.test("SqliteSchemaBuilder - emits L1 quads table and search tables", () => {
  const builder = new SqliteSchemaBuilder(32, { vectorSupported: true });
  const tables = builder.buildTables().join("\n");
  assertMatch(tables, /CREATE TABLE IF NOT EXISTS quads/);
  assertMatch(tables, /skey TEXT NOT NULL/);
  assertMatch(tables, /payload TEXT NOT NULL/);
  assertMatch(tables, /CREATE TABLE IF NOT EXISTS chunks/);
  assertMatch(
    tables,
    /CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec USING vec0\(\s*embedding float\[32\]/,
  );

  const keywordOnly = new SqliteSchemaBuilder(32, { vectorSupported: false });
  const keywordTables = keywordOnly.buildTables().join("\n");
  assertEquals(keywordTables.includes("chunks_vec"), false);
});

Deno.test("SqliteSchemaBuilder - FTS5 external-content table and sync triggers", () => {
  const builder = new SqliteSchemaBuilder(32);
  assertMatch(builder.buildSqliteChunksFtsTable(), /USING fts5/);
  assertMatch(builder.buildSqliteChunksFtsTable(), /content='chunks'/);
  const triggers = builder.buildSqliteChunksTriggers().join("\n");
  assertMatch(triggers, /chunks_ai AFTER INSERT ON chunks/);
  assertMatch(triggers, /chunks_ad AFTER DELETE ON chunks/);
  assertEquals(builder.buildIndexes().length, 4);
});

Deno.test("initializeSqliteSchema - idempotent and keyword-only without vec", async () => {
  const db = new DatabaseSync(":memory:", { allowExtension: true });
  const connection = createTestSqliteConnectionDriver(db);
  const builder = new SqliteSchemaBuilder(32, { vectorSupported: false });
  await initializeSqliteSchema(connection, builder);
  // Run twice — every DDL is CREATE IF NOT EXISTS.
  await initializeSqliteSchema(connection, builder);

  const tables = (await connection.execute<{ name: string }>(
    {
      sql: "SELECT name FROM sqlite_master WHERE type IN ('table', 'trigger')",
    },
  )).rows.map((r) => r.name).sort();
  assertEquals(tables.includes("quads"), true);
  assertEquals(tables.includes("chunks"), true);
  assertEquals(tables.includes("chunks_fts"), true);
  assertEquals(tables.includes("chunks_vec"), false);
  assertEquals(tables.includes("chunks_ai"), true);
  assertEquals(tables.includes("chunks_ad"), true);

  // FTS search works against the created schema.
  await connection.execute({
    sql:
      "INSERT INTO chunks (quad_id, subject, predicate, graph, value, fts_value) VALUES (?, ?, ?, ?, ?, ?)",
    args: ["q1", "urn:s", "urn:p", "", "needle text", "needle text"],
  });
  const hits = await connection.execute<{ subject: string }>({
    sql:
      "SELECT chunks.subject FROM chunks_fts JOIN chunks ON chunks.id = chunks_fts.rowid WHERE chunks_fts MATCH ?",
    args: ["needle"],
  });
  assertEquals(hits.rows.length, 1);
});

Deno.test("initializeSqliteSchema - creates vec0 table when sqlite-vec loads", async () => {
  const db = new DatabaseSync(":memory:", { allowExtension: true });
  const vecAvailable = await tryLoadVectorExtension(db);
  const connection = createTestSqliteConnectionDriver(db, {
    vectorSupported: vecAvailable,
  });
  const builder = new SqliteSchemaBuilder(32, {
    vectorSupported: vecAvailable,
  });
  await initializeSqliteSchema(connection, builder);

  const vecTables = (await connection.execute<{ name: string }>({
    sql:
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'chunks_vec'",
  })).rows;
  assertEquals(vecTables.length, vecAvailable ? 1 : 0);
});
