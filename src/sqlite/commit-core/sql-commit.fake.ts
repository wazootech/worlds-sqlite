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
}

/**
 * FakeSqlStore is an in-memory backend for the SQL commit core. Every
 * `executeBatch` call is atomic (it validates before it applies), and tests arm
 * failures to model a backend whose commit is atomic or not.
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
        for (const statement of statements) this.apply(statement);
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
