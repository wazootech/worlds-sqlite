import { bench, runBenches } from "./shared/bench.ts";
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

bench(
  {
    name: "Sync: Consolidated Batch Commit (10 Quads)",
    group: "Consolidated Batch Ingestion",
  },
  async (payload) => {
    await client.import({
      source: { kind: "quads", quads: payload },
    });
  },
  () => generateBatchPayload(10),
);

bench(
  {
    name: "Sync: Consolidated Batch Commit (100 Quads)",
    group: "Consolidated Batch Ingestion",
  },
  async (payload) => {
    await client.import({
      source: { kind: "quads", quads: payload },
    });
  },
  () => generateBatchPayload(100),
);

bench(
  {
    name: "Sync: Consolidated Batch Commit (1,000 Quads)",
    group: "Consolidated Batch Ingestion",
  },
  async (payload) => {
    await client.import({
      source: { kind: "quads", quads: payload },
    });
  },
  () => generateBatchPayload(1000),
);

await runBenches();
