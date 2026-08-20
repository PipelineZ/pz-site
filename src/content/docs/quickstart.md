---
title: "Quickstart: run your first pipeline"
description: "In this quickstart, you install pz, scaffold a complete project, and run it end to end. It takes about five minutes. Everything happens offline against..."
---

In this quickstart, you install `pz`, scaffold a complete project, and run it end to end. It
takes about five minutes. Everything happens offline against local CSV files — no Docker, no
database, no network after the install.

## Prerequisites

- The .NET 10 SDK.

## 1. Install pz

`pz` installs as a standard .NET global tool:

```console
$ dotnet tool install --global pz
```

> [!IMPORTANT]
> **Installed `Pz.Cli` before?** That was the package id through `0.2.1`; the id is `pz`
> from `0.2.2` on. Both packages install a command named `pz`, so run
> `dotnet tool uninstall --global Pz.Cli` first — the install above fails on the shim
> collision otherwise, and `dotnet tool update --global Pz.Cli` would keep you pinned to the
> last `Pz.Cli` release forever. `Pz.Cli` stays listed on nuget.org (deprecated, pointing at
> `pz`) so existing lock files still restore.

> [!NOTE]
> To run an unreleased commit instead of the latest release, build from a clone.
> `scripts/verify-tool-install.sh` automates the full recipe: pack every project to a local folder
> feed, then install from that feed. Such a build reports a height-based prerelease version (MinVer
> increments the patch, so a commit after `v0.2.2` builds as `0.2.3-alpha.0.<height>+<sha>`), which
> is why installing one from a feed needs `--prerelease`.

Verify the install:

```console
$ pz --version
0.2.2+ca90edb9e15bc75829fee43b9e2a733366898ee7
```

The version is MinVer-computed from git tags: the `0.2.2` is the tag this build was cut from, and
what follows `+` is build metadata naming the exact commit.

## 2. Create a project

```console
$ pz init demo --template sample
scaffolded a new pz project 'demo' at /home/you/demo
next steps:
  cd demo && pz run orders_enriched
  (this template ships two independent flows; `pz run --all` runs both)
```

`--template sample` is what makes this quickstart runnable. A bare `pz init <name>` scaffolds
the **minimal** template — `project.yml` and `connections.yml`, both commented, plus a README
and a `.gitignore`, and nothing else — which is the right starting point once you're authoring
against your own data, because there is nothing to delete first. `sample` writes the worked
example instead:

```
demo/
├── project.yml              # name, version, connectors, vars, engine settings
├── connections.yml          # every place pz talks to: the CSV folder and the output lake
├── pipelines/
│   ├── stg_orders.sql       # staging: filter orders by min_amount
│   ├── orders_enriched.sql  # join staged orders to customers (has not_null/unique checks)
│   ├── configs/orders_enriched.yml
│   ├── order_totals.sql     # INSERT INTO form: aggregates directly into a sink
│   └── product_catalog.sql  # a second, independent flow; declares its read at the call site
├── data/customers.csv
├── data/orders.csv
├── data/products.csv
├── .gitignore
└── README.md
```

### The other templates

`sample` is one of five built-in starting points. `pz init --list-templates` prints the
catalog without scaffolding anything:

| Template | What it is | To run it |
|---|---|---|
| `minimal` *(default)* | `project.yml` + `connections.yml`, commented and ready to author against | nothing to run yet |
| `sample` | runnable four-pipeline demo over local CSVs: staging, a checked join, an aggregate | runs offline |
| `incremental` | watermark-bounded reads over local CSVs: run it twice, see the second run land nothing | runs offline |
| `http` | GitHub REST API to a parquet delta log: pagination, a crawl guard, a typed contract | needs internet, no credentials |
| `sqlserver` | SQL Server to SQL Server: incremental merge, six kinds of check, optional remote state | needs a reachable SQL Server |

Every template is a real, in-place-runnable pz project — the same directories the pz
repository keeps under `templates/`, embedded into the tool, so an installed `pz` scaffolds
them with no source tree and no network. After scaffolding, `pz init` prints the next command
for the template you picked.

> [!NOTE]
> `pz init` refuses to touch a target directory that already exists and isn't empty — you get
> a `PZ0130` error instead of silent overwrites. An unknown `--template` id is `PZ0131` (the
> message lists the known ids); combining `--list-templates` with a project name, or giving no
> name at all, is `PZ0132`. The name becomes the project's `name:` in `project.yml`, sanitized
> to lowercase `[a-z0-9_]` with a leading letter: `pz init "My Demo!"` warns and writes
> `name: my_demo`.

## 3. Run it

This template contains two **independent flows** (the orders chain and the products chain).
`pz run <name>` runs one flow — the named node plus everything upstream and downstream of it —
and is the everyday spelling:

    pz run orders_enriched

Bare `pz run` on a multi-flow project refuses with `PZ0215` so you never run everything by
accident; `pz run --all` is the explicit whole-project run:

```console
$ cd demo
$ pz run --all
ok src_raw__customers 3 rows 65ms
ok src_raw__orders 5 rows 49ms
ok src_raw__products 3 rows 41ms
ok stg_orders 3 rows 6ms
ok product_catalog 3 rows 8ms
ok order_totals 2 rows 23ms
ok orders_enriched 3 rows 23ms
ok check_orders_enriched_not_null_id_email 0 rows 9ms
ok check_orders_enriched_unique_id 0 rows 5ms
ok lake.order_totals 2 rows 45ms
ok lake.orders_curated 3 rows 31ms
ok lake.product_catalog 3 rows 12ms
run <runId>: 12 succeeded, 0 failed, 0 skipped (demo/.pz/runs/<runId>/run_results.json)
```

One command did all of it: every declared source loaded, every pipeline in both flows ran in
dependency order (staging → enrichment → aggregation), every data-quality check ran inline, and
all three sinks wrote — because `--all` ran both independent flows together.

> [!WARNING]
> Checks are observational, not gates: a failing check fails the run (exit 1), but the sinks in
> that same run still write — the flagged rows land in the destination alongside the red check.
> If bad data must never reach a destination, gate the run yourself: `pz test && pz run` — `pz test`
> executes the checks (and only their required ancestors, no sinks), so the sinks run only when
> every check passed. See [Run checks and retry failures](/how-to/run-checks-and-retry/).

The exit code tells you how the run went:

| Exit code | Meaning |
|---|---|
| `0` | Every node succeeded |
| `1` | Some node failed (others may still have completed) |
| `2` | Configuration or validation error |
| `3` | Fatal engine error |

> [!TIP]
> To consume run output programmatically instead of reading the console, use
> `--log-format json` — the NDJSON event contract is documented field by field in
> [Run events](/events/).

## 4. Look at the results

The run wrote all three sinks:

```console
$ cat out/order_totals/*.csv
```

The `lake` connection declares `root: out`, and a write with no `path:` of its own lands in a
directory named after the entity — so you'll find the aggregated totals as CSV under
`out/order_totals/`, the curated orders as Parquet under `out/orders_curated/`, and the product
catalog as CSV under `out/product_catalog/`.

## Next steps

- [Key concepts](/concepts/key-concepts/) — the vocabulary: DAG, node, source, sink, and more.
- [Inspect and validate a project](/how-to/inspect-and-validate/) — preview the plan and catch
  config errors before running.
- [Run checks and retry failures](/how-to/run-checks-and-retry/) — the `pz test` and `pz retry`
  verbs.
- [Architecture overview](/concepts/architecture-overview/) — how it all works.
