import { assertEquals } from "@std/assert";
import { sanitizeFtsQuery } from "./fts-sanitize.ts";

Deno.test("sanitizeFtsQuery - strips punctuation, stopwords, and lowercases", () => {
  assertEquals(
    sanitizeFtsQuery("Ethan is the Explorer!"),
    '"ethan" "explorer"',
  );
  assertEquals(
    sanitizeFtsQuery("  multi   word  query  "),
    '"multi" "word" "query"',
  );
  assertEquals(sanitizeFtsQuery("!!!"), "");
  assertEquals(sanitizeFtsQuery("مرحبا"), '"مرحبا"');
  assertEquals(sanitizeFtsQuery('quote "phrase"'), '"quote" "phrase"');
});
