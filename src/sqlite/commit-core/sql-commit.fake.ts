import type * as rdfjs from "@rdfjs/types";
import type {
  SqlCommitDriver,
  SqlDialect,
  SqlQuadPage,
} from "@/sql-core/mod.ts";
import {
  createFakeDialect,
  type FakeStatement,
} from "./sql-commit-dialect.fake.ts";

export type { FakeStatement };

/** FakeLimits are the driver limits a test configures. */
export interface FakeLimits {
  maxAtomicStatements: number;
  writeBatchSize: number;
  /** statementWeight and maxBatchWeight opt the fake driver into byte-aware batches. */
  statementWeight?: (statement: FakeStatement) => number;
  maxBatchWeight?: number;
}

/** LaterWriteInjection records where `failLaterWrite` landed. */
export interface LaterWriteInjection {
  /** batchNumber is the 1-based executeBatch call that failed. */
  batchNumber: number;
  /** index is the failing statement's position inside that batch. */
  index: number;
  /** precedingKinds lists every statement applied since arming, in order, rolled back or not. */
  precedingKinds: Array<FakeStatement["kind"]>;
}

/**
 * FakeSqlStore is an in-memory backend for the SQL commit core. Every
 * `executeBatch` call is atomic, as the driver contract requires: it applies
 * its statements in order and, if one fails, rolls the whole call back. Tests
 * arm failures; a commit written as one batch is atomic, and one written in
 * several batches is not (earlier batches stay committed, so the core's cleanup
 * has to remove them).
 */
export class FakeSqlStore {
  public readonly quads = new Map<string, { quad: rdfjs.Quad; hash: string }>();
  public chunks: Array<{ quadId: string; text: string; vectorized: boolean }> =
    [];
  /** batches records every executeBatch call, including failed ones. */
  public readonly batches: FakeStatement[][] = [];
  public clearCount = 0;
  public streamCalls = 0;
  public lookups: string[][] = [];
  private failOnBatch: number | undefined;
  private failInsertOnce = false;
  private failCleanupOnce = false;
  private laterArmed = false;
  private laterQuadApplied = false;
  private laterApplied: Array<FakeStatement["kind"]> = [];
  /** laterInjections records each `failLaterWrite` that fired. */
  public readonly laterInjections: LaterWriteInjection[] = [];

  public readonly driver: SqlCommitDriver<FakeStatement>;

  public constructor(
    public readonly limits: FakeLimits,
    keyPrefix = "",
  ) {
    this.driver = this.buildDriver();
    this.dialect = createFakeDialect(keyPrefix);
  }

  /** failNextInsertBatch fails the next batch that holds an insert, once. */
  public failNextInsertBatch(): void {
    this.failInsertOnce = true;
  }

  /**
   * failLaterWrite fails the first chunk-row statement that follows an applied
   * quad write, once. The statement can sit in the same batch as the quad write
   * (the batch rolls back) or in a later batch (earlier batches stay committed).
   */
  public failLaterWrite(): void {
    this.laterArmed = true;
    this.laterQuadApplied = false;
    this.laterApplied = [];
  }

  /** failBatchNumber fails the Nth executeBatch call from now (1-based), once. */
  public failBatchNumber(n: number): void {
    this.failOnBatch = this.batches.length + n;
  }

  /** failCleanup fails the next batch holding a cleanup statement, once. */
  public failCleanup(): void {
    this.failCleanupOnce = true;
  }

  private buildDriver(): SqlCommitDriver<FakeStatement> {
    return {
      ...this.limits,
      executeBatch: (statements) => {
        this.batches.push([...statements]);
        const fails = this.failOnBatch === this.batches.length ||
          (this.failInsertOnce &&
            statements.some((s) => s.kind === "insert")) ||
          (this.failCleanupOnce &&
            statements.some((s) => s.kind === "cleanup"));
        if (fails) {
          this.failOnBatch = undefined;
          this.failInsertOnce = this.failInsertOnce &&
            !statements.some((s) => s.kind === "insert");
          this.failCleanupOnce = this.failCleanupOnce &&
            !statements.some((s) => s.kind === "cleanup");
          return Promise.reject(new Error("injected write failure"));
        }
        const before = this.snapshot();
        try {
          statements.forEach((statement, index) => {
            this.failIfLater(statement, index);
            this.apply(statement);
            this.noteApplied(statement);
          });
        } catch (failure) {
          this.restore(before);
          return Promise.reject(failure);
        }
        return Promise.resolve();
      },
      lookupExisting: (keys) => {
        this.lookups.push(keys);
        return Promise.resolve(new Set(keys.filter((k) => this.quads.has(k))));
      },
      streamQuads: ({ after, pageSize }): Promise<SqlQuadPage> => {
        this.streamCalls++;
        const entries = [...this.quads.entries()].sort(([a], [b]) =>
          a.localeCompare(b)
        );
        const start = typeof after === "number" ? after : 0;
        const quads = entries.slice(start, start + pageSize).map(([, v]) =>
          v.quad
        );
        const next = start + pageSize < entries.length
          ? start + pageSize
          : undefined;
        return Promise.resolve({ quads, next });
      },
    };
  }

  public readonly dialect: SqlDialect<FakeStatement>;

  private failIfLater(statement: FakeStatement, index: number): void {
    if (!this.laterArmed || !this.laterQuadApplied) return;
    if (statement.kind !== "chunk") return;
    this.laterArmed = false;
    this.laterInjections.push({
      batchNumber: this.batches.length,
      index,
      precedingKinds: [...this.laterApplied],
    });
    throw new Error("injected later write failure");
  }

  private noteApplied(statement: FakeStatement): void {
    if (!this.laterArmed) return;
    this.laterApplied.push(statement.kind);
    if (statement.kind === "insert") this.laterQuadApplied = true;
  }

  private snapshot() {
    return {
      quads: new Map(this.quads),
      chunks: [...this.chunks],
      clearCount: this.clearCount,
    };
  }

  private restore(saved: ReturnType<FakeSqlStore["snapshot"]>): void {
    this.quads.clear();
    for (const [key, value] of saved.quads) this.quads.set(key, value);
    this.chunks = saved.chunks;
    this.clearCount = saved.clearCount;
  }

  private apply(statement: FakeStatement): void {
    switch (statement.kind) {
      case "wipe":
        this.quads.clear();
        this.chunks = [];
        break;
      case "clearChunks":
        this.clearCount++;
        this.chunks = [];
        break;
      case "deleteChunks":
        this.chunks = this.chunks.filter((c) =>
          !statement.hashes.includes(c.quadId)
        );
        break;
      case "delete":
      case "cleanup":
        for (const key of statement.keys) this.quads.delete(key);
        this.chunks = this.chunks.filter((c) =>
          !statement.hashes.includes(c.quadId)
        );
        break;
      case "insert":
        this.quads.set(statement.key, {
          quad: statement.quad,
          hash: statement.hash,
        });
        break;
      case "chunk":
        this.chunks.push({
          quadId: statement.quadId,
          text: statement.text,
          vectorized: statement.vectorized,
        });
        break;
    }
  }

  /** executed lists every statement that ran in a successful or failed call, flattened. */
  public executed(kind: FakeStatement["kind"]): FakeStatement[] {
    return this.batches.flat().filter((s) => s.kind === kind);
  }
}
