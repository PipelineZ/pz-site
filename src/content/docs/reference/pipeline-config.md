---
title: "Pipeline config"
description: "Every key a pipelines/configs sidecar YAML file accepts, including the six check types and their options."
sidebar:
  order: 4
---

This page lists every key a pipeline's sidecar config file accepts: `materialization`,
`tags`, `checks`, and `columns`, plus the options each of the six check types takes. For what a
[check](/concepts/checks/) is and where it runs in a flow, see that page instead.

## File shape

A pipeline's sidecar lives at `pipelines/configs/<name>.yml`, next to `pipelines/<name>.sql`.
It is optional: a pipeline with no sidecar materializes as a plain table with no tags and no
checks. The `pipeline:` key, not the file name, decides which pipeline a sidecar configures:

```yaml title="pipelines/configs/orders_enriched.yml"
pipeline: orders_enriched
materialization: table
tags: [daily]
checks:
  - not_null: [id, email]
  - unique: [id]
```

`pipeline:` naming a `.sql` file that does not exist is `PZ0111`. A sidecar file itself that is
not valid YAML, or whose top level is not a mapping, is `PZ0101`.

## Top-level keys

| Key | Type | Default | Meaning |
|---|---|---|---|
| `pipeline` | string | required | The pipeline this sidecar configures. Must match a `.sql` file's base name exactly. |
| `materialization` | `table`\|`ephemeral` | `table` | `table` runs the pipeline as its own node and stages its result. `ephemeral` inlines the pipeline's SQL as a CTE into every pipeline that `ref()`s it, producing no node of its own. |
| `tags` | list of strings | empty | Labels for `--select tag:<name>` node selection. See [Selecting nodes](/concepts/selecting-nodes/). |
| `checks` | list of check mappings | empty | Data-quality checks to run against this pipeline's result. See below. |
| `columns` | list of `{ name, redact }` mappings | empty | Redaction marks on this pipeline's output columns, read only by `pz preview`. See [`columns:`](#columns). |

:::caution
`materialization` only recognizes the literal value `ephemeral`. Any other value, including a
typo like `emphemeral`, is silently treated as `table` rather than rejected.
:::

An ephemeral pipeline cannot declare checks, because it produces no node for a check to depend
on (`PZ0205`). It also cannot `ref()` another ephemeral pipeline (`PZ0204`): ephemeral chains
are not allowed.

## `checks:`

Each list item is a single-key mapping: the key names the check type, the value carries its
options. Two shapes are both valid for `not_null` and `unique`:

```yaml
checks:
  - not_null: [id, email]                              # bare list of columns
  - not_null: { columns: [id, email], sample_values: false }  # dict form
```

A check entry that is not a mapping, that carries more than one key, or whose type is not one
of the six below, is `PZ0113`. `column`/`columns` and `sample_values` are reserved: they never
count as an unknown option for any check type.

### `not_null` / `unique`

| Key | Type | Default | Meaning |
|---|---|---|---|
| `columns` | list of column names | required, at least one | The bare-list form's implicit key: columns to check. |
| `sample_values` | bool | project's `engine.check_samples` (`true` unless set) | Whether a failing check's console report includes example violating values. |

No other option is accepted.

### `row_count`

| Key | Type | Default | Meaning |
|---|---|---|---|
| `min` | integer | none | Minimum acceptable row count. At least one of `min`/`max` is required. |
| `max` | integer | none | Maximum acceptable row count. |
| `sample_values` | bool | project default | Same as above. |

`min` greater than `max` is `PZ0113`. `row_count` takes no `column`/`columns`.

### `freshness`

| Key | Type | Default | Meaning |
|---|---|---|---|
| `column` | column name | required, exactly one | The timestamp or date column to check. |
| `max_age` | duration | required, positive | How old the newest value may be before the check fails, e.g. `24h`. |
| `sample_values` | bool | project default | Same as above. |

```yaml
- freshness: { column: updated_at, max_age: 24h }
```

### `accepted_values`

