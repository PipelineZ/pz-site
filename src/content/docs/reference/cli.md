---
title: "CLI reference"
description: "Every pz command, its options with their defaults, and the CLI's exit codes and output formats."
sidebar:
  order: 1
---

This page lists every `pz` command and its options, transcribed from `pz --help`. Read it when
you need an exact flag or default. For the narrative version of how a run proceeds, see
[How a run works](/concepts/how-a-run-works/).

## Verbs at a glance

| Verb | What it does |
|---|---|
| `pz init` | Scaffold a new project from a built-in template. |
| `pz validate` | Check config and SQL without running anything. |
| `pz compile` | Render pipelines and build the DAG, without running anything. |
| `pz plan` | Show the execution strategy the engine would use for each node. |
| `pz run` | Execute a flow end to end: read, transform, check, write. |
| `pz test` | Run data checks and their required ancestors, without writing to sinks. |
| `pz retry` | Re-run the last run's failed and skipped nodes. |
| `pz ls` | List every node in the compiled DAG, in topological order. |
| `pz runs` | List prior runs, newest first, with their status, timing, and provenance. |
| `pz connectors` | List every registered connector and its capabilities. |
| `pz restore` | Resolve and download declared non-builtin connector packages. |
| `pz connector test` | Run protocol conformance checks against an out-of-process connector. |
| `pz cdc status` | Report change-capture health for every CDC entity. |
| `pz cdc drop` | Drop change-capture state for one CDC entity. |
| `pz clean` | Reclaim disk space from old runs. |
| `pz state show` | Report stored watermark and sync state. |
| `pz state rollback` | Roll a watermark back to a value from a prior run. |
| `pz state set` | Set a watermark's value directly. |
| `pz state clear` | Remove a watermark entry entirely. |
| `pz schema accept` | Accept observed schema drift as the new baseline. |
| `pz mcp` | Serve the project to AI agents over the Model Context Protocol. |
| `pz mcp init` | Write MCP client config and install the pz-pipelines skill. |
| `pz completion` | Print a shell completion script for pz to stdout. |

## Global options

These three options are not verb-specific.

| Option | Meaning |
|---|---|
| `-?`, `-h`, `--help` | Show help and usage information. Works on `pz` itself and on every command. |
| `--version` | Show version information. Top-level only. |
| `--project <project>` | Project directory (default: current directory). Present on nearly every verb below. `pz init` takes a positional directory argument instead, and `pz connector test` takes neither. |

## pz init

Scaffold a new project from a built-in template.

```console
$ pz init my-project --template sample
```

| Option | Meaning | Default |
|---|---|---|
| `<name>` | Directory to scaffold into. `.` scaffolds into the current directory. | required |
| `-t`, `--template <template>` | Which built-in template to scaffold. | `minimal` |
| `--list-templates` | List every built-in template and exit; scaffolds nothing. | — |

See also: [Project layout](/concepts/project-layout/), [Quickstart](/quickstart/).

## pz validate

Validate config and SQL without running anything: tiers 1 to 4 (shape, semantics, connector
option schemas, SQL dry-compile). With `--connect`, also probes live connections and schema
drift (tier 5).

```console
$ pz validate --connect
```

| Option | Meaning | Default |
|---|---|---|
| `--project <project>` | Project directory. | current directory |
| `--vars <vars>` | JSON object of var overrides. | none |
| `--connect` | Also probe connectivity and detect schema drift (tier 5). | off |
| `--no-lock-check` | Skip `pz.lock.json` drift verification against `project.yml`. | off |

See also: [Validation and errors](/concepts/validation-and-errors/), [Error codes](/reference/error-codes/).

## pz compile

Render pipelines, build the DAG, and write `.pz/target` artifacts. Does not execute anything.

```console
$ pz compile
```

| Option | Meaning | Default |
|---|---|---|
| `--project <project>` | Project directory. | current directory |
| `--vars <vars>` | JSON object of var overrides. | none |
| `--select <select>` | dbt-style node selector restricting which nodes are processed. | none |

See also: [How a run works](/concepts/how-a-run-works/).

## pz plan

Show the per-node execution strategy the engine would use, and why: native scan or copy versus
the universal batch path. Always compiles the full project and writes `.pz/target/plan.json`;
names, `--select`, and `--all` only filter the printed table. The selection also tells the planner
which nodes `pz run` with the same selection would execute, so a connector's plan-time refusal
([`PZ0353`](/reference/error-codes/)) on a node outside it is recorded in `plan.json`, not raised.

