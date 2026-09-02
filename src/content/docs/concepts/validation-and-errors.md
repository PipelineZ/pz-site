---
title: "Validation and errors"
description: "The five validation tiers pz runs before it moves data, which command runs which tier, and how to read a PzError's code, message, file, and hint."
sidebar:
  order: 10
---

This page explains how `pz` checks a project before it runs anything, and how to read the errors
it reports. Read it when a command rejects your project and you want to know which check failed
and why.

## What it is

Validation is organized into five tiers, cheapest first. Each tier reports every problem it
finds before the next tier runs, so a broken project never reaches a network probe only to
report one error at a time.

| Tier | Checks |
|---|---|
| 1. Load | `project.yml` and `connections.yml` parse, env vars resolve, `--vars` overrides apply. |
| 2. Compile | Templates render, the dependency graph builds, semantic rules hold: no cycles, no duplicate names, every `ref()`/`sink()` resolves. |
| 3. Connector config | Every connection and entity's options validate against its connector's own JSON Schema, plus cross-field rules. |
| 4. SQL dry-compile | Every pipeline's SQL compiles against empty tables shaped by its known columns, in a throwaway DuckDB session. |
| 5. Connectivity | Live connections are probed and schema drift is detected. Only runs with `--connect`. |

## Why it matters

A project can be wrong in different ways, and each tier catches a different one. Tiers 1 through
4 need no network access, so they run in CI or a pre-commit hook without touching a real
database. Tier 5 needs live credentials and a network, so it is opt-in.

## How it works

### Which command runs which tier

- `pz compile` and `pz ls` run tiers 1 and 2 only: load and compile.
- `pz plan` runs tiers 1 and 2, plus starting each connector to know its capabilities.
- `pz validate` runs tiers 1 through 4 by default. Add `--connect` to also run tier 5.
- `pz run`, `pz test`, and `pz retry` run tiers 1 and 2 up front, then an implicit tier-4
  SQL dry-compile immediately before dispatching any node. They never run tier 5; a `SourceLoad`
  node that can't reach its connector fails at that node instead.

```console
$ pz validate
validation passed (3 pipelines, 2 connections checked)

$ pz validate --connect
validation passed (3 pipelines, 2 connections checked)
```

Tier 5 is also the one tier that writes anything: it caches every fetched schema for a
contract-less entity to `.pz/target/schemas.json`, so later tooling can read it without
reconnecting. An entity with no `columns:` contract anywhere also prints a tier-4 note
naming how many downstream pipelines could not be dry-compiled against it, since tier 4 has no
column shape to build an empty table from:

```
note: dataset 'raw.orders' has no columns: contract — 2 pipeline(s) not dry-compiled
```

### How errors are printed

Every validation failure is a `PzError` with five fields: a code, a message, an optional file, an
optional line, and an optional hint. `pz` prints one line per error:

```
error PZ0210: Selector 'stg_orderz' matched no nodes.
error PZ0341: entity 'products' declared in both connections.yml and its source() call (pipelines/product_catalog.sql:5) — hint: remove one declaration; the two never merge
```

The code and message always appear. The file and line appear when the error traces to a specific
place. The hint, when present, follows an em dash and suggests the fix.

### Aggregate reporting

A tier that finds three problems reports all three, not just the first. This holds within
DagCompiler's semantic checks, tier 3's connector config validation, and tier 4's dry-compile
alike. Fix everything a tier reports, then rerun: a tier only lets you through once it has
nothing left to say.

### Code families

Every code follows the pattern `PZ####`. The first one or two digits group codes by what they
guard:

| Range | Family |
|---|---|
| `01xx` | Load: project and connection file shape. |
| `02xx` | Semantic: dependency graph rules, checked at compile time. |
| `030x` | Connector host and registry. |
| `031x` | Native connector path selection. |
| `032x` | Restore and lock-file consistency. |
| `033x` | Connectivity. |
| `04xx` | SQL dry-compile. |
| `05xx` | Runtime: node execution, retry, state, and `pz clean`. |
| `051x` | Data checks. |
| `06xx` | MCP server: the tools `pz mcp` exposes to AI agents. |

## Example

A project with a typo'd `ref()` fails at tier 2, before any SQL runs:

```console
$ pz validate
error PZ0201: pipeline 'orders_enriched' calls ref('stg_orderz'), which does not exist (pipelines/orders_enriched.sql:5) — hint: did you mean 'stg_orders'?
```

The same project with a valid graph but a connector option typo'd fails one tier later, at tier
3, once the graph itself is confirmed sound:

```console
$ pz validate
error PZ0301: connection 'raw', connector 'localfiles': unknown option 'roots' (connections.yml:4) — hint: did you mean 'root'?
```

## Related

- [How a run works](/concepts/how-a-run-works/): where validation fits among the phases of a run.
- [Selecting nodes](/concepts/selecting-nodes/): the selector errors `PZ0210`, `PZ0215`, and `PZ0216`.
- [Inspect and validate a project](/how-to/inspect-and-validate/): running `pz validate` and `pz plan` in practice.
- [Error codes](/reference/error-codes/): the full registry, every code, message, and fix.
