---
title: "MotherDuck"
description: "Reference for the motherduck connector, which reads and writes a MotherDuck-hosted database through DuckDB's motherduck extension on the native tier only."
sidebar:
  order: 9
---

The `motherduck` connector reads and writes a database hosted on MotherDuck through DuckDB's own
`motherduck` extension. The engine's session attaches the database once per connection, and every
read and write is a plain SQL statement that MotherDuck executes. The connector runs on the native
tier only.

## Connection

```yaml title="connections.yml"
cloud:
  connector: motherduck
  database: my_db
  token: ${MOTHERDUCK_TOKEN}
```

| Key | Required | Default | Meaning |
|---|---|---|---|
| `database` | Yes | – | The MotherDuck database to attach. It must already exist in the account. |
| `token` | Yes | – | A MotherDuck access token. Use an environment reference, never a literal. |

An entity is `table` or `schema.table`, named the way MotherDuck names it. The connector does not
create databases or schemas. The connection names no local file or directory, so there is no
project-relative path and no `.pz/` guard.

## Read options

| Key | Required | Default | Meaning |
|---|---|---|---|
| `columns` | No | – | Column name to type map. When declared, the read projects only these columns. |

A read compiles to a `select` over `"<database>"."<table>"`, with the incremental watermark and any
bounded window pushed into the query, so MotherDuck returns only the rows the run needs.

`sync` and `retry` under `read:` are the shared keys documented in the
[connections.yml reference](/reference/connections-yml/).

## Write options

`motherduck` takes no connector-specific write options. It supports every strategy:

| Strategy | What runs |
|---|---|
| `append` | `create table if not exists` from the staged rows' shape, then `insert`. |
| `replace` | One `create or replace table … as select`. |
| `merge` | One `merge into`, matched on `keys:`, executed by MotherDuck. Matched rows update, unmatched rows insert, and an empty batch leaves the target untouched. |

```yaml title="connections.yml"
cloud:
  connector: motherduck
  database: my_db
  token: ${MOTHERDUCK_TOKEN}
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
| `NativeScan` | Reads compile to a `select` over the attached database. |
| `NativeCopy` | Writes compile to native insert, create-or-replace, or merge statements. |
| `ReplaceWrites` | Supports `strategy: replace`. |
| `Merge` | Supports `strategy: merge` through a server-side `merge into`. |
| `BoundedWindow` | Pushes a watermark upper bound into the generated query. |
| `InclusiveWatermarkBound` | Accepts an inclusive lower watermark bound (`cursor >= value`). |

The connector does not declare `Transactional`: commit semantics belong to MotherDuck.

## Notes

- `motherduck` is native-only. Declaring `engine.force_universal` on a `motherduck` entity fails
  at plan time; remove that setting instead.
- **One token per run.** The extension accepts a token only once per process, before its first
  attach. Every connection in a run that uses the same `database` and `token` shares that one
  setup. A second connection with a different token fails its own setup with a redacted error.
  Use one token per project.
- **The token never appears in an error.** It rides a session setting, not the attach string. A
  wrong token fails as a permanent, redacted error that names only `md:<database>`.
- **Keep each merge batch key-unique.** MotherDuck matches every staged row on its own against the
  target as it stood before the statement. Duplicates of a key the target already holds all update
  it, and which value survives is not defined. Duplicates of a key the target lacks are all
  inserted. Deduplicate in the pipeline SQL that feeds a merge write.
- `pz validate --connect` reports the connection as not checked. There is no offline probe; the
  first run authenticates.

| Code | When |
|---|---|
| [`PZ0209`](/reference/error-codes/) | A `strategy: merge` write declares no `keys:`. |
| [`PZ0311`](/reference/error-codes/) | The token setting or the attach failed: a wrong token, a second token in the same run, or a database that does not exist. |
| [`PZ0312`](/reference/error-codes/) | `engine.force_universal` is set on a `motherduck` entity. |

## Related

- [Secure connection config](/how-to/secure-connection-config/) covers keeping the token out of the repository.
- [DuckLake](/connectors/ducklake/) can use a MotherDuck database as its catalog under the same token rule.
- [Delivery guarantees](/concepts/delivery-guarantees/) explains what `merge` and `replace` promise on retry.
- [Connectors](/connectors/) compares every builtin connector's capabilities at a glance.
