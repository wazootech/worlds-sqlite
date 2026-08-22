import { assertEquals, assertExists } from "@std/assert";
import { DataFactory } from "n3";
import { createSqliteWorldsSdk } from "./create-sqlite-sdk.ts";
import { FakeEmbeddingService } from "@worlds/sdk/search-index/embedding-service";

const { quad, namedNode, literal } = DataFactory;

Deno.test("createSqliteWorldsSdk - serves SPARQL on the shared SqliteStore", async () => {
  const sdk = await createSqliteWorldsSdk({ path: ":memory:" });
  try {
    assertExists(sdk);
    await sdk.import({
      source: {
        kind: "quads",
        quads: [
          quad(
            namedNode("urn:entity:hex"),
            namedNode("urn:label"),
            literal("persistent client"),
          ),
        ],
      },
    });

    const sparqlResponse = await sdk.sparql({
      query: "SELECT ?o WHERE { <urn:entity:hex> <urn:label> ?o }",
    });
    assertEquals(sparqlResponse.kind, "select");
  } finally {
    sdk.close();
  }
});

Deno.test("createSqliteWorldsSdk - SPARQL INSERT DATA round-trips through the transaction commit", async () => {
  const sdk = await createSqliteWorldsSdk({ path: ":memory:" });
  try {
    const insertResponse = await sdk.sparql({
      query:
        `INSERT DATA { <urn:e2e:subject> <urn:e2e:predicate> "roundtrip-value" }`,
    });
    assertEquals(insertResponse.kind, "void");

    const selectResponse = await sdk.sparql({
      query: "SELECT ?o WHERE { <urn:e2e:subject> <urn:e2e:predicate> ?o }",
    });
    assertEquals(selectResponse.kind, "select");
    if (selectResponse.kind === "select") {
      assertEquals(selectResponse.data.results.bindings.length, 1);
      assertEquals(
        selectResponse.data.results.bindings[0].o?.value,
        "roundtrip-value",
      );
    }
  } finally {
    sdk.close();
  }
});

Deno.test("createSqliteWorldsSdk - search + reindex over the materialized index", async () => {
  const sdk = await createSqliteWorldsSdk({ path: ":memory:" });
  try {
    await sdk.import({
      source: {
        kind: "quads",
        quads: [
          quad(
            namedNode("urn:ethan"),
            namedNode("urn:name"),
            literal("Ethan the explorer"),
          ),
          quad(
            namedNode("urn:gregory"),
            namedNode("urn:name"),
            literal("Gregory stays back"),
          ),
        ],
      },
    });

    const search = await sdk.search({ query: "explorer", topK: 10 });
    assertEquals(search.results?.length, 1);
    assertEquals(search.results?.[0].subject, "urn:ethan");

    const reindex = await sdk.reindex();
    assertEquals(reindex.processedQuadCount, 2);
    assertEquals(reindex.chunkRowCount, 2);
  } finally {
    sdk.close();
  }
});

Deno.test("createSqliteWorldsSdk - hybrid search works when sqlite-vec loads, degrades otherwise", async () => {
  const sdk = await createSqliteWorldsSdk({
    path: ":memory:",
    vectorDimensions: 32,
    embeddingService: new FakeEmbeddingService(),
  });
  try {
    await sdk.import({
      source: {
        kind: "quads",
        quads: [
          quad(
            namedNode("urn:x"),
            namedNode("urn:p"),
            literal("alpha beta gamma"),
          ),
          quad(
            namedNode("urn:y"),
            namedNode("urn:p"),
            literal("delta epsilon"),
          ),
        ],
      },
    });
    const search = await sdk.search({ query: "beta", topK: 10 });
    // Hybrid fusion: keyword matches the beta row; the fake embedding service
    // emits identical vectors for every row, so the vector branch contributes
    // both rows. The keyword hit ranks first.
    assertEquals(search.results?.length, 2);
    assertEquals(search.results?.[0].text, "alpha beta gamma");
  } finally {
    sdk.close();
  }
});

Deno.test("createSqliteWorldsSdk - loadVectorExtension:false forces keyword-only (no vec tables)", async () => {
  const sdk = await createSqliteWorldsSdk({
    path: ":memory:",
    loadVectorExtension: false,
    embeddingService: new FakeEmbeddingService(),
  });
  try {
    await sdk.import({
      source: {
        kind: "quads",
        quads: [
          quad(
            namedNode("urn:x"),
            namedNode("urn:p"),
            literal("needle keyword only"),
          ),
        ],
      },
    });
    const search = await sdk.search({ query: "needle", topK: 10 });
    assertEquals(search.results?.length, 1);
    assertEquals(search.results?.[0].text, "needle keyword only");
  } finally {
    sdk.close();
  }
});

Deno.test("createSqliteWorldsSdk - include/exclude scope routes imports and search", async () => {
  const sdk = await createSqliteWorldsSdk({
    path: ":memory:",
    include: { subjects: ["urn:kept"] },
  });
  try {
    await sdk.import({
      source: {
        kind: "quads",
        quads: [
          quad(
            namedNode("urn:kept"),
            namedNode("urn:p"),
            literal("kept needle"),
          ),
          quad(
            namedNode("urn:drop"),
            namedNode("urn:p"),
            literal("dropped needle"),
          ),
        ],
      },
    });

    const exported = await sdk.export({ format: { kind: "quads" } });
    if (exported.kind === "quads") {
      assertEquals(exported.quads.length, 1);
      assertEquals(exported.quads[0].subject.value, "urn:kept");
    }
  } finally {
    sdk.close();
  }
});
