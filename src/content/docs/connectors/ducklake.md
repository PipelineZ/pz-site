---
title: "DuckLake"
description: "Reference for the ducklake connector: the five catalog backends and their keys, optional object-store credentials, time-travel reads, and declared capabilities."
sidebar:
  order: 8
---

The `ducklake` connector reads and writes a DuckLake lakehouse through DuckDB's own `ducklake`
extension. A lake is a metadata catalog plus a data path where DuckLake writes Parquet files. The
engine's session attaches the lake once per connection, and every read and write is a plain SQL
statement against that attach. The connector runs on the native tier only.

## Connection

Every connection names a `catalog` and, for every catalog except a local `duckdb` file, a
`data_path`. Each catalog has its own required keys, and a key that belongs to a different catalog
is refused with an error naming the catalog it belongs to.

| `catalog` | Required keys | Optional keys | Where the metadata lives |
|---|---|---|---|
| `duckdb` (default) | `path` | `data_path` | A DuckDB file. |
| `sqlite` | `path`, `data_path` | – | A SQLite file. |
| `postgres` | `host`, `database`, `data_path` | `port` (5432), `user`, `password` | A Postgres database. |
| `quack` | `uri`, `token`, `data_path` | – | A DuckDB server reached over the Quack protocol. |
| `motherduck` | `database`, `token`, `data_path` | – | A MotherDuck-hosted database. |

```yaml title="connections.yml"
lake:
  connector: ducklake
  path: data/lake.ducklake
  data_path: data/lake/
```

```yaml title="connections.yml"
lake:
  connector: ducklake
  catalog: postgres
  host: pg.internal
  database: lake_catalog
  user: pz
  password: ${LAKE_PG_PASSWORD}
  data_path: s3://my-bucket/lake/
```

```yaml title="connections.yml"
lake:
  connector: ducklake
  catalog: motherduck
  database: my_db
  token: ${MOTHERDUCK_TOKEN}
  data_path: s3://my-bucket/lake/
```

The `quack` catalog accepts `quack:host`, `quack:host:port`, or `quack://host[:port]` as its `uri`,
and normalizes all three to `quack:host:port` with a default port of 9494.

Relative `path` and `data_path` values resolve against the project directory. There is no
`base_dir` option. Neither may resolve inside the project's `.pz/` directory. An object-store
`data_path` is any value containing `://`.

:::tip
When the catalog is shared (`postgres`, `quack`, or `motherduck`), make `data_path` an object
store too. DuckLake's data files are read and written by each client, so two machines with a
project-relative `data_path` would land the same lake's files in two different places.
:::

### Object-store credentials

When `data_path` is an object-store URL, the connection may carry S3-compatible credentials. They
build a DuckDB secret scoped to that exact `data_path` and nothing else.

| Key | Required | Default | Meaning |
|---|---|---|---|
| `storage_key_id` | With `storage_secret_key` | – | Access key id. |
| `storage_secret_key` | With `storage_key_id` | – | Secret key. |
| `storage_region` | No | `us-east-1` | Region. |
| `storage_endpoint` | No | – | `host:port` of an S3-compatible endpoint. |
| `storage_url_style` | No | `vhost` | `vhost` or `path`. |
| `storage_use_ssl` | No | `true` | Whether to use TLS. |

The two credential keys are declared together or not at all, and any `storage_*` key requires
both. Declaring them against a local `data_path` is refused.

