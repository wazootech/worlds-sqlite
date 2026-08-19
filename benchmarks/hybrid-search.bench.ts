import { DatabaseSync } from "node:sqlite";
import { FakeEmbeddingService } from "@worlds/sdk/search-index/embedding-service";
import type { EmbeddingService } from "@worlds/sdk/search-index/embedding-service";
import { SqliteConnectionDriver } from "@/sqlite/sqlite-connection-driver.ts";
import { initializeSqliteSchema } from "@/sqlite/initialize-sqlite-schema.ts";
import { SqliteSchemaBuilder } from "@/sqlite/schema/sqlite-schema-builder.ts";
import { SqliteSearchIndex } from "@/sqlite/search-index/sqlite-search-index.ts";
import { SqliteSearchQueryBuilder } from "@/sqlite/search-index/sqlite-search-query-builder.ts";

class FailingEmbeddingService implements EmbeddingService {
  public embed(_texts: string[]): Promise<Array<Float32Array>> {
    return Promise.reject(
      new Error("Simulated network timeout/offline service."),
    );
  }
}

const VECTOR_DIMENSIONS = 32;

const db = new DatabaseSync(":memory:", { allowExtension: true });

let vectorSupported = false;
try {
  const { load } = await import("sqlite-vec");
  load(db);
  vectorSupported = true;
} catch {
  // keyword-only degradation path
}

const connection = new SqliteConnectionDriver(db, { vectorSupported });
const schemaBuilder = new SqliteSchemaBuilder(VECTOR_DIMENSIONS, {
  vectorSupported,
});
const queryBuilder = new SqliteSearchQueryBuilder(VECTOR_DIMENSIONS, {
  vectorSupported,
});
await initializeSqliteSchema(connection, schemaBuilder);

const vectorArray = new Array(VECTOR_DIMENSIONS).fill(0);
vectorArray[0] = 1.0;
const vectorJsonString = JSON.stringify(vectorArray);

async function insertChunkRow(
  index: number,
): Promise<void> {
  const text = `Document payload text index ${index} with unique keywords.`;
  const inserted = await connection.execute<{ id: number | bigint }>({
    sql:
      "INSERT INTO chunks (quad_id, subject, predicate, graph, value, fts_value) VALUES (?, ?, ?, ?, ?, ?) RETURNING id",
    args: [
      `id-${index}`,
      `urn:entity:${index}`,
      "urn:property:name",
      "urn:graph:main",
      text,
      text,
    ],
  });
  if (vectorSupported) {
    const chunkId = inserted.rows[0]?.id;
    if (chunkId != null) {
      await connection.execute({
        sql: "INSERT INTO chunks_vec (rowid, embedding) VALUES (?, ?)",
        args: [BigInt(chunkId), vectorJsonString],
      });
    }
  }
}

for (let index = 0; index < 1000; index++) {
  await insertChunkRow(index);
}

const ftsSearchIndex = new SqliteSearchIndex({
  connection,
  searchQueryBuilder: queryBuilder,
});

const hybridSearchIndex = new SqliteSearchIndex({
  connection,
  embeddingService: new FakeEmbeddingService(),
  searchQueryBuilder: queryBuilder,
});

const fallbackSearchIndex = new SqliteSearchIndex({
  connection,
  embeddingService: new FailingEmbeddingService(),
  searchQueryBuilder: queryBuilder,
});

Deno.bench({
  name: "Search: FTS5 Keyword-Only Search (Vectorless Mode)",
  group: "Hybrid Search Performance",
  async fn(benchContext) {
    benchContext.start();
    await ftsSearchIndex.search({ query: "unique keywords" });
    benchContext.end();
  },
});

Deno.bench({
  name: "Search: Hybrid RRF Fusion Search (Vector + FTS5)",
  group: "Hybrid Search Performance",
  async fn(benchContext) {
    benchContext.start();
    await hybridSearchIndex.search({ query: "unique keywords" });
    benchContext.end();
  },
});

Deno.bench({
  name: "Search: Graceful Degradation (Fallback to FTS5 on Error)",
  group: "Hybrid Search Performance",
  async fn(benchContext) {
    benchContext.start();
    await fallbackSearchIndex.search({ query: "unique keywords" });
    benchContext.end();
  },
});
