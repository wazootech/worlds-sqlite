/**
 * SqliteRuntimePortabilitySuite — the core SqliteStore + SqliteConnectionDriver
 * surface run against ANY synchronous SQLite handle (AnySyncSqliteHandle), so
 * the "works on node:sqlite AND bun:sqlite" claim is continuously enforced
 * rather than asserted once.
 *
 * The body is deliberately runtime-agnostic:
 * - it never imports Deno or bun APIs — tests are registered through the
 *   injected registrar (Deno.test on Deno, bun:test's `test` on Bun);
 * - it asserts with node:assert (a zero-dependency builtin on Node, Bun, and
 *   Deno's node-compat layer) instead of @std/assert, keeping the Bun CI job
 *   free of jsr-only test dependencies;
 * - handles come from the injected `makeHandle` / `createHandleFromPath`, so
 *   each runtime wrapper supplies its own builtin.
 *
 * Every case mirrors an existing Deno-side test (sqlite-store.test.ts /
 * sqlite-connection-driver.test.ts) so the two suites can drift apart loudly.
 */
import { strict as assert } from "node:assert/strict";
import type * as rdfjs from "@rdfjs/types";
import { DataFactory } from "n3";
import type { AnySyncSqliteHandle } from "@/sqlite/any-sync-sqlite-handle.ts";
import { SqliteStore } from "@/sqlite/rdfjs-store/sqlite-store.ts";
import { SqliteConnectionDriver } from "@/sqlite/sqlite-connection-driver.ts";
import { sameRdfTerm } from "@/sqlite/term/term-key.ts";

const { namedNode, literal, quad, defaultGraph } = DataFactory;

const ex = (suffix: string) => namedNode(`http://example.org/${suffix}`);

/**
 * plainRows spreads null-prototype rows (node:sqlite) into plain objects so
 * node:assert's deepStrictEqual compares them equally with bun:sqlite's
 * ordinary plain-object rows.
 */
function plainRows<Row extends Record<string, unknown>>(rows: Row[]): Row[] {
  return rows.map((row) => ({ ...row }));
}

/** SqlitePortabilityTestRegistrar registers one test on the host runtime. */
export interface SqlitePortabilityTestRegistrar {
  (name: string, fn: () => void | Promise<void>): void;
}

/** SqliteRuntimePortabilitySuiteOptions supplies the runtime under test. */
export interface SqliteRuntimePortabilitySuiteOptions {
  /** label identifies the runtime under test in test names (e.g. "node:sqlite"). */
  label: string;

  /** makeHandle opens a fresh in-memory handle on the runtime under test. */
  makeHandle: () => AnySyncSqliteHandle;

  /**
   * createHandleFromPath mirrors the injectable default-construction seam
   * (SqliteStoreOptions.createHandle / SqliteWorldsSdkOptions.createHandle)
   * on the runtime under test.
   */
  createHandleFromPath: (path: string) => AnySyncSqliteHandle;
}