An entity is `table` (in the lake's `main` schema) or `schema.table`. The connector does not create
schemas.

## Read options

| Key | Required | Default | Meaning |
|---|---|---|---|
| `columns` | No | – | Column name to type map. When declared, the read projects only these columns. |
| `version` | No | – | Snapshot id to read, for time travel. |
| `timestamp` | No | – | Read the latest snapshot at or before this instant. Never together with `version`. |

```yaml title="connections.yml"
lake:
  connector: ducklake
  path: data/lake.ducklake
  entities:
    events:
      read:
        columns: { id: bigint, updated_at: timestamp, amount: double }
        sync: { mode: incremental, cursor: updated_at }
    events_as_of:
      read:
        version: 42
```

A read compiles to a `select` over the attached table, time-travelled when asked, with the
incremental watermark and any bounded window pushed into the query.

`sync` and `retry` under `read:` are the shared keys documented in the
[connections.yml reference](/reference/connections-yml/).

## Write options

`ducklake` takes no connector-specific write options. It supports every strategy:

| Strategy | What runs |
|---|---|
| `append` | `create table if not exists` from the staged rows' shape, then `insert`. |
| `replace` | One `create or replace table … as select`. |
| `merge` | `create table if not exists`, then DuckDB's own `merge into`, matched on `keys:`. |

Each generated statement commits as one DuckLake snapshot. There is no transaction spanning
several writes.

`strategy`, `keys`, `schema_policy`, and `retry` under `write:` are the shared keys documented in
the [connections.yml reference](/reference/connections-yml/).

## Capabilities

| Flag | Meaning |
|---|---|
| `NativeScan` | Reads compile to a `select` over the attached lake. |
| `NativeCopy` | Writes compile to native insert, create-or-replace, or merge statements. |
| `ReplaceWrites` | Supports `strategy: replace`. |
| `Merge` | Supports `strategy: merge` through DuckDB's `merge into`. |
| `Transactional` | Each generated statement commits as one snapshot. |
| `BoundedWindow` | Pushes a watermark upper bound into the generated query. |
| `InclusiveWatermarkBound` | Accepts an inclusive lower watermark bound (`cursor >= value`). |

## Notes

- `ducklake` is native-only. Declaring `engine.force_universal` on a `ducklake` entity fails at
  plan time; remove that setting instead.
- **Credentials never appear in an attach string or an error.** Postgres credentials, the quack
  token, the MotherDuck token, and storage credentials each ride a DuckDB secret or session
  setting. A failed attach names only a path, a URI, or a database.
- **A read of a missing catalog file is refused at plan time** for the `duckdb` and `sqlite`
  catalogs, for the same reason as the [duckdb](/connectors/duckdb/) connector. A server catalog
  has no local file to check.
- **Use one connection per catalog file.** Two connections naming the same `duckdb` or `sqlite`
  catalog file cannot both attach it in one session.
- **Merge does not collapse duplicate keys within a batch.** Deduplicate in the pipeline SQL that
  feeds a merge write.
- **One MotherDuck token per run.** A `motherduck` catalog shares the rule described on the
  [MotherDuck connector](/connectors/motherduck/) page.

`pz validate --connect` is shallow, because the connector has no driver of its own:

| Catalog | Check |
|---|---|
| `duckdb`, `sqlite` | An existing `path` must carry the right file header. A missing file is reported as will-be-created; a missing parent directory fails. |
| `postgres`, `quack` | TCP reachability of the host and port, with a five-second timeout. Credentials are verified by the first run. |
| `motherduck` | Not checked. The first run authenticates. |

| Code | When |
|---|---|
| [`PZ0209`](/reference/error-codes/) | A `strategy: merge` write declares no `keys:`. |
| [`PZ0311`](/reference/error-codes/) | A setup statement failed at run time: a secret, a session setting, or the attach. |
| [`PZ0312`](/reference/error-codes/) | `engine.force_universal` is set on a `ducklake` entity. |
| [`PZ0353`](/reference/error-codes/) | A read names a catalog file that does not exist yet, or declares both `version` and `timestamp`. |
| [`PZ0606`](/reference/error-codes/) | Under `pz mcp`, `path` or a local `data_path` resolves outside the project directory. |

## Related

- [DuckDB](/connectors/duckdb/) is the single-file variant with the same SQL surface.
- [MotherDuck](/connectors/motherduck/) and [Quack](/connectors/quack/) describe the two remote catalogs' own connection rules.
- [Incremental loads](/concepts/incremental-loads/) explains watermarks and bounded windows.
- [Secure connection config](/how-to/secure-connection-config/) covers keeping catalog and storage credentials out of the repository.
- [Connectors](/connectors/) compares every builtin connector's capabilities at a glance.
