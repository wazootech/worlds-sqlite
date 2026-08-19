import { DatabaseSync } from "node:sqlite";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { FakeEmbeddingService } from "@worlds/sdk/search-index/embedding-service";
import { createSqliteSdk } from "@/sqlite/create-sqlite-sdk.ts";
import { SqliteConnectionDriver } from "@/sqlite/sqlite-connection-driver.ts";
import { initializeSqliteSchema } from "@/sqlite/initialize-sqlite-schema.ts";
import { SqliteSchemaBuilder } from "@/sqlite/schema/sqlite-schema-builder.ts";
import { SqliteSearchQueryBuilder } from "@/sqlite/search-index/sqlite-search-query-builder.ts";
import { rebuildSqliteSearchIndexFromQuads } from "@/sqlite/search-index/rebuild-sqlite-search-index-from-quads.ts";
import { generateSyntheticQuads } from "./shared/synthetic-data.ts";

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
const queryBuilder = new SqliteSearchQueryBuilder(VECTOR_DIMENSIONS, {
  vectorSupported,
});
await initializeSqliteSchema(
  connection,
  new SqliteSchemaBuilder(VECTOR_DIMENSIONS, { vectorSupported }),
);

const worldsClient = await createSqliteSdk({
  path: ":memory:",
  db,
  loadVectorExtension: false,
  searchIndexOnImport: "disabled",
});

const sampleQuads = generateSyntheticQuads(1000);
await worldsClient.import({
  source: { kind: "quads", quads: sampleQuads },
});

const maintenanceOptions = {
  connection,
  searchQueryBuilder: queryBuilder,
  embeddingService: new FakeEmbeddingService(),
  textSplitter: new RecursiveCharacterTextSplitter({ chunkSize: 1000 }),
};

Deno.bench({
  name: "Maintenance: Full Index Rebuild (1,000 Quads)",
  group: "Index Maintenance",
  async fn(benchContext) {
    benchContext.start();
    await rebuildSqliteSearchIndexFromQuads(maintenanceOptions);
    benchContext.end();
  },
});
