---
title: "Template functions"
description: "Every function, constant, and sandbox rule available inside a pipeline's SQL template."
sidebar:
  order: 5
---

This page lists every function and constant `pz` makes available inside `pipelines/*.sql`, what
each renders to, and the options each call accepts. For how these calls fit into a pipeline's
SQL, see [Pipelines](/concepts/pipelines/).

Every `source()`, `ref()`, `sink()`, and `watermark()` call must fit on one line: pz's template
engine, Scriban, ends a statement at the newline.

## `source(connection, entity, **options)`

Reads an entity. Declares a DAG edge from the entity to this pipeline and renders to the
staging table pz loads it into.

```sql
select * from {{ source('raw', 'customers') }}
```

| Keyword option | Type | Meaning |
|---|---|---|
| `columns` | mapping of column to type | Typed read contract, same shape as `read: columns:` in connections.yml. |
| `sync` | mapping | Resume behavior: `{ mode: 'incremental', cursor: '<column>' }` and friends. Same shape as `read: sync:` in connections.yml. |
| `retry` | mapping | `{ max_attempts, base_delay, max_delay }`. Same shape as connections.yml's `retry:`. |
| `partition_column`, `partitions` | string, integer | On connectors that support parallel reads: the column to split on and how many partitions to read concurrently. |

Anything else is passed straight through as a connector-specific read option, exactly as an
unrecognized key under connections.yml's `read:` is.

`rate_limit` and `max_concurrency` are refused here (`PZ0318`): both are connection-level only,
declared in connections.yml. `table`/`schema` are refused (`PZ0348`): the entity name carries
its own qualification. The retired `incremental` keyword is refused (`PZ0332`).

## `ref(pipeline)`

Resolves to another pipeline's result and declares a DAG edge to it.

```sql
select * from {{ ref('stg_orders') }}
```