/** runSqliteRuntimePortabilitySuite registers the whole portability suite. */
export function runSqliteRuntimePortabilitySuite(
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

  test(`${label} shared handle - one handle powers store and driver (createSqliteWorldsSdk shape)`, () => {
    const db = makeHandle();
    const store = new SqliteStore({ path: ":memory:", db });
    const connection = new SqliteConnectionDriver(db);

    store.addQuad(quad(ex("alice"), ex("name"), literal("Alice")));
    assert.equal(store.size, 1);
    assert.equal(connection.hasVectorSupport(), false);

    // The driver reads the store's own table through the SAME handle.
    const rows = connection.execute<{ payload: string }>({
      sql: "SELECT payload FROM quads",
    }).then((result) => result.rows);
    // execute is sync-underneath; await the promise it returns.
    return rows.then((result) => {
      assert.equal(result.length, 1);
    }).finally(() => {
      store.close(); // closes the shared handle, like SqliteWorldsSdk.close()
    });
  });

  test(`${label} SqliteConnectionDriver - execute returns rows for SELECT and RETURNING`, async () => {
    const connection = new SqliteConnectionDriver(makeHandle());
    await connection.execute({
      sql: "CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT)",
    });

    const inserted = await connection.execute<{ id: number }>({
      sql: "INSERT INTO t (v) VALUES (?) RETURNING id",
      args: ["hello"],
    });
    assert.deepEqual(plainRows(inserted.rows), [{ id: 1 }]);

    const selected = await connection.execute<{ id: number; v: string }>({
      sql: "SELECT id, v FROM t",
    });
    assert.deepEqual(plainRows(selected.rows), [{ id: 1, v: "hello" }]);

    const written = await connection.execute({
      sql: "UPDATE t SET v = ?",
      args: ["world"],
    });
    assert.deepEqual(written.rows, []);
    await connection.close();
  });

  test(`${label} SqliteConnectionDriver - batch commits atomically and rolls back on failure`, async () => {
    const connection = new SqliteConnectionDriver(makeHandle());
    await connection.execute({ sql: "CREATE TABLE t (v TEXT)" });

    await connection.batch([
      { sql: "INSERT INTO t (v) VALUES (?)", args: ["a"] },
      { sql: "INSERT INTO t (v) VALUES (?)", args: ["b"] },
    ]);
    const rows = await connection.execute<{ v: string }>({
      sql: "SELECT v FROM t ORDER BY v",
    });
    assert.deepEqual(rows.rows.map((r) => r.v), ["a", "b"]);

    // A failing statement rolls the whole batch back.
    await assert.rejects(() =>
      connection.batch([
        { sql: "INSERT INTO t (v) VALUES (?)", args: ["c"] },
        { sql: "INSERT INTO missing (v) VALUES (?)", args: ["d"] },
      ])
    );
    const after = await connection.execute<{ v: string }>({
      sql: "SELECT v FROM t ORDER BY v",
    });
    assert.deepEqual(after.rows.map((r) => r.v), ["a", "b"]);
    await connection.close();
  });

  test(`${label} SqliteConnectionDriver - transaction runs fn atomically`, async () => {
    const connection = new SqliteConnectionDriver(makeHandle());
    await connection.execute({ sql: "CREATE TABLE t (v TEXT)" });

    await connection.transaction(async (tx) => {
      await tx.execute({ sql: "INSERT INTO t (v) VALUES (?)", args: ["x"] });
      await tx.execute({ sql: "INSERT INTO t (v) VALUES (?)", args: ["y"] });
    });
    const rows = await connection.execute<{ v: string }>({
      sql: "SELECT v FROM t ORDER BY v",
    });
    assert.deepEqual(rows.rows.map((r) => r.v), ["x", "y"]);

    await assert.rejects(() =>
      connection.transaction(async (tx) => {
        await tx.execute({ sql: "INSERT INTO t (v) VALUES (?)", args: ["z"] });
        throw new Error("boom");
      })
    );
    const after = await connection.execute<{ v: string }>({
      sql: "SELECT v FROM t ORDER BY v",
    });
    assert.deepEqual(after.rows.map((r) => r.v), ["x", "y"]);
    await connection.close();
  });

  test(`${label} SqliteConnectionDriver - reports vector support flag`, () => {
    assert.equal(
      new SqliteConnectionDriver(makeHandle()).hasVectorSupport(),
      false,
    );
    assert.equal(
      new SqliteConnectionDriver(makeHandle(), { vectorSupported: true })
        .hasVectorSupport(),
      true,
    );
  });

  test(`${label} SqliteConnectionDriver - close releases the handle`, async () => {
    const connection = new SqliteConnectionDriver(makeHandle());
    await connection.execute({ sql: "CREATE TABLE t (v TEXT)" });
    await connection.close();
    await assert.rejects(() => connection.execute({ sql: "SELECT 1" }));
  });
}
