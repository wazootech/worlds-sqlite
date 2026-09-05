# @worlds/sqlite

Local synchronous-SQLite durable backend for the Worlds client
([`@worlds/sdk`](https://jsr.io/@worlds/sdk)) — single-process, local-file
storage over `node:sqlite` (Node/Deno) or `bun:sqlite` (Bun), with optional
`sqlite-vec` extension for vector search.

Part of the Worlds durable-backend family alongside `@worlds/libsql` (Turso),
`@worlds/postgres`, and `@worlds/cloudflare`. The provider-strategy vocabulary
is backend-internal (per the de-escalated seam decision,
[worlds-sdk-ts#170](https://github.com/wazootech/worlds-sdk-ts/issues/170));
cross-backend interchangeability lives at the `@worlds/sdk` `WorldsSdk` seam.

## Status

Two layers (plan:
[worlds-sqlite#1](https://github.com/wazootech/worlds-sqlite/issues/1)):

- **Layer 1 — RDF/JS quad primitive (`SqliteStore`): landed.** The store moved
  here from `@wazoo/sparql-engine/sqlite` (packaged with the worlds impl per the
  ecosystem pattern — `LibsqlRdfjsStore` lives in `@worlds/libsql`,
  `PostgresRdfjsStore` in `@worlds/postgres`), re-based on `n3`'s DataFactory
  (the `@worlds/sdk` choice) with term identity parity-tested against the
  engine. Published as `@worlds/sqlite` (root + `./rdfjs-store` subpath).
- **Layer 2 — Worlds impl (`createSqliteWorldsSdk`): landed.** The full L2 SDK
  surface shipped as part of the durable-backend parity campaign
  ([worlds-sqlite#7](https://github.com/wazootech/worlds-sqlite/issues/7),
  tracked on [workspace#59](https://github.com/wazootech/workspace/issues/59)):
  FTS5 keyword search plus optional `sqlite-vec` hybrid search (RRF `k=60`),
  graceful keyword-only degradation when the extension is unavailable, and a
  `createSqliteWorldsSdk` factory mirroring `createLibsqlSdk`.

The `SqliteStore` quad primitive moved here from
[`@wazoo/sparql-engine`](https://jsr.io/@wazoo/sparql-engine) (the `./sqlite`
subpath it shipped in v0.3.x, graduated via
[sparql-engine#56](https://github.com/wazootech/sparql-engine/issues/56)). It
satisfies the engine's `createTransaction` hook with no cross-package import;
the worlds search layer composes on top (Layer 2).

## Install

### Package managers

```sh
# Deno (first-class JSR support)
deno add jsr:@worlds/sqlite

# Bun / npm / pnpm / Yarn (via JSR npm compatibility layer)
npx jsr add @worlds/sqlite
```

### CDN (browser / no build step)

[esm.sh](https://esm.sh) serves JSR packages as ES modules — no install, no
bundler needed.

```js
import { SqliteStore } from "https://esm.sh/jsr/@worlds/sqlite@0.4.0";
```

With an import map:

```html
<script type="importmap">
{
  "imports": {
    "@worlds/sqlite": "https://esm.sh/jsr/@worlds/sqlite@0.4.0"
  }
}
</script>
<script type="module">
import { SqliteStore } from "@worlds/sqlite";
</script>
```

Pin to an exact build for deterministic caching:

```js
import { SqliteStore } from "https://esm.sh/jsr/@worlds/sqlite@0.4.0?pin=v1724100000";
```

## Surface

- **Landed (Layer 1):** `SqliteStore` (durable `rdfjs.Store` over a synchronous
  SQLite handle — `node:sqlite` DatabaseSync by default, `bun:sqlite` Database
  via `db`/`createHandle`; STRICT table, WAL + busy_timeout, term-keyed rows,
  lossless RDF-star payloads, `createTransaction()`), `MemoryStream`, term
  identity (`termKey`/`sameRdfTerm`), crash-recovery + term-key-parity suites.
- **Landed (Layer 2):** `createSqliteWorldsSdk` (root export) plus
  `./quad-store`, `./search-index`, and `./schema` subpaths — `SqliteQuadStore`,
  `SqliteSearchIndex` / `SqliteSearchIndexProjector` /
  `SqliteSearchQueryBuilder` (FTS5 + optional sqlite-vec hybrid with JS-side RRF
  `1/(60+rank)`), `SqliteSchemaBuilder`, and `commitPatchToSqlite`
  (content-addressed dedup, replace-mode wipe, chunked batches). Keyword-only
  FTS5 is fully functional without the `sqlite-vec` extension.
- **Landed (`./sql-core`):** the driver-free SQL plan layer shared across the
  SQLite-family backends — `sanitizeFtsQuery`/stopwords, `buildChunkFtsValue`,
  `buildSearchResultId`, the `chunks`/`chunks_fts` DDL emitters, keyword FTS5
  branch plans, filter-clause helpers, and the `SqlStatement` plan type. See
  below.

## Runtime support

The sqlite layer is typed against a minimal structural handle seam
(`AnySyncSqliteHandle`: `exec` / `prepare` / `close`, plus optional
`loadExtension`) satisfied by both `node:sqlite`'s `DatabaseSync` and
`bun:sqlite`'s `Database`. `createSqliteWorldsSdk({ db })` and
`SqliteStore({ db })` accept either; `createHandle` injects the default
construction for path-only usage (node:sqlite remains the default).
`node:sqlite` is resolved lazily (never at module load), so Bun consumers
passing a `bun:sqlite` handle never load it — useful for Bun-only deployments
where `node:sqlite` is unavailable (e.g. Bun 1.3.x).

The claim is enforced, not asserted: the shared runtime-portability suite
(`src/sqlite/runtime-portability/`) runs the core `SqliteStore` +
`SqliteConnectionDriver` surface over both builtins — the `node:sqlite` leg in
the Deno CI job, the `bun:sqlite` leg in a pinned Bun CI job (see
`.github/workflows/ci.yml`). Any new runtime that provides an
`AnySyncSqliteHandle` can reuse the same suite via its own wrapper.

This repo is the **source of truth for SQLite-family SQL logic**: it is the
easiest backend to test locally (synchronous `node:sqlite`), so the shared
query/table logic lives here and downstream SQLite-family backends
(`@worlds/libsql` today; D1 later) consume it via the `./sql-core` subpath. The
quad storage layout (term-key hexastore here vs column-per-position rows in
libsql) and each vector-search dialect (vec0 vs native libsql vectors)
intentionally stay backend-local.

## SQL core

`@worlds/sqlite/sql-core` exports pure, driver-free building blocks: every
symbol emits inert `{sql, args}` plans or plain strings — no database handle, no
I/O. Backends execute the plans through their own connection drivers, which is
why synchronous `node:sqlite` and asynchronous LibSQL can share the same
emitters. The guardrail is enforced in CI by `deno task sql-core:purity`
(allowlist-based import check); keep new sql-core modules on that allowlist
(`@worlds/sdk`, `@wazoo/sparql-engine`, `@rdfjs/types`, intra-package imports,
and `@std/assert` in tests only).

## Setup

```sh
npx jsr add @worlds/sqlite
```

## License

TBD — match sibling Worlds packages.
