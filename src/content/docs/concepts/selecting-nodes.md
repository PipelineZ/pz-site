---
title: "Selecting nodes"
description: "How pz run, plan, test, ls, and compile let you narrow a project down to one node, one flow, or a pattern of nodes, and what happens when a selector matches nothing."
sidebar:
  order: 7
---

This page covers how to pick which nodes a command touches: a flow name, a `--select`
expression, or `--all`. Read it once you have a project with more than a handful of nodes and
want to run, test, or inspect less than the whole thing.

## What it is

A [node](/concepts/key-concepts/) is one unit of work in the compiled dependency graph. Most
`pz` commands act on every node by default. `--select` and, on `pz run` and `pz plan`, plain
positional names let you narrow that down without editing the project.

Five verbs accept a selection, but not the same way:

| Verb | Positional names | `--select` | `--all` |
|---|---|---|---|
| `pz run` | yes | yes | yes |
| `pz plan` | yes | yes | yes |
| `pz test` | no | yes | no |
| `pz ls` | no | yes | no |
| `pz compile` | no | yes | no |

A positional name and `--select` are mutually exclusive on `pz run` and `pz plan`. Passing more
than one selection mechanism at once is `PZ0216`.

## Why it matters

A real project outgrows "run everything" fast. You want to rerun one broken pipeline, test only
the checks on a table you just changed, or preview the plan for a flow before wiring it into CI.
Selection is how you say "this part" without deleting the rest of the project first.

## How it works

### Flow names

A bare name on `pz run` or `pz plan`, such as `pz run orders_enriched`, is an exact match
against one node's name. It expands to that node plus **every ancestor and every descendant**,
the whole [flow](/concepts/key-concepts/) through it. This is the closure `pz run <name>` always
uses; it does not accept wildcards or tags, only exact node names. `pz ls` prints every node's
name in the `name` column, so it doubles as the lookup table.

### The `--select` grammar

`--select` takes a small expression language, closer to a query than a name:

- **A bare pattern** matches node names. `*` is a wildcard, so `stg_*` matches every node whose
  name starts with `stg_`.
- **`tag:name`** matches pipelines carrying that sidecar tag (`tags:` in a pipeline's config
  file). Only pipelines carry tags.
- **`source:conn.entity`** matches a source load by its connection and entity, for example
  `source:raw.orders`. Wildcards work here too: `source:raw.*` matches every entity `raw` loads.
- **A leading `+`** pulls in every ancestor of the match, inclusive. `+orders_enriched` is
  `orders_enriched` plus everything upstream of it.
- **A trailing `+`** pulls in every descendant, inclusive. `stg_orders+` is `stg_orders` plus
  everything downstream.
- **A comma** inside one group intersects: `stg_orders+,tag:daily` matches nodes that are both
  downstream of `stg_orders` and tagged `daily`.
- **A space** separates groups, and groups union: `stg_orders tag:daily` matches everything
  `stg_orders` alone matches, plus everything `tag:daily` alone matches.

An atom whose base pattern matches zero nodes fails the whole command immediately, even if a
later atom in the same expression would have matched something. This is deliberate: a typo in a
selector should never silently run less than you meant.

### `--all`

`--all` selects the entire project. It exists because a project with two or more independent
flows refuses a bare `pz run` with no argument: `pz run` alone cannot tell whether you meant one
flow or all of them, so it stops and asks you to say which. Name a flow, pass `--select`, or pass
`--all`.

### When nothing matches

An unmatched selector is always an error, never an empty no-op run. Two shapes show up:

- A `--select` atom that matches nothing raises `PZ0210` naming that exact atom.
- A positional flow name with no matching node also raises `PZ0210`, listing the project's known
  flows so you can pick a real one.

A project with multiple flows and no selection at all raises `PZ0215` instead, naming every
flow it found. Combining a positional name, `--select`, and `--all` in one invocation is
`PZ0216`, since only one selection mechanism is allowed per command.

## Example

The `sample` template (`pz init myproj --template sample`) compiles to two independent flows.
The **orders** flow has source loads `src_raw__orders` and `src_raw__customers`, pipelines
`stg_orders` and `orders_enriched`, two checks on `orders_enriched`, and a sink write to
`lake.orders_curated`. It also feeds a separate pipeline, `order_totals`, sinking to
`lake.order_totals`. The **products** flow is one pipeline, `product_catalog`, reading
`src_raw__products` and sinking to `lake.product_catalog`.

```console
$ pz run orders_enriched
```

Runs `src_raw__orders`, `src_raw__customers`, `stg_orders`, `orders_enriched`, both of its
checks, and `lake.orders_curated`. It skips `order_totals` and the whole products flow, since
neither is an ancestor or descendant of `orders_enriched`.

```console
$ pz run --select 'stg_orders+,tag:daily'
```

Matches nodes downstream of `stg_orders` that are also tagged `daily`. In the sample template,
that is `orders_enriched` and its checks, since `orders_enriched.yml` sets `tags: [daily]` but
`order_totals` carries no tags.

```console
$ pz test --select 'orders_enriched+'
```

`pz test` always runs Check nodes only, so this filters to the checks downstream of
`orders_enriched`, ignoring the pipeline and sink nodes the same expression would also match.

Because this project has two independent flows, a bare `pz run` stops with `PZ0215`. Run
`pz run --all` to run both.

## Grammar reference

| Syntax | Matches |
|---|---|
| `name` | Exact node name |
| `pattern*` | Wildcard over node names |
| `tag:name` | Pipelines carrying that sidecar tag |
| `source:conn.entity` | The source load for that connection and entity, wildcard-capable |
| `+atom` | The atom's matches plus every ancestor |
| `atom+` | The atom's matches plus every descendant |
| `a,b` | Intersection: nodes matching both `a` and `b` |
| `a b` | Union: nodes matching `a` or `b` |

## Related

- [Key concepts](/concepts/key-concepts/): what a node, flow, and pipeline are.
- [How a run works](/concepts/how-a-run-works/): what happens once nodes are selected.
- [Checks](/concepts/checks/): how tags and sidecar config attach to a pipeline.
- [CLI reference](/reference/cli/): every flag on `run`, `plan`, `test`, `ls`, and `compile`.
- [Error codes](/reference/error-codes/): full detail on `PZ0210`, `PZ0215`, and `PZ0216`.
