import { strict as assert } from "node:assert/strict";
import { SqliteStore } from "@/sqlite/rdfjs-store/sqlite-store.ts";
import { ex, literal, quad } from "./sqlite-runtime-portability-shared.ts";
import type {
  SqlitePortabilityTestRegistrar,
  SqliteRuntimePortabilitySuiteOptions,
} from "./sqlite-runtime-portability-shared.ts";

/** registerStorePagingCases registers the graph-delete, paging, and close cases. */
export function registerStorePagingCases(
  test: SqlitePortabilityTestRegistrar,
  options: SqliteRuntimePortabilitySuiteOptions,
): void {
  const { label, makeHandle, createHandleFromPath } = options;

  test(`${label} SqliteStore - deleteGraph clears exactly one graph`, () => {
    const store = new SqliteStore({
      path: ":memory:",
      createHandle: createHandleFromPath,
    });
    store.addQuad(quad(ex("alice"), ex("name"), literal("A"), ex("g/a")));
    store.addQuad(quad(ex("alice"), ex("name"), literal("A"), ex("g/b")));
    store.deleteGraph(ex("g/a").value);
    assert.equal(store.size, 1);
    assert.equal(store.countQuads(null, null, null, ex("g/a")), 0);
    assert.equal(store.countQuads(null, null, null, ex("g/b")), 1);
    store.close();
  });

  test(`${label} SqliteStore - getQuads pages across matchPageSize without skips or duplicates`, () => {
    const store = new SqliteStore({
      path: ":memory:",
      createHandle: createHandleFromPath,
      matchPageSize: 7,
    });
    for (let index = 0; index < 20; index++) {
      store.addQuad(
        quad(ex(`s${index}`), ex("name"), literal(`value-${index}`)),
      );
    }

    const paged = store.getQuads();
    assert.equal(paged.length, 20);
    assert.equal(new Set(paged.map((q) => q.subject.value)).size, 20);

    const subjectPaged = store.getQuads(ex("s3"), null, null, null);
    assert.equal(subjectPaged.length, 1);
    assert.equal(subjectPaged[0]!.object.value, "value-3");
    store.close();
  });

  test(`${label} SqliteStore - close releases the handle`, () => {
    const db = makeHandle();
    const store = new SqliteStore({ path: ":memory:", db });
    store.addQuad(quad(ex("alice"), ex("name"), literal("Alice")));
    assert.equal(store.size, 1);
    store.close();
    assert.throws(() => store.getQuads());
  });
}
