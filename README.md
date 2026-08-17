# @worlds/sqlite

Local `node:sqlite` durable backend for the Worlds client ([`@worlds/client`](https://github.com/wazootech/worlds-client-ts)) — single-process, local-file storage with optional `sqlite-vec` extension for vector search.

Part of the Worlds durable-backend family per the provider-seam design ([worlds-sdk-ts#164](https://github.com/wazootech/worlds-sdk-ts/issues/164)), alongside `@worlds/libsql` (Turso), `@worlds/postgres`, and `@worlds/cloudflare`.

## Status

Scaffold. Repo created 2026-08-17; **beta scope is an open decision** — see open question 2 in [worlds-sdk-ts#164](https://github.com/wazootech/worlds-sdk-ts/issues/164) (in-scope for the private beta, or post-beta?). Do not start implementation until that's resolved.

The `SqliteStore` quad primitive already exists in [`@wazoo/sparql-engine`](https://jsr.io/@wazoo/sparql-engine) behind the `./sqlite` subpath (v0.3.0+, graduated via [sparql-engine#56](https://github.com/wazootech/sparql-engine/issues/56)) — this backend consumes it and composes the search layer on top.

## Planned surface

- `createSqliteClient` — wires `SqliteQuadStore` + `SqliteSearchIndex` (keyword + optional `sqlite-vec`) into a `@worlds/client` `Client` (mirrors `createLibsqlClient` from `@worlds/libsql`).

## Setup

```sh
npx jsr add @worlds/sqlite
```

## License

TBD — match sibling Worlds packages.