```console
$ pz plan orders_enriched
```

| Option | Meaning | Default |
|---|---|---|
| `<names>` | Flow name(s): filter the printed table to each node plus every ancestor and descendant. | every node |
| `--project <project>` | Project directory. | current directory |
| `--vars <vars>` | JSON object of var overrides. | none |
| `--select <select>` | dbt-style node selector restricting which nodes are processed. | none |
| `--all` | Select the whole project. Required for bare `pz run` when the project has 2+ independent flows. | — |
| `--no-lock-check` | Skip `pz.lock.json` drift verification against `project.yml`. | off |

See also: [How a run works](/concepts/how-a-run-works/), [Selecting nodes](/concepts/selecting-nodes/).

## pz run

Execute a flow end to end: load sources, run pipelines and checks, write sinks. `pz run <name>`
runs the flow through that node. With two or more independent flows, bare `pz run` is an error
(`PZ0215`): name a flow, pass `--select`, or pass `--all`.

```console
$ pz run orders_enriched --full-refresh
```

| Option | Meaning | Default |
|---|---|---|
| `<names>` | Flow name(s): each runs that node plus every ancestor and descendant. Exact node names only. | none |
| `--project <project>` | Project directory. | current directory |
| `--vars <vars>` | JSON object of var overrides. | none |
| `--fail-fast` | Cancel remaining nodes as soon as one fails. | off |
| `--full-refresh` | Ignore stored watermarks and sync state for this run; capture and advancement still run and re-establish them from the full extract. | off |
| `--select <select>` | dbt-style node selector restricting which nodes are processed. | none |
| `--all` | Select the whole project. Required when the project has 2+ independent flows. | — |
| `--no-lock-check` | Skip `pz.lock.json` drift verification against `project.yml`. | off |
| `--log-format <log-format>` | Output format: `text` or `json` (NDJSON, one object per run event). | `text` |
| `--otel-endpoint <otel-endpoint>` | OTLP/grpc collector endpoint (absolute `http(s)` URL). Falls back to `PZ_OTEL_ENDPOINT`. | none |
| `--state-url <state-url>` | Run-scoped HTTP state endpoint (absolute `http(s)` URL). Outranks `project.yml`'s `state:` and `PZ_STATE_*`. | none |

See also: [How a run works](/concepts/how-a-run-works/), [Delivery guarantees](/concepts/delivery-guarantees/).

## pz test

Run data checks (`not_null`, `unique`, `row_count`, `freshness`, `accepted_values`, `custom_sql`)
and their required ancestors, the owning pipeline and its sources, without executing any sink.

```console
$ pz test --select tag:daily
```

| Option | Meaning | Default |
|---|---|---|
| `--project <project>` | Project directory. | current directory |
| `--vars <vars>` | JSON object of var overrides. | none |
| `--select <select>` | dbt-style node selector narrowing which checks run. | none |
| `--no-lock-check` | Skip `pz.lock.json` drift verification against `project.yml`. | off |
| `--log-format <log-format>` | Output format: `text` or `json`. | `text` |
| `--otel-endpoint <otel-endpoint>` | OTLP/grpc collector endpoint. Falls back to `PZ_OTEL_ENDPOINT`. | none |
| `--state-url <state-url>` | Run-scoped HTTP state endpoint. | none |

See also: [Checks](/concepts/checks/).

## pz retry

Re-run the last run's failed and skipped nodes, plus their required ancestors, against the
current project. Takes no `--select` or `--vars`: retry re-runs the prior intent verbatim.

```console
$ pz retry --fail-fast
```

| Option | Meaning | Default |
|---|---|---|
| `--project <project>` | Project directory. | current directory |
| `--fail-fast` | Cancel remaining nodes as soon as one fails. | off |
| `--full-refresh` | Ignore stored watermarks for this invocation; capture and watermark advancement still run and re-establish them from the full extract. | off |
| `--no-lock-check` | Skip `pz.lock.json` drift verification against `project.yml`. | off |
| `--log-format <log-format>` | Output format: `text` or `json`. | `text` |
| `--otel-endpoint <otel-endpoint>` | OTLP/grpc collector endpoint. Falls back to `PZ_OTEL_ENDPOINT`. | none |
| `--state-url <state-url>` | Run-scoped HTTP state endpoint. | none |

See also: [Delivery guarantees](/concepts/delivery-guarantees/).

## pz ls

List every node in the compiled DAG, in topological order.

```console
$ pz ls --select +orders_enriched
```

