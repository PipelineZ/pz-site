---
title: "DuckDB"
description: "Reference for the duckdb connector, which reads and writes a DuckDB database file through the engine's own DuckDB session on the native tier only."
sidebar:
  order: 7
---

The `duckdb` connector reads and writes a DuckDB database file. The engine's own DuckDB session
attaches the file once per connection, and every read and write is a plain SQL statement against
that attach. There is no server, no driver, and no credential: the connection is a file path, and
the connector runs on the native tier only.

## Connection

```yaml title="connections.yml"
warehouse:
  connector: duckdb
  path: data/warehouse.duckdb
```

| Key | Required | Default | Meaning |
|---|---|---|---|
| `path` | Yes | – | Path to the DuckDB database file. Relative paths resolve against the project directory. A missing file is created by the first write. |

`path` is the only connection key. There is no `base_dir` option: relative-path resolution against
the project directory happens internally. A `path` inside the project's `.pz/` directory is
refused, since that is the run's own staging and state area.

An entity is `table` or `schema.table`, named the way DuckDB names it. There are no separate
`schema:` or `table:` options. The connector does not create schemas: a `schema.table` entity's
schema must already exist in the file.

## Read options

| Key | Required | Default | Meaning |
|---|---|---|---|
| `columns` | No | – | Column name to type map. When declared, the read projects only these columns. |

A read compiles to a `select` over the attached table. An incremental watermark and a bounded
window are pushed into that query, so DuckDB reads only the rows the run needs.

`sync` and `retry` under `read:` are the shared keys documented in the
[connections.yml reference](/reference/connections-yml/).

## Write options

`duckdb` takes no connector-specific write options. It supports every strategy:

| Strategy | What runs |
|---|---|
| `append` | `create table if not exists` from the staged rows' shape, then `insert`. |
| `replace` | One `create or replace table … as select`. |
| `merge` | `create table if not exists`, then DuckDB's own `merge into`, matched on `keys:`. Matched rows update, unmatched rows insert. |

```yaml title="connections.yml"
warehouse:
  connector: duckdb
  path: data/warehouse.duckdb
  entities:
    orders_current:
      write:
        strategy: merge
        keys: [order_id]
```

`strategy`, `keys`, `schema_policy`, and `retry` under `write:` are the shared keys documented in
the [connections.yml reference](/reference/connections-yml/).

## Capabilities

| Flag | Meaning |
|---|---|
| `NativeScan` | Reads compile to a `select` over the attached file. |
| `NativeCopy` | Writes compile to native insert, create-or-replace, or merge statements. |
| `ReplaceWrites` | Supports `strategy: replace`. |
| `Merge` | Supports `strategy: merge` through DuckDB's `merge into`. |
| `Transactional` | Each generated statement commits atomically inside the file. |
| `BoundedWindow` | Pushes a watermark upper bound into the generated query. |
| `InclusiveWatermarkBound` | Accepts an inclusive lower watermark bound (`cursor >= value`). |

## Notes

- `duckdb` is native-only. Declaring `engine.force_universal` on a `duckdb` entity fails at plan
  time; remove that setting instead.
- **One writer per file.** A run holds the file attached read-write for its whole duration. Another
  process holding the same file open when the run starts makes the attach fail. Close it first, or
  point the run at a copy.
- **A read of a missing file is refused at plan time.** Attaching a path that does not exist would
  create an empty database and read zero rows, which is indistinguishable from a typo in `path`.
  Run a write against that `path` first, or fix the connection.
- **Use one connection per file.** Two connections that name the same file each try their own
  attach, and DuckDB refuses to attach one file twice in a session. Put the file's reads and writes
  on the same connection.
- **Merge does not collapse duplicate keys within a batch.** Every staged row is matched against the
  target on its own, so two staged rows with the same key both land. Deduplicate in the pipeline
  SQL that feeds a merge write.
- `pz validate --connect` checks an existing file for the DuckDB header, reports a missing file as
  will-be-created, and fails on a missing parent directory.

| Code | When |
|---|---|
| [`PZ0209`](/reference/error-codes/) | A `strategy: merge` write declares no `keys:`. |
| [`PZ0311`](/reference/error-codes/) | The attach failed at run time, for example because another process holds the file. |
| [`PZ0312`](/reference/error-codes/) | `engine.force_universal` is set on a `duckdb` entity. |
| [`PZ0353`](/reference/error-codes/) | A read names a file that does not exist yet. |
| [`PZ0606`](/reference/error-codes/) | Under `pz mcp`, `path` resolves outside the project directory. |

## Related

- [connections.yml reference](/reference/connections-yml/) documents the shared read and write keys.
- [Delivery guarantees](/concepts/delivery-guarantees/) explains what `merge` and `replace` promise on retry.
- [DuckLake](/connectors/ducklake/) is the lakehouse variant: the same SQL surface over a catalog plus Parquet files.
- [Connectors](/connectors/) compares every builtin connector's capabilities at a glance.
