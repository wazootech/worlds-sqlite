import { DatabaseSync } from "node:sqlite";
import { assertEquals, assertRejects } from "@std/assert";
import { SqliteConnectionDriver } from "./sqlite-connection-driver.ts";

function freshDriver(options?: { vectorSupported?: boolean }) {
  const db = new DatabaseSync(":memory:", { allowExtension: true });
  const connection = new SqliteConnectionDriver(db, options);
  return { db, connection };
}

Deno.test("SqliteConnectionDriver - execute returns rows for SELECT and RETURNING", async () => {
  const { connection } = freshDriver();
  await connection.execute({
    sql: "CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT)",
  });

  const inserted = await connection.execute<{ id: number }>({
    sql: "INSERT INTO t (v) VALUES (?) RETURNING id",
    args: ["hello"],
  });
  assertEquals(inserted.rows, [{ id: 1 }]);

  const selected = await connection.execute<{ id: number; v: string }>({
    sql: "SELECT id, v FROM t",
  });
  assertEquals(selected.rows, [{ id: 1, v: "hello" }]);

  const written = await connection.execute({
    sql: "UPDATE t SET v = ?",
    args: ["world"],
  });
  assertEquals(written.rows, []);
});

Deno.test("SqliteConnectionDriver - batch commits atomically and rolls back on failure", async () => {
  const { connection } = freshDriver();
  await connection.execute({ sql: "CREATE TABLE t (v TEXT)" });

  await connection.batch([
    { sql: "INSERT INTO t (v) VALUES (?)", args: ["a"] },
    { sql: "INSERT INTO t (v) VALUES (?)", args: ["b"] },
  ]);
  const rows = await connection.execute<{ v: string }>({
    sql: "SELECT v FROM t ORDER BY v",
  });
  assertEquals(rows.rows.map((r) => r.v), ["a", "b"]);

  // A failing statement rolls the whole batch back.
  await assertRejects(() =>
    connection.batch([
      { sql: "INSERT INTO t (v) VALUES (?)", args: ["c"] },
      { sql: "INSERT INTO t (v) VALUES (?)", args: ["d"] },
      { sql: "INSERT INTO missing (v) VALUES (?)", args: ["e"] },
    ])
  );
  const after = await connection.execute<{ v: string }>({
    sql: "SELECT v FROM t ORDER BY v",
  });
  assertEquals(after.rows.map((r) => r.v), ["a", "b"]);
});

Deno.test("SqliteConnectionDriver - transaction runs fn atomically", async () => {
  const { connection } = freshDriver();
  await connection.execute({ sql: "CREATE TABLE t (v TEXT)" });

  await connection.transaction(async (tx) => {
    await tx.execute({ sql: "INSERT INTO t (v) VALUES (?)", args: ["x"] });
    await tx.execute({ sql: "INSERT INTO t (v) VALUES (?)", args: ["y"] });
  });
  const rows = await connection.execute<{ v: string }>({
    sql: "SELECT v FROM t ORDER BY v",
  });
  assertEquals(rows.rows.map((r) => r.v), ["x", "y"]);

  await assertRejects(() =>
    connection.transaction(async (tx) => {
      await tx.execute({ sql: "INSERT INTO t (v) VALUES (?)", args: ["z"] });
      throw new Error("boom");
    })
  );
  const after = await connection.execute<{ v: string }>({
    sql: "SELECT v FROM t ORDER BY v",
  });
  assertEquals(after.rows.map((r) => r.v), ["x", "y"]);
});

Deno.test("SqliteConnectionDriver - reports vector support flag", () => {
  assertEquals(freshDriver().connection.hasVectorSupport(), false);
  assertEquals(
    freshDriver({ vectorSupported: true }).connection.hasVectorSupport(),
    true,
  );
});

Deno.test("SqliteConnectionDriver - close releases the handle", async () => {
  const { connection } = freshDriver();
  await connection.execute({ sql: "CREATE TABLE t (v TEXT)" });
  await connection.close();
  assertRejects(() => connection.execute({ sql: "SELECT 1" }));
});
