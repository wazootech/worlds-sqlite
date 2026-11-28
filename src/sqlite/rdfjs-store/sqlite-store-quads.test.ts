import { test } from "node:test";
import { assertEquals, assertMatch, assertRejects } from "@std/assert";
import { DatabaseSync } from "node:sqlite";
import { DataFactory } from "n3";
import { SqliteStore } from "@/sqlite/rdfjs-store/sqlite-store.ts";

const { namedNode, literal, quad } = DataFactory;
const predicate = namedNode("urn:predicate");
const graph = namedNode("urn:graph");

function seedStore() {
  const db = new DatabaseSync(":memory:");
  const statements: string[] = [];
  const store = new SqliteStore({
    path: ":memory:",
    matchPageSize: 2,
    db: {
      exec: db.exec.bind(db),
      close: db.close.bind(db),
      prepare(sql) {
        statements.push(sql);
        return db.prepare(sql);
      },
    },
  });

  for (const subject of ["urn:e", "urn:d", "urn:c", "urn:b", "urn:a"]) {
    store.addQuad(quad(namedNode(subject), predicate, literal("value"), graph));
  }
  store.addQuad(quad(namedNode("urn:other"), predicate, literal("value")));
  statements.length = 0;
  return { store, statements };
}

test("SqliteStore - counts a graph larger than a page with one aggregate", () => {
  const { store, statements } = seedStore();
  try {
    assertEquals(store.countQuads(null, predicate, null, graph), 5);
    assertEquals(statements.length, 1);
    assertMatch(
      statements[0],
      /^SELECT COUNT\(\*\).*WHERE pkey = \? AND gkey = \?$/,
    );
  } finally {
    store.close();
  }
});

test("SqliteStore - match pulls ordered SQLite pages on demand", () => {
  const { store, statements } = seedStore();
  try {
    const stream = store.match(null, null, null, graph);
    assertEquals(statements, []);
    assertEquals(stream.read()?.subject.value, "urn:a");
    assertEquals(statements.length, 1);
    assertEquals(stream.read()?.subject.value, "urn:b");
    assertEquals(statements.length, 1);
    assertEquals([...stream].map((q) => q.subject.value), [
      "urn:c",
      "urn:d",
      "urn:e",
    ]);
    assertEquals(statements.length, 3);
  } finally {
    store.close();
  }
});

test("SqliteStore - readable match streams can be stopped within the first page", async () => {
  const { store, statements } = seedStore();
  try {
    const stream = store.match(null, null, null, graph);
    const first = await new Promise<ReturnType<typeof stream.read>>(
      (resolve, reject) => {
        stream.on("error", reject);
        stream.once("readable", () => resolve(stream.read()));
      },
    );
    assertEquals(
      first?.subject.value,
      "urn:a",
    );
    stream.destroy();
    assertEquals(stream.read(), null);
    assertEquals(statements.length, 1);
  } finally {
    store.close();
  }
});

test("SqliteStore - match emits a deferred SQLite read error", async () => {
  const { store } = seedStore();
  const stream = store.match(null, null, null, graph);
  store.close();

  await assertRejects(() =>
    new Promise<void>((resolve, reject) => {
      stream.on("data", () => {});
      stream.on("end", resolve);
      stream.on("error", reject);
    })
  );
});

test("SqliteStore - removeMatches deletes a graph with one filtered statement", async () => {
  const { store, statements } = seedStore();
  try {
    const removed = store.removeMatches(null, predicate, null, graph);
    assertEquals(statements.length, 1);
    assertEquals(
      statements[0],
      "DELETE FROM quads WHERE pkey = ? AND gkey = ? RETURNING payload",
    );
    assertEquals(store.getQuads().map((q) => q.subject.value), ["urn:other"]);

    await new Promise<void>((resolve, reject) => {
      removed.on("end", resolve);
      removed.on("error", reject);
    });
  } finally {
    store.close();
  }
});

test("SqliteStore - removeMatches streams exactly the removed quads", async () => {
  const { store } = seedStore();
  try {
    const expected = store.getQuads(null, predicate, null, graph);
    const removed: string[] = [];
    await new Promise<void>((resolve, reject) => {
      store.removeMatches(null, predicate, null, graph)
        .on(
          "data",
          (q) =>
            removed.push((q as { subject: { value: string } }).subject.value),
        )
        .on("end", resolve)
        .on("error", reject);
    });
    assertEquals(removed.sort(), expected.map((q) => q.subject.value).sort());
    assertEquals(removed.length, 5);
    assertEquals(store.size, 1);
  } finally {
    store.close();
  }
});

test("SqliteStore - removeMatches deletes even if the stream is ignored", () => {
  const { store } = seedStore();
  try {
    store.deleteGraph(graph);
    assertEquals(store.size, 1);
  } finally {
    store.close();
  }
});
