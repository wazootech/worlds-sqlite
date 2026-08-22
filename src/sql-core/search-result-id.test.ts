import { assertEquals } from "@std/assert";
import { buildSearchResultId } from "./search-result-id.ts";

Deno.test("buildSearchResultId - stable across identical discovery facts", async () => {
  const first = await buildSearchResultId({
    subject: "urn:ethan",
    predicate: "urn:name",
    graph: "",
    text: "Ethan is the explorer",
  });
  const second = await buildSearchResultId({
    subject: "urn:ethan",
    predicate: "urn:name",
    graph: "",
    text: "Ethan is the explorer",
  });
  assertEquals(first, second);
});

Deno.test("buildSearchResultId - differs across texts and graphs", async () => {
  const base = await buildSearchResultId({
    subject: "urn:ethan",
    predicate: "urn:name",
    graph: "",
    text: "Ethan is the explorer",
  });
  const otherText = await buildSearchResultId({
    subject: "urn:ethan",
    predicate: "urn:name",
    graph: "",
    text: "Ethan is the cartographer",
  });
  const namedGraph = await buildSearchResultId({
    subject: "urn:ethan",
    predicate: "urn:name",
    graph: "urn:g",
    text: "Ethan is the explorer",
  });
  assertEquals(base === otherText, false);
  assertEquals(base === namedGraph, false);
});
