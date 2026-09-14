---
title: "A tour of pz connectors"
description: "Fifteen builtin connectors, a tier of first-party ones outside the binary, and the native-versus-universal split that decides how fast a read or write actually runs."
date: 2026-09-13
heroImage:
  dark: ./hero-dark.svg
  light: ./hero-light.svg
  alt: "The words Every connector, next to a glowing yellow pipeline network diagram."
---

A pipeline author never opens a driver or writes a client library call. `source()` and `sink()`
name a connection and an entity, and whatever connector sits behind that connection handles
authentication, pagination, and turning rows into the staging database's tables or back out
again. Here's what's actually available, and how pz decides which path a given read or write
takes.

## Fifteen connectors, no extra setup

`localfiles`, `postgres`, `s3`, `sqlserver`, `azureblob`, `gcs`, `http`, `mysql`, `sqlite`,
`duckdb`, `ducklake`, `motherduck`, `quack`, `iceberg`, and `sftp` all ship inside the `pz`
binary. Naming one as `connector:` in `connections.yml` is the entire setup:

```yaml title="connections.yml"
mart:
  connector: postgres
  host: ${MART_PG_HOST}
  database: mart
  user: ${MART_PG_USER}
  password: ${MART_PG_PASSWORD}
  entities:
    public.orders_current:
      write:
        strategy: merge
        keys: [order_id]
```

Nothing here says which tier the write uses or what `merge` requires. `postgres` declares the
`Merge` capability, so the planner resolves the rest on its own. A slice of the range, spanning a
file connector, two databases, an object store, and an API:

| Connector | Read | Write | Native tier | Incremental | CDC | Merge |
|---|---|---|---|---|---|---|
| `localfiles` | ✓ | ✓ | ✓ | ✓ | – | – |
| `postgres` | ✓ | ✓ | – | ✓ | ✓ | ✓ |
| `duckdb` | ✓ | ✓ | ✓ | ✓ | – | ✓ |
| `s3` | ✓ | ✓ | ✓ | ✓ | – | – |
| `http` | ✓ | ✓ | – | ✓ | – | ✓ |

The full [connector matrix](/connectors/) lists all fifteen builtin connectors this way, plus
which file formats the file-shaped ones read.

## Native versus universal

For every read or write, the planner picks between two tiers. The **native** tier hands DuckDB a
scan or copy statement directly, so DuckDB moves the bytes with no detour through pz. The
**universal** tier streams Arrow record batches that pz relays into or out of the staging
database instead, and it's what backs anything a native scan or copy can't express, like an
HTTP API's paginated response.

Native is faster and is what most connectors prefer. Two connectors, `mysql` and `sqlite`, only
implement the native tier, and refuse a universal-only entity outright rather than pretending to
support it. On the other end, anything that resumes from a sync token, a feed-shaped read or
`mode: cdc`, always takes the universal tier no matter what the connector offers, because a
native scan never drains a partition in the way that capture needs.

## Beyond the binary: external and third-party

Anything not in the builtin fifteen is a NuGet package, declared once in `project.yml`:

```yaml title="project.yml"
connectors:
  - package: Some.Connector.Package
    version: 1.0.0
```

`pz restore` resolves it, downloads it under `.pz/packages`, and writes `pz.lock.json` so every
machine restores the exact same version. Commit the lock file, never `.pz/` itself.

These packaged connectors split into two tiers, the same shape DuckDB gives its own extensions.
**External** connectors are first-party: written and tested by the PipelineZ org, held to the
same bar as a builtin, just versioned on their own cadence because their dependencies (a Rust
runtime, a proprietary driver) don't belong in the main binary. BigQuery, Databricks, Snowflake,
MongoDB, and Kafka are on that list today; see [External connectors](/connectors/external/) for
the full set and what each one's own test suite has actually verified. **Third-party**
connectors are anything anyone else publishes against the same protocol, pz runs them
identically, but PipelineZ doesn't test or support them.

Either way, a restored connector runs as its own process, not inside `pz` itself, talking to it
over a local socket with an empty environment repopulated from a small allowlist. Connection
config and secrets never leak into the child process's environment; they cross the socket as an
explicit request instead. That isolation is what lets a packaged connector crash or hold a
dependency version pz doesn't ship, without any of it touching the host process.

## Try it

[Connectors: the plugin architecture](/concepts/connectors/) covers capabilities, isolation, and
both data-movement tiers in full. [Author a connector](/how-to/author-a-connector/) is where to
start if the connector you need isn't on either list yet.
