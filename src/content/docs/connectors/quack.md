---
title: "Quack"
description: "Reference for the quack connector, which reads and writes a remote DuckDB server over the Quack protocol on the native tier only, including how its merge-by-replace works."
sidebar:
  order: 10
---

The `quack` connector reads and writes a DuckDB database served by a remote quack server. The
engine's session attaches the server once per connection through DuckDB's `quack` extension, and
every read and write is a SQL statement the server executes. The connector runs on the native tier
only.

## Connection

```yaml title="connections.yml"
wh:
  connector: quack
  uri: quack:wh.internal:9494
  token: ${QUACK_TOKEN}
```

| Key | Required | Default | Meaning |
|---|---|---|---|
| `uri` | Yes | – | `quack:host`, `quack:host:port`, or `quack://host[:port]`. All three normalize to `quack:host:port`, with a default port of 9494. |
| `token` | Yes | – | The server's access token, at least four characters. Use an environment reference, never a literal. |

An entity is `table` or `schema.table`, named the way the server names it. The connector does not
create schemas. The connection names no local file or directory, so there is no project-relative
path and no `.pz/` guard.

## Read options

| Key | Required | Default | Meaning |
|---|---|---|---|
| `columns` | No | – | Column name to type map. When declared, the read projects only these columns. |

A read compiles to a `select` over the attached table, with the incremental watermark and any
bounded window pushed into the query, so the server returns only the rows the run needs.

`sync` and `retry` under `read:` are the shared keys documented in the
[connections.yml reference](/reference/connections-yml/).

## Write options

`quack` takes no connector-specific write options. It supports every strategy, but its merge is
different from the other DuckDB-family connectors:

| Strategy | What runs |
|---|---|
| `append` | `create table if not exists` from the staged rows' shape, then `insert`. |
| `replace` | One `create or replace table … as select`. |
| `merge` | Merge-by-replace: pull the target, merge it with the staged rows locally, and rewrite the whole remote table in one `create or replace table`. |

A quack-attached table accepts only bulk `create table as` and `insert` from the wire protocol.
There is no row-level `update`, `delete`, or `merge`, which is why merge rewrites the table. That
rewrite is the full blast radius, every time:

- Primary keys, `not null` and `default` constraints, and indexes on the target do not survive.
- The target's column order follows the staged rows' order.
- A matched row is replaced whole. A column the staged rows omit comes back null on matched rows,
  so keep the pipeline's column set stable across runs.
- Duplicate keys within one batch collapse to one connector-chosen survivor.
- An empty batch still rewrites the table, with every target row kept. Cost grows with the target
  table's size, since the whole table crosses the wire on every merge.

Whether the rewrite is atomic is the server's guarantee. A failed rewrite can leave the target
missing or partial until the next run, which recomputes the same result.

`strategy`, `keys`, `schema_policy`, and `retry` under `write:` are the shared keys documented in
the [connections.yml reference](/reference/connections-yml/).

## Capabilities

| Flag | Meaning |
|---|---|
| `NativeScan` | Reads compile to a `select` over the attached server. |
| `NativeCopy` | Writes compile to native insert, create-or-replace, or merge-by-replace statements. |
| `ReplaceWrites` | Supports `strategy: replace`. |
| `Merge` | Supports `strategy: merge` as merge-by-replace. |
| `BoundedWindow` | Pushes a watermark upper bound into the generated query. |
| `InclusiveWatermarkBound` | Accepts an inclusive lower watermark bound (`cursor >= value`). |

The connector does not declare `Transactional`: commit semantics belong to the server.

## Notes

- `quack` is native-only. Declaring `engine.force_universal` on a `quack` entity fails at plan
  time; remove that setting instead.
- **The token never appears in an attach string or an error.** It rides a DuckDB secret scoped to
  the normalized `uri`. A wrong token fails as a permanent, redacted error.
- **TLS is the reverse proxy's job.** The connector has no TLS settings. Put a reverse proxy in
  front of the server for anything beyond a trusted private network.
- `pz validate --connect` probes TCP reachability of the host and port only, with a five-second
  timeout. Credentials are verified by the first run.

| Code | When |
|---|---|
| [`PZ0209`](/reference/error-codes/) | A `strategy: merge` write declares no `keys:`. |
| [`PZ0311`](/reference/error-codes/) | The secret or the attach failed at run time, for example a wrong token or an unreachable server. |
| [`PZ0312`](/reference/error-codes/) | `engine.force_universal` is set on a `quack` entity. |

## Related

- [DuckLake](/connectors/ducklake/) can use a quack server as its catalog with the same `uri` and `token` keys.
- [Delivery guarantees](/concepts/delivery-guarantees/) explains what `merge` and `replace` promise on retry.
- [Secure connection config](/how-to/secure-connection-config/) covers keeping the token out of the repository.
- [Connectors](/connectors/) compares every builtin connector's capabilities at a glance.
