import { assertEquals } from "@std/assert";
import { buildChunkFtsValue } from "./search-chunk-fts.ts";

Deno.test("buildChunkFtsValue - indexes only the object-derived value text", () => {
  assertEquals(
    buildChunkFtsValue({
      quad_id: "q1",
      subject: "urn:ethan",
      predicate: "urn:name",
      graph: "",
      value: "Ethan is the explorer",
    }),
    "Ethan is the explorer",
  );
});

Deno.test("buildChunkFtsValue - never leaks subject or predicate IRIs (parity #22)", () => {
  const fts = buildChunkFtsValue({
    quad_id: "q1",
    subject: "urn:secret:subject",
    predicate: "urn:secret:predicate",
    graph: "urn:secret:graph",
    value: "public literal text",
  });
  assertEquals(fts, "public literal text");
  assertEquals(fts.includes("urn:secret"), false);
});
