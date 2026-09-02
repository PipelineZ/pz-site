---
title: "State"
description: "What pz remembers between runs, where it stores that in .pz/, how retention reclaims disk, and the local, sqlserver, and http backends that can hold it instead."
sidebar:
  order: 11
---

This page explains what `pz` keeps between one run and the next, where it lives, and how to
inspect or repair it. Read it once you have a project running on a schedule and need to know
what survives a crash, a restart, or a bad watermark.

## What it is

A `pz` project keeps everything it remembers in one directory: `.pz/`, created next to
`project.yml` on first use. Nothing under it is required for the project to be reproducible; a
fresh checkout with no `.pz/` directory runs correctly, it just starts from scratch.

```
.pz/
├── state/
│   ├── watermarks.json   # per-entity incremental cursor position
│   ├── sync-state.json   # per-entity sync/CDC position
│   ├── schemas.json      # accepted schema baselines, for drift detection
│   └── audit.jsonl       # log of every manual pz state edit
├── runs/<run-id>/
│   ├── staging.duckdb    # that run's staging database
│   └── run_results.json  # that run's per-node status, timings, row counts
├── target/
│   ├── manifest.json     # the compiled graph, from the last pz compile
│   └── plan.json         # the per-node execution strategy, from the last plan or run
└── packages/             # restored non-builtin connectors
```

## Why it matters

An [incremental](/concepts/incremental-loads/) source only extracts new rows because `pz`
remembers where the last run stopped. A [check](/concepts/checks/) failure is diagnosable after
the fact because that run's result is still on disk. Losing this directory doesn't corrupt
anything, but it does cost you: the next run re-extracts everything from the beginning.

## How it works

### Watermarks and sync state

A **watermark** is the highest incremental cursor value a source has already extracted, one
entry per entity. **Sync state** is the same idea for connectors that track position a different
way, such as CDC. Both live under `.pz/state/`, and both advance only after every downstream
write for that run has committed, never before.

### Inspecting and repairing state

`pz state` reads and edits this directly, so you never hand-edit the JSON files:

| Command | Does |
|---|---|
| `pz state show [key]` | List every stored watermark and sync state entry, or one entity's full run history with `<source>.<entity>`. |
| `pz state rollback <key> --to-run <id>` | Roll a watermark back to the value a named prior run advanced it to. Backward only. |
| `pz state set <key> --value <v>` | Set an existing entry's value directly, in either direction. |
| `pz state clear <key>` | Remove an entry entirely, so the next run extracts that entity in full. |

Every write through `pz state` appends a line to `.pz/state/audit.jsonl` recording the old value,
the new one, and your `--reason`. `pz clean` never touches this file.

`pz cdc status` reports server-side change-capture health for every CDC entity in the project;
`pz cdc drop <target>` drops that server-side state and clears the matching sync-state entry, so
the next run re-snapshots from scratch.

### Run results and retention

Every run writes `run_results.json` incrementally as nodes finish, so a crash mid-run still
leaves a readable file. `pz retry` reads it to know what to redo. `retention:` in `project.yml`
reclaims disk automatically after each run:

```yaml
# project.yml
retention:
  keep_last: 10
```

This deletes `staging.duckdb` from every run past the newest 10, never `run_results.json`, so run
history and `pz retry` stay intact. `retention: off` disables the automatic sweep. `pz clean` does
the same sweep on demand, with its own default of keeping only the newest run; pass `--purge` to
delete a run's whole directory instead of just its staging database.

### State backends

By default, `.pz/state/` is a set of local JSON files. Two other backends move that state
elsewhere, set under `state:` in `project.yml`:

| Backend | Moves | Leaves local |
|---|---|---|
| `local` (default) | Nothing. `.pz/state/` and `.pz/runs/` hold everything. | Everything. |
| `sqlserver` | Watermarks, sync state, and (by default) run results; optionally the event stream. | `staging.duckdb` always stays local: it is a run's buffer, not state. |
| `http` | Watermarks and sync state only. | Run results and the event stream stay wherever they already are. |

The `local` backend needs no configuration. `sqlserver` and `http` exist for hosts with no
persistent disk, such as a container that disappears between scheduled runs. See
[Move state off the local disk](/how-to/remote-state/) for the full `state:` block, the
`PZ_STATE_*` environment variables, and a Container Apps recipe.

**`project.yml` always wins over its `PZ_STATE_*` environment counterpart.** The environment
supplies a default for a project that expresses no opinion; a project that pins its own backend
in `project.yml` stays reproducible wherever it runs, and the environment can never silently
redirect it elsewhere.

### What to commit to git

Commit `pz.lock.json`. It pins the exact version of every restored connector, so a checkout on
another machine restores the same code you validated against.

Never commit `.pz/`. It holds per-machine, per-run state: staging databases, watermarks tied to
that host's last extraction, restored connector packages, and run history. Every template `pz
init` scaffolds ships a `.gitignore` with `.pz/` already excluded.

## Related

- [How a run works](/concepts/how-a-run-works/): where `.pz/runs/<id>/` and `.pz/target/` get written during a run.
- [Incremental loads](/concepts/incremental-loads/): how watermarks and sync state get read and advanced.
- [Move state off the local disk](/how-to/remote-state/): the full `state:` block and the sqlserver and http backends in practice.
- [`project.yml` reference](/reference/project-yml/#state): every `state:` and `retention:` key.
- [Inspect and validate a project](/how-to/inspect-and-validate/): fixing a wrong watermark with `pz state`.
