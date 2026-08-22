import { assertEquals } from "@std/assert";
import {
  buildChunksFtsTable,
  buildChunksQuadIdIndex,
  buildChunksTable,
  buildChunksTriggers,
} from "./chunk-schema.ts";

Deno.test("buildChunksTable - materialized chunk table without vector columns", () => {
  const ddl = buildChunksTable();
  assertEquals(ddl.includes("CREATE TABLE IF NOT EXISTS chunks"), true);
  assertEquals(ddl.includes("fts_value TEXT NOT NULL"), true);
  assertEquals(ddl.includes("vector"), false);
});

Deno.test("buildChunksQuadIdIndex - content-addressed deletion sweep index", () => {
  assertEquals(
    buildChunksQuadIdIndex(),
    "CREATE INDEX IF NOT EXISTS idx_chunks_quad_id ON chunks (quad_id)",
  );
});

Deno.test("buildChunksFtsTable - external-content FTS5 keyed by chunks.id", () => {
  const ddl = buildChunksFtsTable();
  assertEquals(
    ddl.includes(`content='chunks'`) && ddl.includes(`content_rowid='id'`),
    true,
  );
});

Deno.test("buildChunksTriggers - keeps the external FTS index in sync", () => {
  const triggers = buildChunksTriggers();
  assertEquals(triggers.length, 2);
  assertEquals(triggers[0].includes("AFTER INSERT ON chunks"), true);
  assertEquals(triggers[1].includes("AFTER DELETE ON chunks"), true);
});