| Key | Type | Default | Meaning |
|---|---|---|---|
| `column` | column name | required, exactly one | The column to check. |
| `values` | non-empty list of scalars | required | The allowed set. Every value must be a string, integer, float, or boolean. |
| `sample_values` | bool | project default | Same as above. |

```yaml
- accepted_values: { column: status, values: [pending, shipped, delivered] }
```

### `custom_sql`

| Key | Type | Default | Meaning |
|---|---|---|---|
| `name` | string matching `[a-z][a-z0-9_]*` | required | Identifies the check. Becomes the node name `check_<pipeline>_<name>`, and must be unique among a pipeline's `custom_sql` checks. |
| `sql` | string | required, non-empty | A query returning the violating rows. |

`custom_sql` takes no `column`/`columns`; put the column logic in the query itself.

```yaml
- custom_sql:
    name: no_negative_amounts
    sql: SELECT * FROM staging.orders_current WHERE amount < 0
```

## `columns:`

Marks output columns of this pipeline as sensitive. [`pz preview`](/reference/cli/#pz-preview)
shows every value in a marked column, nulls included, as `•••`. Nothing else reads the list: it
declares no types and enforces nothing, and adding or removing a mark changes no node id.

```yaml title="pipelines/configs/stg_customers.yml"
pipeline: stg_customers
columns:
  - name: email
    redact: true
  - name: phone
    redact: true
```

| Key | Type | Default | Meaning |
|---|---|---|---|
| `name` | column name | required | An output column of this pipeline. Matched ignoring case. |
| `redact` | bool | `false` | `true` marks the column. |

No other key is accepted: a `type:` is refused (`PZ0101`), because types belong in a source's
`columns:` contract, not here. Two entries whose names differ only in case are refused
(`PZ0101`). `pz validate` warns with `PZ0403` when a marked name is not a column the pipeline
outputs, usually a typo or a column renamed in the SQL; the check runs only for a pipeline whose
SQL dry-compiles.

Marks do not follow a column through a pipeline. A column marked on a source, or on an upstream
pipeline, is not marked in this pipeline's output: mark it again here if this pipeline outputs it.
This list is also where to mark a column read from a source that has no `columns:` contract (see
[Redacting columns](/reference/connections-yml/#redacting-columns)).

## Sample sidecar

Adapted from the `sqlserver` template, using all six check types on one pipeline:

```yaml title="pipelines/configs/orders_current.yml"
pipeline: orders_current
checks:
  - not_null: [order_id, status]
  - unique: [order_id]
  - row_count: { min: 1 }
  - freshness: { column: updated_at, max_age: 24h }
  - accepted_values: { column: status, values: [pending, shipped, delivered] }
  - custom_sql:
      name: no_negative_amounts
      sql: SELECT * FROM staging.orders_current WHERE amount < 0
```

## Errors

| Code | Meaning |
|---|---|
| [`PZ0101`](/reference/error-codes/) | The sidecar file is not valid YAML, or its top level is not a mapping. Also a `columns:` that is not a list, an entry with no `name`, a key other than `name`/`redact`, a `redact` that is not `true`/`false`, or a name repeated ignoring case. |
| [`PZ0111`](/reference/error-codes/) | `pipeline:` names a pipeline no `.sql` file defines. |
| [`PZ0113`](/reference/error-codes/) | A check entry is malformed: not a single-key mapping, an unknown type, a missing or malformed per-type option, or an unrecognized option key. |
| [`PZ0205`](/reference/error-codes/) | An ephemeral pipeline declares checks. |
| [`PZ0403`](/reference/error-codes/) | A warning: `columns:` marks a column the pipeline does not output. |

## Related

- [Checks](/concepts/checks/): what a check is, where it runs, and how `pz test` uses it.
- [Pipelines](/concepts/pipelines/): how a pipeline's SQL and its sidecar fit together.
- [Template functions](/reference/template-functions/): `source()`, `ref()`, and `sink()`, the calls a pipeline's SQL makes.
- [connections.yml reference](/reference/connections-yml/): the entity-level `read:`/`write:` options a pipeline's `source()`/`sink()` calls draw on.
- [Error codes](/reference/error-codes/): the full registry, including every code listed above.
