---
title: "SQL Server"
description: "Reference for the sqlserver connector, which reads and writes SQL Server tables, queries, and stored procedures with keyed merge and change-capture support."
sidebar:
  order: 4
---

The `sqlserver` connector reads and writes Microsoft SQL Server over `Microsoft.Data.SqlClient`.
It runs on the universal Arrow tier only, using a connector-owned typed reader on read and
`SqlBulkCopy` on write. `pz` itself can also use a `sqlserver` connection as a remote state
backend, so it is disposable across machines.

## Connection

```yaml title="connections.yml"
erp:
  connector: sqlserver
  host: ${ERP_DB_HOST}
  database: ${ERP_DB_NAME}
  user: ${ERP_DB_USER}
  password: ${ERP_DB_PASSWORD}
  trust_server_certificate: true
  entities:
    dbo.orders:
      read:
        columns:
          order_id: bigint
          updated_at: timestamp
```

| Key | Required | Default | Meaning |
|---|---|---|---|
| `host` | Yes | – | Server hostname. |
| `database` | Yes | – | Database name. |
| `port` | No | – | Server port. |
| `user` | No | – | Login name. |
| `password` | No | – | Login password. Always an `${ENV_VAR}` reference, never a literal. |
| `authentication` | No | – | Passed through to SqlClient, for example `Active Directory Default`. |
| `encrypt` | No | – | Boolean, forces or disables connection encryption. |
| `trust_server_certificate` | No | – | Boolean, skips certificate validation. |

## Read options

An entity reads one of three mutually exclusive shapes: a table (the default), a `query`, or a
`procedure`.

| Key | Required | Default | Meaning |
|---|---|---|---|
| `query` | No | – | Replaces the generated `SELECT` with this SQL. Exclusive with `procedure`. |
| `procedure` | No | – | Calls a stored procedure instead of selecting a table. Exclusive with `query`. |
| `parameters` | No | – | Map of procedure parameter name to value. `$watermark`/`$watermark_upper` sentinels bind the engine's watermark cursor. |
| `partition_column` | No | – | A numeric or date column to range-partition the read across, table mode only. |
| `partitions` | No | `1` | Partition count, `1`-`16`. |
| `capture_instance` | No | `{schema}_{table}` | The CDC capture instance name for `sync: {mode: cdc}` reads. |
| `columns` | No | – | Skips the `FMTONLY` schema probe when declared. |

A procedure read looks like this:

```yaml title="connections.yml"
entities:
  dbo.orders_delta:
    read:
      procedure: dbo.usp_orders_since
      parameters:
        since: "$watermark"
```

`sync` and `retry` under `read:` are the shared keys documented in the
[connections.yml reference](/reference/connections-yml/); `rate_limit` belongs on the connection.

## Write options

The target schema and table come from the entity name: `dbo.orders` writes `orders` in schema
`dbo`, and an unqualified name defaults to schema `dbo`.

| Key | Required | Default | Meaning |
|---|---|---|---|
| `tablock` | No | `true` | Takes a bulk-update table lock during the write. Always on for a session-private staging table regardless of this setting. |
| `columns` | No | derived from text-length stats | Per-column DDL override, for sizing text columns instead of defaulting to `nvarchar(4000)`. |

All three write strategies are supported:

- `strategy: append` bulk-inserts.
- `strategy: replace` swaps the table.
- `strategy: merge` upserts, keyed by `keys:`, and can apply CDC deletes through `on_delete`.

```yaml title="pipelines/orders_current.sql"
INSERT INTO {{ sink('mart', 'mart.orders_current', strategy: 'merge', keys: ['order_id']) }}
select order_id, customer_id, amount, status, updated_at
from {{ source('erp', 'dbo.orders') }}
where updated_at > {{ watermark('erp', 'dbo.orders') }}
```

## Capabilities

| Flag | Meaning |
|---|---|
| `ColumnPruning` | Reads project only the columns pz asks for. |
| `PredicatePushdown` | Reads push the compiled `WHERE` clause into the query. |
| `PartitionedRead` | Table-mode reads can split into multiple range partitions. |
| `Merge` | Writes support keyed upsert. |
| `Transactional` | A write commits atomically. |
| `ReplaceWrites` | Supports `strategy: replace`. |
| `BoundedWindow` | Pushes a watermark upper bound into the query. |
| `InclusiveWatermarkBound` | Accepts an inclusive lower watermark bound (`cursor >= value`). |
| `ApplyDeletes` | A merge write can apply CDC delete-key batches in the same transaction. |
| `ChangeCapture` | Supports `sync: {mode: cdc}` reads, backed by SQL Server change data capture. |
| `TextLengthStats` | The engine hands the sink per-column max text lengths to size DDL. |

## Notes

- `query`, `procedure`, and table mode are mutually exclusive on one entity.
- `$watermark` and `$watermark_upper` as literal parameter values, not expressions, bind the
  watermark cursor and its upper bound.
- CDC reads need SQL Server change data capture enabled on the source table; see
  [Capture changes with CDC](/how-to/capture-changes-with-cdc/).

## Related

- [Capture changes with CDC](/how-to/capture-changes-with-cdc/) covers enabling CDC on the server.
- [Remote state](/how-to/remote-state/) uses a sqlserver connection to hold watermarks and run results.
- [Incremental loads](/concepts/incremental-loads/) explains watermarks, sync modes, and merge together.
- [connections.yml reference](/reference/connections-yml/) documents the shared read and write keys.
