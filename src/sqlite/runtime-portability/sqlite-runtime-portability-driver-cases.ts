import { strict as assert } from "node:assert/strict";
import { SqliteStore } from "@/sqlite/rdfjs-store/sqlite-store.ts";
import { SqliteConnectionDriver } from "@/sqlite/sqlite-connection-driver.ts";
import {
  ex,
  literal,
  plainRows,
  quad,
} from "./sqlite-runtime-portability-shared.ts";
import type {
  SqlitePortabilityTestRegistrar,
  SqliteRuntimePortabilitySuiteOptions,
} from "./sqlite-runtime-portability-shared.ts";

/** registerDriverCases registers the shared-handle and SqliteConnectionDriver cases. */
export function registerDriverCases(
  test: SqlitePortabilityTestRegistrar,
  options: SqliteRuntimePortabilitySuiteOptions,
): void {
  const { label, makeHandle } = options;

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
