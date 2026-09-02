---
title: "connections.yml"
description: "Every key connections.yml accepts at the connection, entity, read, and write levels, with types, defaults, and the error code each raises when misused."
sidebar:
  order: 3
---

This page lists every key `connections.yml` accepts: the connection level, the entity level, and
the `read:`/`write:` options each entity can carry. For what a connection and an entity are and
why options live in exactly one of two places, see
[Connections and entities](/concepts/connections-and-entities/).

## File shape

`connections.yml` has no wrapping key. Each top-level key is one connection:

```yaml title="connections.yml"
raw:
  connector: localfiles
  entities:
    customers:
      read:
        path: data/customers.csv
        columns:
          id: bigint
          email: varchar

mart:
  connector: postgres
  host: ${MART_PG_HOST}
  database: mart
  user: ${MART_PG_USER}
  password: ${MART_PG_PASSWORD}
```

## Connection-level keys

`pz` owns six keys at the connection level. A connector's own config schema is refused
(`PZ0345`) if it declares any of these, because it could never receive them; everything else at
this level passes straight through to the connector, flat, not nested under a `config:` key.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `connector` | string | required (`PZ0101`) | Which connector handles this connection: `localfiles`, `postgres`, `s3`, `sqlserver`, `azureblob`, `gcs`, `http`, `mysql`, `sqlite`, `sftp`, or a restored package. |
| `entities` | map of entity name to `{read, write}` | empty | The entities declared at this connection. See below. |
| `max_concurrency` | integer, >= 1 | unbounded (`engine.threads` still governs) | Caps how many of this connection's nodes the dispatcher runs concurrently. |
| `rate_limit` | map | none | Request pacing for this connection. See below. Instance-level only; declaring it under `read:` is `PZ0318`. |
| `retry` | map | see below | Retry policy for operations against this connection. |
| `allow_unsigned_extensions` | bool | `false` | Lets DuckDB load an unsigned packaged extension for this connection's native scans (`PZ0359` otherwise). |

## `retry:`

Declarable at the connection level, and again inside one entity's `read:` or `write:` block,
where it overrides the connection's value field by field. An unset field cascades: entity retry,
then connection retry, then the engine default of 3 attempts, a 1s base delay, and a 30s cap.

```yaml
retry:
  max_attempts: 8
  base_delay: 2s
  max_delay: 5m
```

| Key | Type | Default | Meaning |
|---|---|---|---|
| `max_attempts` | integer, >= 1 | `3` | Attempts before the node fails. |
| `base_delay` | duration | `1s` | Delay before the first retry. |
| `max_delay` | duration | `30s` | Cap on the delay between retries. Must be >= `base_delay` when both are set on the same block. |

Delay grows exponentially between attempts, `base_delay × 2^(attempt-1)`, capped at `max_delay`
and jittered by about ±25%. A malformed block is `PZ0121`.

## `rate_limit:`

Connection-level only.

```yaml
rate_limit:
  requests_per_minute: 60
  burst: 10
```

| Key | Type | Default | Meaning |
|---|---|---|---|
| `requests_per_minute` | integer, 1–1,000,000 | required when `rate_limit:` is present | Steady-state request rate. |
| `burst` | integer, 1–1,000,000 | derived from `requests_per_minute` | Allowance above the steady rate for a short spike. |

A malformed block, or one that requires a `GatedOperations`-capable connector that this
connection's connector lacks, is `PZ0318`/`PZ0317`.

## Entities

Each entity is a named thing inside a connection, keyed exactly as the remote system spells it:
`dbo.orders`, `public.customers`, `issues`. Under it, `read:` and `write:` hold how to move data
in each direction; an entity that is both read and written appears once, with both blocks. An
entity key with an empty body, or `read: {}`, is legal and means "no options declared here."

```yaml
entities:
  dbo.orders:
    read:
      columns:
        order_id: bigint
        updated_at: timestamp
    write:
      strategy: merge
      keys: [order_id]
```

An entity name that is empty, has an empty dotted segment, or contains whitespace is
`PZ0344`. An entity block with neither `read:` nor `write:` is `PZ0101`.

## `entities.<name>.read:`

