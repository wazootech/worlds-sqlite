# @worlds/sqlite

Local `node:sqlite` durable backend for the Worlds client ([`@worlds/client`](https://github.com/wazootech/worlds-client-ts)) — single-process, local-file storage with optional `sqlite-vec` extension for vector search.

Part of the Worlds durable-backend family per the provider-seam design ([worlds-sdk-ts#164](https://github.com/wazootech/worlds-sdk-ts/issues/164)), alongside `@worlds/libsql` (Turso), `@worlds/postgres`, and `@worlds/cloudflare`.

## Status

Two layers, two statuses (plan: [worlds-sqlite#1](https://github.com/wazootech/worlds-sqlite/issues/1)):

- **Layer 1 — RDF/JS quad primitive (`SqliteStore`): active plan.** The store moves here from `@wazoo/sparql-engine/sqlite` (packaged with the worlds impl per the ecosystem pattern — `LibsqlRdfjsStore` lives in `@worlds/libsql`, `PostgresRdfjsStore` in `@worlds/postgres`), re-based on `@worlds/sdk`'s shared quad-store/term pieces.
- **Layer 2 — Worlds impl (search + `createSqliteClient`): parked (post-beta).** Per the provider-seam decision ([worlds-sdk-ts#164](https://github.com/wazootech/worlds-sdk-ts/issues/164)) the beta runs single-backend on Turso (`@worlds/libsql`); the search layer here is spec'd in #1, implemented when unparked.

The `SqliteStore` quad primitive already exists in [`@wazoo/sparql-engine`](https://jsr.io/@wazoo/sparql-engine) behind the `./sqlite` subpath (v0.3.0+, graduated via [sparql-engine#56](https://github.com/wazootech/sparql-engine/issues/56)) — this backend consumes it and composes the search layer on top.

## Planned surface

- `createSqliteClient` — wires `SqliteQuadStore` + `SqliteSearchIndex` (keyword + optional `sqlite-vec`) into a `@worlds/client` `Client` (mirrors `createLibsqlClient` from `@worlds/libsql`).

## Setup

```sh
npx jsr add @worlds/sqlite
```

## License

TBD — match sibling Worlds packages.
