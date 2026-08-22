import { DataFactory } from "n3";
import { createSqliteWorldsSdk } from "@/sqlite/create-sqlite-sdk.ts";
import { generateSyntheticQuads } from "./shared/synthetic-data.ts";

const { quad, namedNode, literal } = DataFactory;

const client = await createSqliteWorldsSdk({ path: ":memory:" });

const payload100 = generateSyntheticQuads(100);

let indexCounter = 1000;
function generateFreshPayload(count: number) {
  const freshQuads = [];
  for (let i = 0; i < count; i++) {
    indexCounter++;
    freshQuads.push(
      quad(
        namedNode(`urn:entity:fresh:${indexCounter}`),
        namedNode("urn:property:name"),
        literal(`Fresh payload text for unique entity number ${indexCounter}`),
      ),
    );
  }
  return freshQuads;
}

await client.import({
  source: { kind: "quads", quads: payload100 },
});

Deno.bench({
  name: "Idempotency: Novel Insert (New Quads Ingested)",
  group: "Idempotency Guard Performance",
  async fn(benchContext) {
    const freshPayload = generateFreshPayload(100);

    benchContext.start();
    await client.import({
      source: { kind: "quads", quads: freshPayload },
    });
    benchContext.end();
  },
});

Deno.bench({
  name: "Idempotency: Redundant Insert (Duplicate Quads Suppressed)",
  group: "Idempotency Guard Performance",
  async fn(benchContext) {
    benchContext.start();
    await client.import({
      source: { kind: "quads", quads: payload100 },
    });
    benchContext.end();
  },
});
