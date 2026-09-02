---
title: "MySQL"
description: "Reference for the mysql connector, which reads and writes MySQL tables entirely through DuckDB's native mysql extension."
sidebar:
  order: 5
---

The `mysql` connector reads and writes MySQL tables entirely through DuckDB's own `mysql`
extension: reads are `mysql_query('alias', '…')` native scans, and writes are native
insert/replace copies. The connector ships no .NET MySQL driver, so it runs on the native tier
only, in both directions.

## Connection

```yaml title="connections.yml"
warehouse:
  connector: mysql
  host: ${MYSQL_HOST}
  database: ${MYSQL_DB}
  user: ${MYSQL_USER}
  password: ${MYSQL_PASSWORD}
```

| Key | Required | Default | Meaning |
|---|---|---|---|
| `host` | Yes | – | Server hostname. |
| `database` | Yes | – | Database name. |
| `port` | No | `3306` | Server port. |
| `user` | No | – | Login user. |
| `password` | No | – | Login password. Always an `${ENV_VAR}` reference, never a literal. |
| `ssl_mode` | No | – | SSL mode passed to the `mysql_query` setup. |

## Read options

| Key | Required | Default | Meaning |
|---|---|---|---|
| `query` | No | – | Replaces the table as the MySQL-side `SELECT`. |
| `columns` | No | – | When declared, becomes the projection and the entity's schema. |

```yaml title="connections.yml"
entities:
  active_orders:
    read:
      query: select id, customer_id, amount from orders where status = 'active'
```

`sync` and `retry` under `read:` are the shared keys documented in the
[connections.yml reference](/reference/connections-yml/); `rate_limit` belongs on the connection.

## Write options

`mysql` takes no connector-specific write options. It supports `strategy: append` (a
create-if-not-exists plus insert batch) and `strategy: replace` (a single
`CREATE OR REPLACE TABLE … AS`). There is no `strategy: merge`: the DuckDB `mysql` catalog has no
upsert, and the connector declares no `Merge` capability.

`strategy`, `schema_policy`, and `retry` under `write:` are the shared keys documented in the
[connections.yml reference](/reference/connections-yml/).

## Capabilities

| Flag | Meaning |
|---|---|
| `NativeScan` | Reads compile to a `mysql_query('alias', '…')` fragment. |
| `NativeCopy` | Writes compile to a native insert or create-or-replace copy. |
| `ReplaceWrites` | Supports `strategy: replace`. |
| `BoundedWindow` | Pushes a watermark upper bound into the generated query. |
| `InclusiveWatermarkBound` | Accepts an inclusive lower watermark bound (`cursor >= value`). |

## Notes

- `mysql` is native-only. Declaring `engine.force_universal` on a `mysql` entity fails at plan
  time with [`PZ0312`](/reference/error-codes/); remove that setting instead.
- The MySQL-side `strategy: replace` swap is not atomic: the extension's `OR REPLACE` is a drop and
  create, and MySQL DDL commits implicitly. `mysql` does not declare `Transactional`.
- `pz validate --connect` checks reachability and server version over a raw TCP probe, not
  credentials. A bad password surfaces only at run time.

## Related

- [connections.yml reference](/reference/connections-yml/) documents the shared read and write keys.
- [Incremental loads](/concepts/incremental-loads/) explains watermarks and bounded windows.
- [Error codes](/reference/error-codes/) looks up `PZ0312` and every other code by number.
- [Connectors](/connectors/) compares every builtin connector's capabilities at a glance.
