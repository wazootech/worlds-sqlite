# @worlds/sqlite

Local `node:sqlite` durable backend for the Worlds client
([`@worlds/client`](https://github.com/wazootech/worlds-client-ts)) —
single-process, local-file storage with optional `sqlite-vec` extension for
vector search.

Part of the Worlds durable-backend family per the provider-seam design
([worlds-sdk-ts#164](https://github.com/wazootech/worlds-sdk-ts/issues/164)),
alongside `@worlds/libsql` (Turso), `@worlds/postgres`, and
`@worlds/cloudflare`.

## Status

Two layers, two statuses (plan:
[worlds-sqlite#1](https://github.com/wazootech/worlds-sqlite/issues/1)):

- **Layer 1 — RDF/JS quad primitive (`SqliteStore`): landed.** The store moved
  here from `@wazoo/sparql-engine/sqlite` (packaged with the worlds impl per the
  ecosystem pattern — `LibsqlRdfjsStore` lives in `@worlds/libsql`,
  `PostgresRdfjsStore` in `@worlds/postgres`), re-based on `n3`'s DataFactory
  (the `@worlds/sdk` choice) with term identity parity-tested against the
  engine. Published as `@worlds/sqlite` (root + `./rdfjs-store` subpath).
- **Layer 2 — Worlds impl (search + `createSqliteClient`): parked (post-beta).**
  Per the provider-seam decision
  ([worlds-sdk-ts#164](https://github.com/wazootech/worlds-sdk-ts/issues/164))
  the beta runs single-backend on Turso (`@worlds/libsql`); the search layer
  here is spec'd in #1, implemented when unparked.

The `SqliteStore` quad primitive moved here from
[`@wazoo/sparql-engine`](https://jsr.io/@wazoo/sparql-engine) (the `./sqlite`
subpath it shipped in v0.3.x, graduated via
[sparql-engine#56](https://github.com/wazootech/sparql-engine/issues/56)). It
satisfies the engine's `createTransaction` hook with no cross-package import;
the worlds search layer composes on top (Layer 2).

## Surface

- **Landed (Layer 1):** `SqliteStore` (durable `rdfjs.Store` over `node:sqlite`,
  STRICT table, WAL + busy_timeout, term-keyed rows, lossless RDF-star payloads,
  `createTransaction()`), `MemoryStream`, term identity
  (`termKey`/`sameRdfTerm`), crash-recovery + term-key-parity suites.
- **Planned (Layer 2, parked):** `createSqliteClient` — wires
  `SqliteQuadStoreBackend` + `SqliteSearchQueryBuilder` (keyword + optional
  `sqlite-vec`, JS-side RRF) into a `@worlds/sdk` `Client` (mirrors
  `createLibsqlClient` from `@worlds/libsql`).

## Setup

```sh
npx jsr add @worlds/sqlite
```

## License

TBD — match sibling Worlds packages.