| Option | Meaning | Default |
|---|---|---|
| `--project <project>` | Project directory. | current directory |
| `--vars <vars>` | JSON object of var overrides. | none |
| `--select <select>` | dbt-style node selector restricting which nodes are processed. | none |

See also: [Selecting nodes](/concepts/selecting-nodes/).

## pz runs

List prior runs, newest first, with their status, timing, and provenance (how many nodes were
`reused` or `carried_forward` from an earlier run). Reads only `state:` out of `project.yml`, the
same way `pz clean` does, so a broken pipeline or connections.yml never stops it reporting what
already ran. Works identically under a remote state backend.

```console
$ pz runs --limit 5
```

| Option | Meaning | Default |
|---|---|---|
| `--project <project>` | Project directory. | current directory |
| `--json` | Print one JSON object per run (NDJSON) instead of a table. | off |
| `--limit <limit>` | Show only the N most recent runs. Must be 1 or greater (`PZ0534`). | all |

See also: [How a run works](/concepts/how-a-run-works/).

## pz connectors

List every registered connector, builtin and restored, with its capabilities and tiers.

```console
$ pz connectors
```

| Option | Meaning | Default |
|---|---|---|
| `--project <project>` | Project directory. | current directory |
| `--vars <vars>` | JSON object of var overrides. | none |

See also: [Connectors](/concepts/connectors/).

## pz restore

Resolve declared non-builtin connectors against the host feeds, materialize them under
`.pz/packages`, and write `pz.lock.json`.

An existing `pz.lock.json` is honoured, not overwritten: every package it names is restored at
exactly the locked version and must hash to the locked `sha512`, or restore fails with `PZ0327`.
A requirement the lock no longer satisfies (a bumped version, a new or removed connector) is
`PZ0321`, with `--update` as the next step. A lock honoured for exactly this host, with every
package already content-verified in the local cache, never touches a feed at all: once a project
has restored once, a later restore that changes nothing succeeds fully offline. Any other
failure reaching a feed or writing under `.pz` is reported as `PZ0328` (feed unreachable or
refused) or `PZ0329` (a local disk failure) instead of a raw exception.

```console
$ pz restore
$ pz restore --update
```

| Option | Meaning | Default |
|---|---|---|
| `--project <project>` | Project directory. | current directory |
| `--feeds <feeds>` | NuGet feed URL or local folder path, in probe order. Repeatable. Overrides `PZ_FEEDS`. | nuget.org |
| `--update` | Ignore the existing `pz.lock.json`: re-resolve every declared connector against the feeds and write a new lock. Without it, an existing lock pins every package to its locked version and content. | off |

See also: [Connectors](/concepts/connectors/).

## pz connector test

Run black-box PCP protocol conformance checks against an out-of-process connector.

```console
$ pz connector test ./dist/my-connector --config probe.yml
```

| Option | Meaning | Default |
|---|---|---|
| `<target>` | Path to a connector package directory containing `pz.connector.json`, or a bare entrypoint binary. | required |
| `--config <config>` | YAML file naming the connection to configure and the `read:`/`write:` entity(ies) to probe. | none |

This is the one verb with no `--project` option: it targets a connector package directly, not a
pz project. See also: [Author a connector](/how-to/author-a-connector/).

## pz cdc

Inspect and tear down server-side change-capture state.

### pz cdc status

Report server-side change-capture state for every CDC entity in the project. Exits `0` when
every reported entity is healthy, `1` when any is unhealthy.

```console
$ pz cdc status
```

| Option | Meaning | Default |
|---|---|---|
| `--project <project>` | Project directory. | current directory |

### pz cdc drop

Drop server-side change-capture state for one CDC entity and clear pz's sync-state entry for it,
so the next run re-snapshots. Exactly one target; there is no bulk drop.

```console
$ pz cdc drop crm.orders
```

| Option | Meaning | Default |
|---|---|---|
| `<target>` | The CDC entity to drop, as `<connection>.<entity>`. Exactly one required. | required |
| `--project <project>` | Project directory. | current directory |

See also: [Capture changes with CDC](/how-to/capture-changes-with-cdc/).

## pz clean

Reclaim disk from `.pz/runs`. By default deletes `staging.duckdb` from every run but the newest,
keeping every `run_results.json`. Never touches `.pz/state`, `.pz/target`, or `.pz/packages`.

```console
$ pz clean --keep-last 5
```

