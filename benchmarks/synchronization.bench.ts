import { DataFactory } from "n3";
import { createSqliteWorldsSdkForBench } from "./shared/sparql-perf-shared.ts";

const { quad, namedNode, literal } = DataFactory;

const client = createSqliteWorldsSdkForBench();

let indexCounter = 3000;
function generateBatchPayload(count: number) {
  const bulkQuads = [];
  for (let i = 0; i < count; i++) {
    indexCounter++;
    bulkQuads.push(
      quad(
        namedNode(`urn:entity:sync-batch:${indexCounter}`),
        namedNode("urn:property:name"),
        literal(`Batch payload text for unique entity number ${indexCounter}`),
      ),
    );
  }
  return bulkQuads;
}

Deno.bench({
  name: "Sync: Consolidated Batch Commit (10 Quads)",
  group: "Consolidated Batch Ingestion",
  async fn(benchContext) {
    const payload = generateBatchPayload(10);

    benchContext.start();
    await client.import({
      source: { kind: "quads", quads: payload },
    });
    benchContext.end();
  },
});

Deno.bench({
  name: "Sync: Consolidated Batch Commit (100 Quads)",
  group: "Consolidated Batch Ingestion",
  async fn(benchContext) {
    const payload = generateBatchPayload(100);

    benchContext.start();
    await client.import({
      source: { kind: "quads", quads: payload },
    });
    benchContext.end();
  },
});

Deno.bench({
  name: "Sync: Consolidated Batch Commit (1,000 Quads)",
  group: "Consolidated Batch Ingestion",
  async fn(benchContext) {
    const payload = generateBatchPayload(1000);

    benchContext.start();
    await client.import({
      source: { kind: "quads", quads: payload },
    });
    benchContext.end();
  },
});
