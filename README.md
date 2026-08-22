# @worlds/sqlite

Local `node:sqlite` durable backend for the Worlds client
([`@worlds/sdk`](https://jsr.io/@worlds/sdk)) — single-process, local-file
storage with optional `sqlite-vec` extension for vector search.

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

- **Landed (Layer 1):** `SqliteStore` (durable `rdfjs.Store` over `node:sqlite`,
  STRICT table, WAL + busy_timeout, term-keyed rows, lossless RDF-star payloads,
  `createTransaction()`), `MemoryStream`, term identity
  (`termKey`/`sameRdfTerm`), crash-recovery + term-key-parity suites.
- **Landed (Layer 2):** `createSqliteWorldsSdk` (root export) plus
  `./quad-store`, `./search-index`, and `./schema` subpaths — `SqliteQuadStore`,
  `SqliteSearchIndex` / `SqliteSearchIndexProjector` /
  `SqliteSearchQueryBuilder` (FTS5 + optional sqlite-vec hybrid with JS-side RRF
  `1/(60+rank)`), `SqliteSchemaBuilder`, and `commitPatchToSqlite`
  (content-addressed dedup, replace-mode wipe, chunked batches). Keyword-only
  FTS5 is fully functional without the `sqlite-vec` extension.

## Setup

```sh
npx jsr add @worlds/sqlite
```

## License

TBD — match sibling Worlds packages.
