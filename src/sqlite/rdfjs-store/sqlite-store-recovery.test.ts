// Crash-recovery suite for SqliteStore (graduated in sparql-engine#56, moved
// here with the store): the durability claims are proven by actually killing
// processes at the failure points, not by asserting behavior in-process:
//
//   1. committed → hard exit (no close()) → reopen → committed quad intact;
//   2. buffered-but-uncommitted → exit → reopen → dataset untouched;
//   3. kill mid-BEGIN IMMEDIATE (raw WAL frames, never committed) → reopen →
//      interrupted transaction rolled back;
//   4. two concurrent writers → both datasets land in full (busy_timeout
//      serializes them; no interleaved partial commits).
//
// Each scenario runs in its own child Deno process via Deno.Command, so the
// parent can never accidentally share in-memory state with the "crashing"
// writer.
import { assertEquals } from "@std/assert";
import { dirname, fromFileUrl, join, resolve } from "@std/path";
import { SqliteStore } from "@/sqlite/rdfjs-store/sqlite-store.ts";

const REPO_ROOT = resolve(dirname(fromFileUrl(import.meta.url)), "../../..");
const CHILD_SCRIPT = join(REPO_ROOT, "test", "sqlite-recovery-child.ts");

/**
 * runChild spawns the recovery child and resolves with its exit code and
 * stderr (stderr is attached to assertion messages so a child failure is
 * diagnosable — the child prints the underlying SQLite error).
 */
async function runChild(
  ...args: string[]
): Promise<{ code: number; stderr: string }> {
  const command = new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-all", CHILD_SCRIPT, ...args],
    cwd: REPO_ROOT,
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stderr } = await command.output();
  return { code, stderr: new TextDecoder().decode(stderr) };
}

/** tempDbPath returns a fresh temp db path for one scenario. */
function tempDbPath(): string {
  const dir = Deno.makeTempDirSync();
  return `${dir}/recovery.sqlite`;
}

/** collectQuads reopens the file and returns its quads. */
function collectQuads(path: string): unknown[] {
  const store = new SqliteStore({ path });
  try {
    return store.getQuads(null, null, null, null);
  } finally {
    store.close();
  }
}

Deno.test("SqliteStore recovery - committed update survives a hard process exit", async () => {
  const path = tempDbPath();
  // The child commits then dies without close().
  const { code, stderr } = await runChild("commit-exit", path);
  assertEquals(code, 0, stderr);
  const quads = collectQuads(path);
  assertEquals(quads.length, 1);
  assertEquals(
    (quads[0] as { subject: { value: string } }).subject.value,
    "http://example.org/s",
  );
});

Deno.test("SqliteStore recovery - uncommitted buffered writes roll back", async () => {
  const path = tempDbPath();
  // The child buffers writes in a transaction and exits before commit.
  const { code, stderr } = await runChild("buffered-exit", path);
  assertEquals(code, 1, stderr);
  assertEquals(collectQuads(path).length, 0);
});

Deno.test("SqliteStore recovery - kill mid-BEGIN IMMEDIATE rolls back on reopen", async () => {
  const path = tempDbPath();
  // The child writes raw WAL frames inside an uncommitted transaction.
  const { code, stderr } = await runChild("raw-mid-transaction", path);
  assertEquals(code, 1, stderr);
  assertEquals(collectQuads(path).length, 0);
});

Deno.test("SqliteStore recovery - concurrent writers never interleave partial commits", async () => {
  const path = tempDbPath();
  // Two writers race on the write lock; busy_timeout serializes them.
  const [writerA, writerB] = await Promise.all([
    runChild("concurrent-writer", path, "a"),
    runChild("concurrent-writer", path, "b"),
  ]);
  assertEquals(writerA.code, 0, writerA.stderr);
  assertEquals(writerB.code, 0, writerB.stderr);
  const quads = collectQuads(path);
  // Each writer committed 5 rounds x 20 quads = 100; both must be complete.
  assertEquals(quads.length, 200);
  const subjects = new Set(
    quads.map((item) => (item as { subject: { value: string } }).subject.value),
  );
  assertEquals(subjects.size, 200);
  for (let round = 0; round < 5; round++) {
    for (let index = 0; index < 20; index++) {
      assertEquals(
        subjects.has(`http://example.org/a-${round}-${index}`),
        true,
        `missing writer a quad a-${round}-${index}`,
      );
      assertEquals(
        subjects.has(`http://example.org/b-${round}-${index}`),
        true,
        `missing writer b quad b-${round}-${index}`,
      );
    }
  }
});
