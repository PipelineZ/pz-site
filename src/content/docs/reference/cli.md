---
title: "CLI reference"
description: "The pz command line, built on System.CommandLine + Spectre.Console. Every command runs the same eight phases (load → restore-check → compile → validate →..."
---

The `pz` command line, built on `System.CommandLine` + Spectre.Console. Every command runs
the same eight phases (`load → restore-check → compile → validate → plan → execute → finalize
→ report`); `pz compile` and `pz plan` stop early. See
[The execution model](/concepts/execution-model/).

## Verbs

| Verb | Does |
|---|---|
| `pz init <name> [--sample]` | Scaffold a new project: `project.yml` + `connections.yml`, ready to author against. `--sample` writes the runnable four-pipeline demo instead |
| `pz restore` | Resolve declared non-builtin connector packages, fetch them, write `pz.lock.json` |
| `pz validate [--connect]` | Validate config/SQL (tiers 1–4); with `--connect`, also probe live connectivity and schema drift (tier 5). Sink output options are not schema-validated in v0 — the connectors themselves validate them at plan/probe time |
| `pz compile` | Render pipelines, build the DAG, write `.pz/target` artifacts (no execution) |
| `pz plan [names...] [--select ...] [--all]` | Compile + print the per-node execution strategy and static memory budget, without running; names/`--select`/`--all` filter the printed table only |
| `pz run [names...] [--all] [--select ...] [--vars '{...}'] [--full-refresh] [--fail-fast]` | Execute the DAG: `pz run <name>` runs one flow (the node plus all ancestors and descendants); bare `pz run` errors with `PZ0215` when the project has 2+ independent flows — pass `--all` to run everything |
| `pz test [--select ...]` | Execute only data-quality checks and their required ancestors |
| `pz ls [--select ...]` | List every project node in topological order: kind, name, tags |
| `pz retry` | Re-execute only the nodes that didn't succeed in the most recent run (plus their dependents); reuses the failed run's staged source data when eligible (see [Delivery guarantees](/concepts/delivery-guarantees/)); refuses interrupted or fatal runs |
| `pz connectors` | List every registered connector (builtin + restored) with its package, version, tiers, and capabilities — one row per connector, including `src:native-only`/`snk:native-only` markers |
| `pz clean [--keep-last N] [--older-than DUR] [--purge] [--dry-run]` | Reclaim space from `.pz/runs` (or, under a SQL state backend, from the configured store): deletes `staging.duckdb` from every run but the newest, keeping every `run_results.json`. Never touches `.pz/state`, `.pz/target`, or `.pz/packages`. `pz run` also sweeps automatically at the end of every run — see `retention:` in [project structure](/concepts/project-structure/). `pz clean` remains the on-demand verb, and the only way to purge whole run directories or select by age. Like `pz state`, it reads only `project.yml`'s `state:` key (plus `connections.yml` when `state.connection` names an entry) — a config that no longer parses never blocks a cleanup. **Under a SQL-backed `state.artifacts`, a swept run is always deleted whole regardless of `--purge`** — the run's rows *and* its local `.pz/runs/<id>/` directory, which under that backend holds nothing but `staging.duckdb`; see [Move state off the local disk](/how-to/remote-state/#retention-and-pz-clean-under-a-remote-backend) |
| `pz state show [<key>]` | Report stored watermark and sync state; with a key, add that dataset's run-by-run history and any manual changes. Under `backend: local` (the default) this is free: only `project.yml`'s own `state:` key is read — no pipeline validation, no `connections.yml`, no connectors, no network. Under a SQL state backend it additionally reads `connections.yml` (only when `state.connection` names an entry) and does real network I/O, and can fail with `PZ0518`/`PZ0519` — reads never mutate anything, on either backend |
| `pz state rollback <key> --to-run <id>` | Roll a watermark back to the value a named prior run advanced it to (backward only). Same backend exposure as `pz state show` above: free under `backend: local`, network I/O and `PZ0518`/`PZ0519` under a SQL state backend |
| `pz state set <key> --value <v>` | Set a watermark's value directly, either direction; existing entries only. Same backend exposure as `pz state show` above |
| `pz state clear <key>` | Remove a watermark entry, so the next run extracts that dataset in full. Same backend exposure as `pz state show` above |
| `pz schema accept [<connection>.<entity> ...]` | Accept the latest run's observed schema for one or more contract-less source datasets as the new `on_source_drift` baseline (default: every dataset the latest run recorded a differing observed schema for). Never opens a connector — reads only the latest run's artifacts and the current baseline; see [Detect schema drift at run time](/how-to/schema-drift/) |

## Options

| Option | On | Does |
|---|---|---|
| `--sample` | `init` | Scaffold the runnable four-pipeline sample project (bundled CSVs, two independent flows) instead of the minimal two-file one. The sample's pipelines compile and run, so it is opt-in: a bare `pz init` never leaves you demo files to delete before authoring your own |
| `--select <selector>` | `plan`, `run`, `test` | Limit to matching nodes; selection syntax is dbt's: `orders_enriched+` (node and descendants), `+node`, `tag:daily`, `source:crm.*`, unions/intersections |
| `[names...]` (positional) | `plan`, `run` | Flow names: each selects that node plus every ancestor and descendant (the whole flow through it); exact node names only (wildcards/tags are `--select`'s job) |
| `--all` | `plan`, `run` | Select the whole project explicitly; required for `run` when the project has 2+ independent flows. Names, `--select`, and `--all` are mutually exclusive (`PZ0216`) |
| `--vars '{...}'` | `run` | Override `project.yml` vars for this invocation |
| `--full-refresh` | `run` | Ignore stored watermarks this invocation; windowed datasets restart from `initial` |
| `--fail-fast` | `run` | Cancel everything on the first node failure (default: fail the node, skip its descendants, continue independent branches) |
| `--connect` | `validate` | Add tier-5 online checks: connectivity, schema drift, sink permission probes |
| `--project <dir>` | all | Run against a project directory other than the current one |
| `--log-format json` | executing verbs | Swap the human renderer for NDJSON events — same event stream, two renderers; contract in [Run events](/events/) |
| `--keep-last <N>` | `clean` | Keep the newest N runs (default: 1). `0` selects every run, including the newest — after which `pz retry` has no target. Mutually exclusive with `--older-than` (`PZ0511`) |
| `--older-than <dur>` | `clean` | Select runs older than `30m`/`12h`/`7d`. The newest run is kept regardless; only `--keep-last 0` gives it up |
| `--purge` | `clean` | Delete whole run directories instead of only `staging.duckdb` |
| `--dry-run` | `clean` | Print what would be deleted, and delete nothing |
| `--to-run <id>` | `state rollback` | The run whose recorded watermark becomes the new value; pick one from `pz state show <key>` (`PZ0514` when it recorded none) |
| `--value <v>` | `state set` | The new cursor value, canonicalized against the stored cursor type (`PZ0515` when it will not parse) |
| `--reason "..."` | `state` writes | Free text recorded in `.pz/state/audit.jsonl` alongside the replaced value |
| `--dry-run` | `state` writes | Print what would change, and change nothing |
| `--yes` | `state` writes | Skip the confirmation prompt; required when stdout is not a TTY (`PZ0516`) |
| `--no-lock-check` | executing verbs | Skip the lock-file drift check (emergencies only; loud) |
| `--otel-endpoint <url>` | executing verbs | Wire the OTLP exporter for spans/meters (also settable via env); zero cost when off |
| `--quiet`, `-v`, `-vv` | all | Adjust console verbosity |

Console output during `run` is a live tree on a TTY (per-node status, rows moved, throughput,
elapsed) and plain sequential lines when piped. CI is auto-detected: no ANSI, no live
rendering.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Every node succeeded |
| `1` | Run completed with node failures |
| `2` | Configuration or validation error |
| `3` | Fatal engine error |

## Next steps

- [Quickstart](/quickstart/) — the verbs in action.
- [Run events](/events/) — the `--log-format json` contract.
- [`project.yml` reference](/reference/project-yml/) — every config key, including `state:`.
