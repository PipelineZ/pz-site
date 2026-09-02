---
title: "PostgreSQL"
description: "Reference for the postgres connector, which reads and writes PostgreSQL tables with keyed merge and change-capture support."
sidebar:
  order: 3
---

The `postgres` connector reads and writes PostgreSQL tables over Npgsql. It runs on the universal
Arrow tier only: there is no native `postgres_scanner` scan wired up yet. Every read and write
streams through pz's own batch path rather than a DuckDB `COPY`.

## Connection

```yaml title="connections.yml"
warehouse:
  connector: postgres
  host: ${WAREHOUSE_HOST}
  database: ${WAREHOUSE_DB}
  user: ${WAREHOUSE_USER}
  password: ${WAREHOUSE_PASSWORD}
  entities:
    public.orders:
      read: {}
```

| Key | Required | Default | Meaning |
|---|---|---|---|
| `host` | Yes | – | Server hostname. |
| `database` | Yes | – | Database name. |
| `port` | No | `5432` | Server port. |
| `user` | No | – | Login role. |
| `password` | No | – | Login password. Always an `${ENV_VAR}` reference, never a literal. |
| `ssl_mode` | No | – | Npgsql SSL mode string. |

## Read options

| Key | Required | Default | Meaning |
|---|---|---|---|
| `query` | No | – | Replaces the generated `SELECT` entirely. Forbidden on a `sync: {mode: cdc}` entity. |
| `partition_column` | No | – | A numeric or date column to range-partition the read across. |
| `partitions` | No | `1` | Partition count, `1`-`16`. Only takes effect with `partition_column`. |
| `publication` | No | `pz_{connection}` | The logical-replication publication name for `sync: {mode: cdc}` reads. |
| `poll_idle_timeout` | No | `5s` | How long a CDC read waits for new changes before yielding, once caught up. |

`columns`, `sync`, and `retry` under `read:` are the shared keys documented in the
[connections.yml reference](/reference/connections-yml/); `rate_limit` belongs on the connection.
A CDC read looks like this instead of a plain table read:

```yaml title="connections.yml"
entities:
  public.orders:
    read:
      sync:
        mode: cdc
      publication: pz_orders_feed
```

See [Capture changes with CDC](/how-to/capture-changes-with-cdc/) for the publication and
replication-slot setup this requires on the server.

## Write options

`postgres` takes no connector-specific write options. The target schema and table come from the
entity name: `public.orders` writes `orders` in schema `public`, and an unqualified name defaults
to schema `public`. It supports all three write strategies:

- `strategy: append` inserts.
- `strategy: replace` swaps the table atomically.
- `strategy: merge` upserts on `ON CONFLICT`, keyed by `keys:`, and can apply CDC deletes through
  `on_delete: delete` or `on_delete: soft`.

`strategy`, `keys`, `on_delete`, `schema_policy`, and `retry` under `write:` are the shared keys;
see the [connections.yml reference](/reference/connections-yml/).

## Capabilities

| Flag | Meaning |
|---|---|
| `ColumnPruning` | Reads project only the columns pz asks for. |
| `PredicatePushdown` | Reads push the compiled `WHERE` clause into the query. |
| `PartitionedRead` | Reads can split into multiple range partitions. |
| `Merge` | Writes support keyed upsert. |
| `Transactional` | A write commits atomically. |
| `ReplaceWrites` | Supports `strategy: replace`. |
| `BoundedWindow` | Pushes a watermark upper bound into the query. |
| `InclusiveWatermarkBound` | Accepts an inclusive lower watermark bound (`cursor >= value`). |
| `ApplyDeletes` | A merge write can apply CDC delete-key batches in the same transaction. |
| `ChangeCapture` | Supports `sync: {mode: cdc}` reads. |

## Notes

- `query:` and `sync: {mode: cdc}` are mutually exclusive on the same entity.
- The session is pinned to UTC so watermark and window comparisons against a `timestamptz` cursor
  stay exact; this is internal and needs no configuration.

## Related

- [Capture changes with CDC](/how-to/capture-changes-with-cdc/) sets up the publication a CDC read needs.
- [Incremental loads](/concepts/incremental-loads/) explains watermarks, sync modes, and merge together.
- [connections.yml reference](/reference/connections-yml/) documents the shared read and write keys.
- [Connectors](/connectors/) compares every builtin connector's capabilities at a glance.
