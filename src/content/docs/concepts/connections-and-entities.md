---
title: "Connections and entities"
description: "How connections.yml declares connections and entities, the reserved connection keys, and the rule that an option lives in YAML or at the call site, never both."
sidebar:
  order: 3
---

This page explains the shape of `connections.yml`: what a connection is, what an entity is, and
the rule that governs where a read or write option gets declared. Read it before writing your
own `connections.yml`, or when a `PZ0341` or `PZ0345` error sends you here.

## What it is

A connection is a place with credentials: a folder of files, a Postgres database, an S3 bucket.
An entity is a named thing inside that place: one file pattern, one database table. Every
connection your project talks to is declared once, as a top-level key in `connections.yml`,
with its entities nested underneath.

## Why it matters

Keeping connection config and entity declarations in one file, in one shape, means a reader can
answer "where does this project get its data, and where does it send it" from a single file.
There is no separate `sources/` directory, no `outputs:` block, and no hidden default connection
to guess at.

## How it works

### One connection, one place

Each top-level key in `connections.yml` is a connection. It needs a `connector:` naming which
connector handles it, plus whatever config that connector requires: host, credentials, a root
path. Credentials are always `${VAR}` references, interpolated from the environment, never
literal secrets in the file.

```yaml title="connections.yml"
crm:
  connector: postgres
  host: ${CRM_PG_HOST}
  database: crm
  user: ${CRM_PG_USER}
  password: ${CRM_PG_PASSWORD}
```

An unset `${VAR}` fails fast at load time rather than connecting to something unintended.

### Six reserved keys

At the connection level, `pz` owns six keys. A connector cannot declare a config option with
one of these names, because it could never receive it:

| Key | Holds |
|---|---|
| `connector` | which connector handles this connection |
| `entities` | the entities declared at this connection |
| `max_concurrency` | how many concurrent operations this connection allows |
| `rate_limit` | request pacing for this connection |
| `retry` | retry policy for operations against this connection |
| `allow_unsigned_extensions` | lets DuckDB load an unsigned extension for this connection |

Everything else at connection level is passed straight through to the connector: it is flat
config, not nested under a `config:` key.

### Entities and their two directions

An entity is declared under `entities:`, keyed by its name spelled exactly the way its own
system names it: `dbo.orders`, `public.customers`, `curated`. Under that key, `read:` and
`write:` hold how to move data in each direction. An entity that is both read and written
appears once, with both blocks:

```yaml title="connections.yml"
raw:
  connector: localfiles
  entities:
    customers:
      read:
        path: data/customers.csv
        format: csv
        columns:
          id: bigint
          email: varchar
```

On a file-place connector (`localfiles` above, or `s3`/`gcs`/`azureblob`/`sftp`), `format` is one
of `csv`, `tsv`, `parquet`, `json`, `xlsx`, or `avro` (`avro` is read only; `xlsx` write is
localfiles-only — the other three read it fine but refuse to write it); `delimiter` (csv only),
`layout` (json only, `ndjson` or `array`), `sheet`, and `header` (both xlsx only) ride alongside
it as their own format-scoped options — see each connector's own page for the full table.

An entity that needs no options at all can be a bare key: `dbo.orders:` with nothing under it.
An entity doesn't have to appear in `connections.yml` at all. A `source()` or `sink()` call that
names an entity `connections.yml` never mentions is not an error: the call declares it.

### DuckDB extensions

`xlsx` (read and write) and `avro` (read only) run through DuckDB's `excel` and `avro`
extensions, which are not in DuckDB's base binary — DuckDB installs and loads one the first time
a pipeline touches its format. That first use, on a given machine and DuckDB version, needs
network access to download it into `~/.duckdb/extensions/<version>/<platform>/`; every run after
that is offline. An install attempted with no network available fails as `PZ0311`, naming the
extension it could not fetch.

### Two surfaces, one declaration

Every read or write option can be declared in `connections.yml`, under `read:` or `write:`, or
as a keyword argument on the `source()` or `sink()` call that uses it. Never both. The two
surfaces have exactly the same names at every nesting level, so moving an option between them is
cut-and-paste.

```sql
select id, email from {{ source('crm', 'customers', path: 'data/customers.csv', format: 'csv') }}
```

is equivalent to declaring the same options under `entities: customers: read:` in YAML. Declaring
an entity-side's options in both places is an error, not a precedence rule: `pz` never merges a
YAML default with a call-site override, so whichever file you open tells the whole story.

The `sample` template uses both spellings deliberately: `customers` and `orders` are declared in
`connections.yml` because more than one pipeline could want them on the same terms, while
`products` carries its options at its own `source()` call, because only one pipeline reads it.

### Secrets

Any connection value can reference an environment variable with `${VAR}`. `pz` interpolates it
at load time and fails the load if the variable is unset, rather than connecting with a blank
credential.

## Example

The `sample` template's `connections.yml` declares two connections: a read side with two
entities in YAML, and a write side with none, because its outputs are all bound at the `sink()`
call site instead.

```yaml title="connections.yml"
raw:
  connector: localfiles
  entities:
    customers:
      read:
        path: data/customers.csv
        format: csv
        columns:
          id: bigint
          email: varchar
    orders:
      read:
        path: data/orders.csv
        format: csv
        columns:
          id: bigint
          customer_id: bigint
          amount: double
          status: varchar

lake:
  connector: localfiles
  root: out
```

Every write in this project, including `orders_curated` and `order_totals`, carries its options
on the `sink()` call in the pipeline that writes it.

## Related

- [Key concepts](/concepts/key-concepts/): connection, entity, and connector defined.
- [Pipelines](/concepts/pipelines/): the `source()` and `sink()` calls that read the other surface.
- [Project layout](/concepts/project-layout/): where `connections.yml` sits in a project.
- [Connectors](/concepts/connectors/): the fifteen builtin connectors and their own config keys.
- [`connections.yml` reference](/reference/connections-yml/): every reserved key and option, in full.