| Option | Meaning | Default |
|---|---|---|
| `--project <project>` | Project directory. | current directory |
| `--keep-last <keep-last>` | Keep the newest N runs. `0` selects every run, including the newest. | `1` |
| `--older-than <older-than>` | Select runs older than a duration like `30m`, `12h`, or `7d`. The newest run is kept regardless. | none |
| `--purge` | Delete whole run directories instead of only `staging.duckdb`. | off |
| `--dry-run` | Print what would be deleted, and delete nothing. | off |

`--keep-last` and `--older-than` are mutually exclusive (`PZ0511`). See also:
[project.yml reference](/reference/project-yml/#retention) for the automatic sweep this verb
also does by hand.

## pz state

Inspect and repair watermark state in `.pz/state`.

### pz state show

Report stored watermark and sync state. With a key, add that entity's run-by-run history and
any manual changes. Exits `1` when a state file is corrupt.

```console
$ pz state show crm.orders
```

| Option | Meaning | Default |
|---|---|---|
| `<key>` | A single `<connection>.<entity>` to detail, with its run history. | list everything |
| `--project <project>` | Project directory. | current directory |

### pz state rollback

Roll a stored watermark back to the value a named prior run advanced it to. Backward only; use
`pz state set` to move one forward.

```console
$ pz state rollback crm.orders --to-run 20260901T120000Z --yes
```

| Option | Meaning | Default |
|---|---|---|
| `<key>` | The `<connection>.<entity>` whose watermark to roll back. | required |
| `--project <project>` | Project directory. | current directory |
| `--to-run <to-run>` | The run whose recorded watermark becomes the new value. Pick one from `pz state show <key>`. | required |
| `--reason <reason>` | Free text recorded in `.pz/state/audit.jsonl`. | none |
| `--dry-run` | Print what would change, and change nothing. | off |
| `--yes` | Skip the confirmation prompt. Required when stdout is not a TTY. | off |

### pz state set

Set a stored watermark's value directly, in either direction. Existing entries only: the cursor
column and type are inherited, so this cannot invent an entry.

```console
$ pz state set crm.orders --value 2026-09-01T00:00:00Z --yes
```

| Option | Meaning | Default |
|---|---|---|
| `<key>` | The `<connection>.<entity>` whose watermark to set. | required |
| `--project <project>` | Project directory. | current directory |
| `--value <value>` | The new cursor value, canonicalized against the stored cursor type. | required |
| `--reason <reason>` | Free text recorded in `.pz/state/audit.jsonl`. | none |
| `--dry-run` | Print what would change, and change nothing. | off |
| `--yes` | Skip the confirmation prompt. Required when stdout is not a TTY. | off |

### pz state clear

Remove a stored watermark entirely, so the next run extracts that entity in full. The only
remedy for an entry whose cursor type pz has no arithmetic for.

```console
$ pz state clear crm.orders --yes
```

| Option | Meaning | Default |
|---|---|---|
| `<key>` | The `<connection>.<entity>` whose watermark to remove. | required |
| `--project <project>` | Project directory. | current directory |
| `--reason <reason>` | Free text recorded in `.pz/state/audit.jsonl`. | none |
| `--dry-run` | Print what would change, and change nothing. | off |
| `--yes` | Skip the confirmation prompt. Required when stdout is not a TTY. | off |

See also: [State](/concepts/state/).

## pz schema accept

Accept the latest run's observed schema for one or more entities as the new baseline. Never
contacts the source: it only reads the latest run's recorded observed schema and the current
baseline.

```console
$ pz schema accept crm.orders
```

| Option | Meaning | Default |
|---|---|---|
| `<targets>` | One or more `<connection>.<entity>` entities to accept. | every entity the latest run recorded a differing schema for |
| `--project <project>` | Project directory. | current directory |

See also: [Schema contracts](/concepts/schema-contracts/), [Detect schema drift at run time](/how-to/handle-schema-drift/).

## pz mcp

Serve this project to AI agents over the Model Context Protocol, over stdio.

```console
$ pz mcp
```

| Option | Meaning | Default |
|---|---|---|
| `--project <project>` | Project directory. | current directory |
| `--allow-run` | Also expose `pz_run`/`pz_retry`/`pz_run_results`, letting a connected agent move real data. | off |

### pz mcp init

Write MCP client config files, merge-preserving, and install the `pz-pipelines` skill, for one
or more AI clients.

```console
$ pz mcp init claude-code vscode
```

| Option | Meaning | Default |
|---|---|---|
| `<clients>` | One or more of `vscode`, `claude-code`, `copilot-cli`, `opencode`. | none |
| `--all` | Wire up all four clients. | off |
| `--allow-run` | Bake `--allow-run` into every generated pz server entry. | off |
| `--skill-locations <skill-locations>` | Comma-separated install locations: `standard`, `claudecode`, `github`, `opencode`, or `all`/`none`. | `standard` plus the locations the chosen clients imply |
| `--project <project>` | Project directory. | current directory |

See also: [Use pz with an AI agent](/how-to/use-with-an-ai-agent/), [MCP contract](/reference/mcp-contract/).

An existing client config file that legally carries comments or trailing commas (JSONC, such as
a hand-edited `.vscode/mcp.json`) cannot be merged and rewritten without silently deleting those
comments, so `pz mcp init` refuses to touch it (`PZ0611`) and instead prints the exact entry to
paste in by hand. A file that isn't valid JSON even tolerantly is the pre-existing `PZ0605`.

## pz completion

Print a shell completion script for `pz` to stdout. Each script is a thin shim: it hands the
command line and cursor position back to `pz "[suggest:<position>]" "<line>"`, answered by the
command-line parser itself, so verbs, sub-verbs, and options complete from whatever the
installed `pz` accepts — an upgrade never leaves a stale script behind. Where pz has nothing to
offer (an option's value is usually a path), the script falls back to the shell's own file
completion. No network, no file writes.

```console
$ pz completion bash
```

| Option | Meaning | Default |
|---|---|---|
| `<shell>` | `bash`, `zsh`, `fish`, or `pwsh`. Anything else is `PZ0535`. | required |

Install per shell:

| Shell | Install |
|---|---|
| bash | Add `source <(pz completion bash)` to `~/.bashrc`. |
| zsh | Add `source <(pz completion zsh)` to `~/.zshrc` (works whether zsh autoloads it from `fpath` or sources it directly). |
| fish | `pz completion fish > ~/.config/fish/completions/pz.fish` |
| pwsh | Add `pz completion pwsh \| Out-String \| Invoke-Expression` to `$PROFILE`. |

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Success. Every node succeeded, or the reported check (`pz cdc status`, `pz state show`) is healthy. |
| `1` | Run or check failure. At least one node failed, or `pz cdc status` found an unhealthy entity, or `pz state show` found a corrupt state file. Also returned for a run cancelled (Ctrl-C, `SIGTERM`, `SIGHUP`) after at least one node had already failed. |
| `2` | Usage or configuration error: bad flags, invalid `project.yml`/`connections.yml`, a validation failure. |
| `3` | Fatal engine error: an unexpected failure outside normal node execution or configuration, or a run cancelled before any node had failed. |

Set `PZ_DEBUG=1` (any non-empty, non-`0` value) to include the full stack trace on an
unanticipated internal error (`PZ0500`); without it, only the error type and message print.

A stop signal — Ctrl-C, `SIGTERM` (the default stop signal of systemd, Docker, Kubernetes, and
Airflow), or `SIGHUP` (a closing terminal or SSH session) — winds a run down cooperatively
instead of killing the process outright: the first signal cancels the run cooperatively, so
in-flight nodes stop at their next cancellation point, pending ones are skipped,
`run_results.json` records the final status, and connector processes get to clean up. A second signal is left unhandled and terminates the process immediately, so a
run that will not wind down never traps an operator or a supervisor's stop sequence. `SIGQUIT` is
left alone, for an operator to request a stuck process's dump.

## Output formats

`pz run`, `pz test`, and `pz retry` accept `--log-format text` (the default) or
`--log-format json`, which emits NDJSON: one JSON object per run event on stdout, instead of the
human-readable renderer. Both formats describe the same underlying event stream; the contract
for each event's shape is in [Run events](/reference/events/).

Console output during a run is a live tree on a TTY, showing per-node status, rows moved,
throughput, and elapsed time, and plain sequential lines when stdout is piped or redirected. The
`CI` environment variable forces plain rendering even on a TTY: set it to any value in a CI
pipeline to get deterministic, ANSI-free logs. See
[Environment variables](/reference/environment-variables/).

## Related

- [project.yml reference](/reference/project-yml/): every key `pz run` and its siblings read from the project.
- [connections.yml reference](/reference/connections-yml/): the connection and entity config these verbs load.
- [Run events](/reference/events/): the full NDJSON event contract for `--log-format json`.
- [How a run works](/concepts/how-a-run-works/): the phases behind `pz run`, `pz compile`, and `pz plan`.
- [Error codes](/reference/error-codes/): every `PZ####` code these verbs can raise.
