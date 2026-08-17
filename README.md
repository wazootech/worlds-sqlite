# @worlds/sqlite

Local `node:sqlite` durable backend for the Worlds client ([`@worlds/client`](https://github.com/wazootech/worlds-client-ts)) — single-process, local-file storage with optional `sqlite-vec` extension for vector search.

Part of the Worlds durable-backend family per the provider-seam design ([worlds-sdk-ts#164](https://github.com/wazootech/worlds-sdk-ts/issues/164)), alongside `@worlds/libsql` (Turso), `@worlds/postgres`, and `@worlds/cloudflare`.

## Status

Scaffold only — **parked (post-beta / backlog)** as of 2026-08-17 per the provider-seam decision ([worlds-sdk-ts#164](https://github.com/wazootech/worlds-sdk-ts/issues/164)): the beta runs single-backend on Turso (`@worlds/libsql`), and alternative durable backends are deferred. Do not start implementation until the beta ships.

The `SqliteStore` quad primitive already exists in [`@wazoo/sparql-engine`](https://jsr.io/@wazoo/sparql-engine) behind the `./sqlite` subpath (v0.3.0+, graduated via [sparql-engine#56](https://github.com/wazootech/sparql-engine/issues/56)) — this backend consumes it and composes the search layer on top.

## Planned surface

- `createSqliteClient` — wires `SqliteQuadStore` + `SqliteSearchIndex` (keyword + optional `sqlite-vec`) into a `@worlds/client` `Client` (mirrors `createLibsqlClient` from `@worlds/libsql`).

## Setup

```sh
npx jsr add @worlds/sqlite
```

## License

TBD — match sibling Worlds packages.