Renders to that pipeline's staging table. If the referenced pipeline is `materialization:
ephemeral`, it renders instead to the name of the CTE the compiler inlines it as, so `ref()`
works identically regardless of the target's materialization.

## `sink(connection, entity, **options)`

Declares this pipeline's load target. Used as the target of the pipeline's leading `INSERT
INTO`:

```sql
INSERT INTO {{ sink('mart', 'mart.orders_current', strategy: 'merge', keys: ['order_id']) }}
select order_id, amount, status from {{ source('erp', 'dbo.orders') }}
```

| Keyword option | Type | Meaning |
|---|---|---|
| `strategy` | `replace`\|`append`\|`merge` | How rows land. Default `append`. |
| `keys` | list of column names | Merge key columns. Required when `strategy: merge`. |
| `duplicates` | the literal string `accept` | Explicit consent for duplicate rows on an append write. |
| `on_delete` | `delete`\|`soft`\|`ignore` | How a CDC-fed merge routes source deletes. Requires `strategy: merge`. |
| `schema_policy` | string | How the sink reconciles its target's existing schema. Default `fail_on_change`. |
| `retry` | mapping | `{ max_attempts, base_delay, max_delay }`. |

Anything else is passed straight through as a connector-specific write option, exactly as an
unrecognized key under connections.yml's `write:` is.

`rate_limit` is refused here (`PZ0318`): connection-level only. `table`/`schema` are refused
(`PZ0348`). The retired `mode`, `accept_duplicates`, and `write` keywords are refused
(`PZ0333`), and the removed `input` keyword is refused (`PZ0112`): the pipeline carrying the
`sink()` call is the input.

Every read or write option can be set in connections.yml or at the call site, but never both.
Declaring one in both places is `PZ0341`. See [connections.yml reference](/reference/connections-yml/#same-option-in-yaml-and-in-the-call).

## `watermark(source, dataset)`

Renders a comparison against an entity's stored incremental cursor, inside a `WHERE` clause.
The two positional arguments name a connection and an entity, in that order:

```sql
where updated_at > {{ watermark('erp', 'dbo.orders') }}
```

`watermark()` declares no DAG edge of its own; pair it with a `source()` call for the same
connection and entity to declare the read.

## `var(name)`

Renders a project variable's value.

```sql
where region = '{{ var('region') }}'
```

An undeclared variable name fails the render.

## `env(name)`

Renders the value of an environment variable.

```sql
where tenant_id = '{{ env('TENANT_ID') }}'
```

An unset variable is `PZ0103`.

## Constants

| Name | Renders to |
|---|---|
| `this` | The current pipeline's own staging table name. |
| `run_id` | The current run's id, as a string. |
| `run_started_at` | The current run's start time, ISO 8601, the same value for every pipeline rendered within one run. |

## The sandbox

Pipeline SQL renders inside a sandboxed Scriban context: only the functions and constants above
are reachable, and strict-variable mode turns any other unrecognized name into a render error
instead of silently producing empty output.

| Feature | Availability |
|---|---|
| `source()`, `ref()`, `sink()`, `watermark()`, `var()`, `env()` | Available, as documented above. |
| `this`, `run_id`, `run_started_at` | Available, as constants. |
| `if`/`else`, `for`, variable assignment, string interpolation | Available: plain Scriban language syntax, not builtin objects. |
| `array`, `date`, `html`, `math`, `object`, `regex`, `string`, `timespan` | Blocked. Scriban's builtin function objects are stripped from the render context. |
| `include`, `include_join` | Blocked. No file includes: no file I/O inside a template. |
| `empty`, `blank` | Blocked, along with the rest of Scriban's builtin objects. |
| Any other identifier | Blocked. Strict-variable mode raises an error rather than rendering it as empty. |

## Errors

| Code | Meaning |
|---|---|
| [`PZ0101`](/reference/error-codes/) | `columns`/`keys` at a call site is the wrong shape. |
| [`PZ0103`](/reference/error-codes/) | `env()` names a variable that is not set. |
| [`PZ0104`](/reference/error-codes/) | The template failed to parse or render for another reason, including an unknown `var()` name. |
| [`PZ0112`](/reference/error-codes/) | `sink()` was passed the removed `input` keyword. |
| [`PZ0121`](/reference/error-codes/) | A `retry:` block at a call site is malformed. |
| [`PZ0201`](/reference/error-codes/) | `source()`/`ref()` is malformed: missing or extra arguments. |
| [`PZ0208`](/reference/error-codes/) | `sink()` is malformed: missing or extra arguments, or a duplicated keyword. |
| [`PZ0318`](/reference/error-codes/) | `rate_limit`/`max_concurrency` passed at a call site instead of the connection. |
| [`PZ0332`](/reference/error-codes/) | `source()` was passed the retired `incremental` keyword. |
| [`PZ0333`](/reference/error-codes/) | `sink()` was passed a retired `mode`/`accept_duplicates`/`write` keyword. |
| [`PZ0334`](/reference/error-codes/) | `strategy`/`duplicates`/`on_delete`/`schema_policy` at a call site has an invalid value. |
| [`PZ0341`](/reference/error-codes/) | A read or write option declared in both connections.yml and at the call site. |
| [`PZ0344`](/reference/error-codes/) | An entity name is empty, has an empty dotted segment, or contains whitespace. |
| [`PZ0348`](/reference/error-codes/) | `table`/`schema` passed as a `source()`/`sink()` keyword instead of a qualified entity name. |

## Related

- [Pipelines](/concepts/pipelines/): how a pipeline's SQL, its `source()`/`sink()` calls, and its sidecar fit together.
- [connections.yml reference](/reference/connections-yml/): the same read/write options, declared in YAML instead of at a call site.
- [Pipeline config](/reference/pipeline-config/): the sidecar YAML a pipeline's `.sql` file pairs with.
- [Incremental loads](/concepts/incremental-loads/): watermarks and `sync:` modes, explained end to end.
- [Error codes](/reference/error-codes/): the full registry, including every code listed above.
