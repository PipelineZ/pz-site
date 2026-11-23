---
title: "Quack"
description: "Reference for the quack connector, which reads and writes a remote DuckDB server over the Quack protocol on the native tier only, including how its server-side merge works."
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

`quack` takes no connector-specific write options. It supports every strategy:

| Strategy | What runs |
|---|---|
| `append` | `create table if not exists` from the staged rows' shape, then `insert`, matched by column name rather than position. |
| `replace` | One `create or replace table … as select`. |
| `merge` | The staged rows are shipped into a scratch table on the server, merged into the target with one `merge into`, and the scratch table is dropped, all in one transaction. |

Quack runs `update` and `merge` only when every table the statement reads is on the server, which
is why the staged rows are shipped first. Only the batch crosses the wire, and:

- The target keeps its primary keys, `not null` and `default` constraints, indexes, and column
  order, and the server enforces them: a batch that violates one fails the merge.
- Every target column is written, so a batch that omits one fails the merge
  (`table "…" has N columns but M values were supplied`) rather than nulling it. Select every
  target column, `null` for the ones the pipeline does not have.
- Duplicate keys within one batch collapse to one connector-chosen survivor; declare
  [`duplicates: latest`](/concepts/delivery-guarantees/#duplicate-keys-in-one-merge-batch) with
  `order_by` to choose it.
- A failed merge rolls back whole: the target is unchanged and no scratch table is left behind.
  The scratch table is named per target, so keep one writer per target.

`strategy`, `keys`, `schema_policy`, and `retry` under `write:` are the shared keys documented in
the [connections.yml reference](/reference/connections-yml/).

## Capabilities

| Flag | Meaning |
|---|---|
| `NativeScan` | Reads compile to a `select` over the attached server. |
| `NativeCopy` | Writes compile to native insert, create-or-replace, or merge statements. |
| `ReplaceWrites` | Supports `strategy: replace`. |
| `Merge` | Supports `strategy: merge` as a server-side `merge into`. |
| `BoundedWindow` | Pushes a watermark upper bound into the generated query. |
| `InclusiveWatermarkBound` | Accepts an inclusive lower watermark bound (`cursor >= value`). |

The connector does not declare `Transactional`: commit semantics belong to the server.

## Notes

- `quack` is native-only. Declaring `engine.force_universal` on a `quack` entity fails at plan
  time; remove that setting instead.
- **`append` matches columns by name, not position.** A target column the pipeline does not
  produce keeps its existing default; a column the pipeline produces that the target lacks is an
  error naming it. (`merge` is stricter: a batch must carry every target column, see above.)
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