These keys are recognized at every connector; anything else in the block is passed straight
through as a connector-specific read option (see [Connector-specific keys](#connector-specific-keys)).

| Key | Type | Default | Meaning |
|---|---|---|---|
| `columns` | map of column name to DuckDB type | none (contract-less) | Typed read contract, e.g. `id: bigint`, `email: varchar`. Required by some connectors on the universal execution tier; optional elsewhere. |
| `sync` | map: `mode`, plus mode-specific keys | mode `auto` | Resume behavior for this entity. See below. |
| `retry` | map | inherits the connection's `retry:` | Overrides retry for this entity's reads only. Same keys as connection-level `retry:`. |
| `partition_column`, `partitions` | string, integer (1–16) | none | On connectors that support parallel reads (`postgres`, `sqlserver`): the column to split on and how many partitions to read concurrently. Connector-specific; see that connector's page. |

`rate_limit:` is refused under `read:` (`PZ0318`): it is connection-level only. The retired
`incremental:` block, and `schema:`/`table:` qualifiers, are described under
[Retired forms](#retired-forms).

### `sync:`

```yaml
sync:
  mode: incremental
  cursor: updated_at
  max_window: 7d
  initial: 2026-01-01
  until: 2026-06-01
```

| Key | Modes it applies to | Type | Meaning |
|---|---|---|---|
| `mode` | all | `incremental`\|`cdc`\|`auto` | How this entity resumes across runs. Required when `sync:` is present at all. |
| `cursor` | `incremental` | column name | The ordered column reads resume from. Required for `incremental`. |
| `max_window` | `incremental` | duration or value | Bounds one run's extract to a window past the watermark, for backfill in slices. |
| `initial` | `incremental` | value | The starting cursor value before any watermark exists. |
| `until` | `incremental` | value | An upper bound on the cursor for this run. |
| `slot` | `cdc` | string | Names the server-side change-capture slot or instance, when a connector needs more than one. |

`mode: incremental` without `cursor` is `PZ0334`. `mode: cdc` accepts only `mode` and `slot`;
`mode: auto` accepts only `mode`. An unknown key under the resolved mode, an unrecognized
`mode`, or a `sync:` block that is present but not a mapping is also `PZ0334`. Omitting `sync:`
entirely is equivalent to `mode: auto`. See [Incremental loads](/concepts/incremental-loads/).

## `entities.<name>.write:`

| Key | Type | Default | Meaning |
|---|---|---|---|
| `strategy` | `replace`\|`append`\|`merge` | `append` | How rows land: overwrite the target, add to it, or upsert by key. |
| `keys` | list of column names | empty | Merge key columns. Required when `strategy: merge` (`PZ0209`); refused on any other strategy (`PZ0211`). |
| `duplicates` | the literal string `accept` | none (no consent given) | Explicit consent for duplicate rows on a write. The only accepted value is `accept`; any other value is `PZ0334`. |
| `on_delete` | `delete`\|`soft`\|`ignore` | none | How a CDC-fed merge routes source deletes. Requires `strategy: merge`; any other strategy makes it `PZ0334`. |
| `schema_policy` | string | `fail_on_change` | How a sink reconciles its target's existing schema. `fail_on_change` compares every declared column by name and type and fails on drift. `evolve` is a recognized name but not implemented; connectors that see it refuse the write. `additive` is recognized narrowly by the `postgres` and `sqlserver` sinks to add the missing soft-delete marker column when `on_delete: soft` is set. |
| `retry` | map | inherits the connection's `retry:` | Overrides retry for this entity's writes only. |

A malformed `write:` block, or a bad value for `strategy`/`duplicates`/`on_delete`/
`schema_policy`, is `PZ0334`. Anything left in the block after these keys are removed is passed
through as a connector-specific write option.

:::note
An incremental read feeding a plain `strategy: append` sink risks duplicate rows on a retried or
partially failed run: pz requires `duplicates: accept` as explicit consent for that combination
(`PZ0214`), rather than silently allowing it.
:::

## Connector-specific keys

Everything not listed above is a connector-specific read or write option: `format` and `path`
for file-shaped connectors, `query` for SQL connectors, `pagination` for `http`, and so on. Each
connector's own page lists its full set:
[localfiles](/connectors/localfiles/), [postgres](/connectors/postgres/), [s3](/connectors/s3/),
[sqlserver](/connectors/sqlserver/), [azureblob](/connectors/azureblob/),
[gcs](/connectors/gcs/), [http](/connectors/http/), [mysql](/connectors/mysql/),
[sqlite](/connectors/sqlite/), [sftp](/connectors/sftp/). An option a connector does not
recognize is `PZ0301`.

## Same option in YAML and in the call

Every read or write option can be declared here, under `entities: <name>: read:`/`write:`, or as
a keyword argument on the `source()`/`sink()` call that uses it in a pipeline, but never both.
Declaring an entity-side's options in both places is `PZ0341`, not a precedence rule: pz never
merges a YAML default with a call-site override. See
[Connections and entities](/concepts/connections-and-entities/#two-surfaces-one-declaration).

## Retired forms

| Old form | Error | Replacement |
|---|---|---|
| A top-level `outputs:` block | `PZ0347` | Declare each place as a connection; write options move to `entities: <name>: write:`. |
| A `sources/` or `sinks/` directory | `PZ0346` | One `connections.yml` file, with `read:`/`write:` nested under each entity. |
| `schema:`/`table:` under `read:` | `PZ0348` | The entity name is the object name: key the entity `schema.table` directly. |
| A bare `incremental:` block under `read:` | `PZ0332` | The unified `sync: { mode: incremental, cursor: <column> }` block. |
| `mode:`/`accept_duplicates:` kwargs on a `sink()` call | `PZ0333` | `strategy:`/`duplicates: 'accept'` kwargs, or the equivalent `write:` block here. |

## `${VAR}` interpolation

Any scalar value in `connections.yml` may reference an environment variable with `${NAME}`. pz
substitutes it at load time and fails the load with `PZ0103` if the variable is unset, rather
than connecting with a blank credential. Values are redacted from logs and run artifacts. See
[Secure connection config](/how-to/secure-connection-config/).

## Errors

| Code | Meaning |
|---|---|
| [`PZ0101`](/reference/error-codes/) | Missing `connector:`, a connection or entity block that is not a mapping, an entity with neither `read:` nor `write:`, or an unrecognized key. |
| [`PZ0103`](/reference/error-codes/) | A `${VAR}` reference names a variable that is not set in the environment. |
| [`PZ0121`](/reference/error-codes/) | A `retry:` block is malformed, out of bounds, or has an unparseable duration. |
| [`PZ0122`](/reference/error-codes/) | `max_concurrency:` is not an integer, or is less than 1. |
| [`PZ0209`](/reference/error-codes/) | `strategy: merge` declares no `keys:`. |
| [`PZ0211`](/reference/error-codes/) | A non-`merge` strategy declares `keys:`. |
| [`PZ0301`](/reference/error-codes/) | A read or write option the target connector does not recognize. |
| [`PZ0318`](/reference/error-codes/) | `rate_limit:` is malformed, out of bounds, or declared under `read:`/`write:` instead of the connection. |
| [`PZ0332`](/reference/error-codes/) | A retired top-level `incremental:` block under `read:`. |
| [`PZ0333`](/reference/error-codes/) | A retired `mode:`/`accept_duplicates:` kwarg at a `sink()` call site. |
| [`PZ0334`](/reference/error-codes/) | `sync:` is malformed or its mode's keys are wrong, or `write:`'s `strategy`/`duplicates`/`on_delete`/`schema_policy` is invalid. |
| [`PZ0341`](/reference/error-codes/) | A read or write option declared in both `connections.yml` and at the `source()`/`sink()` call site. |
| [`PZ0344`](/reference/error-codes/) | An entity name is empty, has an empty dotted segment, or contains whitespace. |
| [`PZ0345`](/reference/error-codes/) | A connector's config schema declares a key pz reserves at connection level. |
| [`PZ0346`](/reference/error-codes/) | A `sources/` or `sinks/` directory is present. |
| [`PZ0347`](/reference/error-codes/) | A top-level `outputs:` block is present. |
| [`PZ0348`](/reference/error-codes/) | `schema:`/`table:` used under `read:` instead of naming the entity fully. |
| [`PZ0359`](/reference/error-codes/) | A native scan needs an unsigned DuckDB extension and `allow_unsigned_extensions: true` is not set. |

## Related

- [Connections and entities](/concepts/connections-and-entities/): what a connection and an entity are, and why options live in exactly one place.
- [project.yml reference](/reference/project-yml/): the file `connections.yml` sits alongside, including `state.connection`.
- [Incremental loads](/concepts/incremental-loads/): watermarks, bounded windows, and the three `sync:` modes explained.
- [Template functions](/reference/template-functions/): the `source()`/`sink()` call-site spelling of every option on this page.
- [Error codes](/reference/error-codes/): the full registry, including every code listed above.
