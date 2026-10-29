import { strict as assert } from "node:assert/strict";
import type * as rdfjs from "@rdfjs/types";
import { SqliteStore } from "@/sqlite/rdfjs-store/sqlite-store.ts";
import { sameRdfTerm } from "@/sqlite/term/term-key.ts";
import {
  defaultGraph,
  ex,
  literal,
  namedNode,
  quad,
} from "./sqlite-runtime-portability-shared.ts";
import type {
  SqlitePortabilityTestRegistrar,
  SqliteRuntimePortabilitySuiteOptions,
} from "./sqlite-runtime-portability-shared.ts";

/** registerStoreCases registers the SqliteStore portability cases. */
export function registerStoreCases(
  test: SqlitePortabilityTestRegistrar,
  options: SqliteRuntimePortabilitySuiteOptions,
): void {
  const { label, makeHandle, createHandleFromPath } = options;

  test(
    `${label} SqliteStore - round-trips literal and RDF-star terms with fidelity`,
    () => {
      const store = new SqliteStore({
        path: ":memory:",
        createHandle: createHandleFromPath,
      });
      const langLit = literal("hola", "es");
      const typedLit = literal(
        "42",
        namedNode("http://www.w3.org/2001/XMLSchema#integer"),
      );
      const starTerm = quad(ex("alice"), ex("knows"), ex("bob"));
      store.addQuad(quad(ex("alice"), ex("name"), langLit));
      store.addQuad(quad(ex("alice"), ex("name"), typedLit));
      store.addQuad(quad(ex("alice"), ex("knows"), starTerm));

      const got = store.getQuads();
      assert.equal(got.length, 3);
      const langBack = got.find((q) =>
        q.object.termType === "Literal" &&
        (q.object as rdfjs.Literal).language === "es"
      );
      assert.equal(langBack !== undefined, true);
      assert.equal(sameRdfTerm(langBack!.object, langLit), true);
      const typedBack = got.find((q) =>
        q.object.termType === "Literal" &&
        (q.object as rdfjs.Literal).datatype.value.includes("integer")
      );
      assert.equal(sameRdfTerm(typedBack!.object, typedLit), true);
      const starBack = got.find((q) => q.object.termType === "Quad");
      assert.equal(starBack !== undefined, true);
      assert.equal(sameRdfTerm(starBack!.object, starTerm), true);
      store.close();
    },
  );

  test(`${label} SqliteStore - quads differing only by graph do not collide`, () => {
    const db = makeHandle();
    const store = new SqliteStore({ path: ":memory:", db });
    const subject = ex("alice");
    const predicate = ex("name");
    const object = literal("A");
    store.addQuad(quad(subject, predicate, object, ex("g/a")));
    store.addQuad(quad(subject, predicate, object, ex("g/b")));
    store.addQuad(quad(subject, predicate, object, defaultGraph()));

    assert.equal(store.size, 3);
    assert.equal(store.countQuads(), 3);
    assert.equal(store.countQuads(null, null, null, ex("g/a")), 1);
    assert.equal(store.countQuads(null, null, null, defaultGraph()), 1);

    store.removeQuad(quad(subject, predicate, object, ex("g/a")));
    assert.equal(store.size, 2);
    store.close();
  });

  test(`${label} SqliteStore - transaction commit, rollback, and add/delete netting`, async () => {
    const store = new SqliteStore({
      path: ":memory:",
      createHandle: createHandleFromPath,
    });

    const txn = store.createTransaction();
    txn.add(quad(ex("alice"), ex("name"), literal("Alice")));
    txn.add(quad(ex("bob"), ex("name"), literal("Bob")));
    txn.rollback();
    assert.equal(store.size, 0);

    const netOut = store.createTransaction();
    netOut.add(quad(ex("alice"), ex("name"), literal("Alice")));
    netOut.delete(quad(ex("alice"), ex("name"), literal("Alice")));
    await netOut.commit();
    assert.equal(store.size, 0);

    const netIn = store.createTransaction();
    netIn.delete(quad(ex("alice"), ex("name"), literal("Alice")));
    netIn.add(quad(ex("alice"), ex("name"), literal("Alice")));
    await netIn.commit();
    assert.equal(store.size, 1);
    store.close();
  });

  test(`${label} SqliteStore - failed commit rolls back every buffered write`, async () => {
    const store = new SqliteStore({
      path: ":memory:",
      createHandle: createHandleFromPath,
      beforeCommit: () => {
        throw new Error("simulated commit failure");
      },
    });
    const txn = store.createTransaction();
    txn.add(quad(ex("alice"), ex("name"), literal("Alice")));
    txn.add(quad(ex("bob"), ex("name"), literal("Bob")));
    await assert.rejects(() => txn.commit(), /simulated commit failure/);

    // Nothing was persisted, and the store remains usable.
    assert.equal(store.size, 0);
    store.addQuad(quad(ex("alice"), ex("name"), literal("Alice")));
    assert.equal(store.size, 1);
    store.close();
  });

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
