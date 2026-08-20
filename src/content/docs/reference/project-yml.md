---
title: "`project.yml` reference"
description: "The exact key set for a project's project.yml. For the narrative walkthrough — what each block is for and how it fits with connections.yml and..."
---

The exact key set for a project's `project.yml`. For the narrative walkthrough — what each block
is *for* and how it fits with `connections.yml` and `pipelines/*.sql` — see
[Project structure](/concepts/project-structure/).

## Top-level keys

| Key | Meaning |
|---|---|
| `name` | The project's identity. Appears in `run_started`'s `projectName` field (see [Run events](/events/)) and, under a SQL state backend, in `pz.runs.project`. |
| `version` | The project's own version string. Not checked against anything; free text for the author's use. |
| `pz` | Engine version constraint (e.g. `">=1.0 <2.0"`). Reserved and accepted today; the load-time check against the running `pz` build is not implemented yet. |
| `connectors` | Non-builtin connector packages to restore — `package`/`version` pairs. One version per package per project is enforced at load time. |
| `vars` | Project variables, referenced in SQL via `{{ var('name') }}`. Overridable per invocation with `pz run --vars '{...}'`. |
| `engine` | Concurrency and DuckDB settings: `threads`, `batch_bytes`, `duckdb: { memory_limit, threads, temp_directory }`, plus per-connection `engine.breaker:` circuit-breaker settings. |
| `retention` | Automatic disk/store reclamation at the end of every run — see below. |
| `state` | Where watermarks, run results, and the run-event stream live — see below. |
| `on_source_drift` | Run-time schema drift policy for contract-less source datasets — see below. |

## `retention:`

```yaml
retention:
  keep_last: 10             # after each run, sweep older than the newest 10 runs
```

Defaults to `keep_last: 10` when the key is absent; `retention: off` disables the automatic
sweep entirely (manage disk with `pz clean` by hand instead). `keep_last` must be at least 1 —
the run that just finished is never swept. Under a SQL-backed `state.artifacts`, the sweep
deletes whole runs from the store rather than only `staging.duckdb` — see
[Move state off the local disk](/how-to/remote-state/#retention-and-pz-clean-under-a-remote-backend).

## `state:`

```yaml
state:
  backend: sqlserver        # local (default) | sqlserver | http
  connection: ops           # a connection name from connections.yml, connector: sqlserver
  schema: pz                # SQL schema name (default: pz)
  artifacts: true           # persist run results (default: true when backend is not local)
  events: false             # persist the run-event stream (default: false)
```

```yaml
state:
  backend: http             # watermarks and sync state over HTTP; everything else stays put
  url: https://state.example/api/agents/runs/<run-id>/state
```

| Key | Type | Default | `PZ_STATE_*` counterpart | Meaning |
|---|---|---|---|---|
| `backend` | `local` \| `sqlserver` \| `http` | `local` | `PZ_STATE_BACKEND` | Which store watermarks, sync state, and (per the other keys) run artifacts/events live in. An absent `state:` block is exactly `backend: local`. |
| `connection` | connection name | none | — (no `project.yml`-only environment path; see `PZ_STATE_CONNECTION_STRING`) | Names a `connections.yml` entry whose `connector:` is `sqlserver`. Its credential bag is reused verbatim — one place for secrets, the same env-interpolation and redaction rules as any other connection. |
| — | connection string | none | `PZ_STATE_CONNECTION_STRING` | A full SQL Server connection string supplied directly by the environment — no `connections.yml` entry needed. Has no `project.yml` spelling of its own; it exists specifically for a host-wide default (see the note on precedence below). |
| `schema` | string | `pz` | `PZ_STATE_SCHEMA` | The SQL schema `pz` creates its tables in. |
| `artifacts` | bool | `true` when `backend` is not `local`, else n/a | `PZ_STATE_ARTIFACTS` | Persist run results (`pz.runs`/`pz.run_nodes`) to the backend instead of `run_results.json`. |
| `events` | bool | `false` | `PZ_STATE_EVENTS` | Persist the NDJSON event stream to `pz.run_events`, in addition to stdout. Requires `artifacts: true` (`PZ0124`). |
| `url` | URL | none | `PZ_STATE_URL` | **`backend: http` only.** The run-scoped state endpoint a server issued for this run (`.../api/agents/runs/<run-id>/state`). Supplied whole — `pz` appends `/{scope}/{key}` and nothing else, because the run id in that path is the server's, not `pz`'s. Must be an absolute `http`/`https` URL (`PZ0125`). |
| — | bearer token | none | `PZ_STATE_TOKEN` | **`backend: http` only.** Sent as `Authorization: Bearer …` when set, omitted entirely when not. Has no `project.yml` spelling: it is a credential, and credentials do not belong in `project.yml` (writing `token:` there is `PZ0124`). |

Each backend accepts only its own keys. Declaring a key that belongs to a different backend is an
error (`PZ0124`) — leaving it in place would either be silently ignored (against the fail-loudly
house rule) or a bug in the config. `backend: local` accepts `backend` alone; `backend: sqlserver`
adds `connection`/`schema`/`artifacts`/`events`; `backend: http` adds `url` (plus `artifacts`/
`events`, which may only be `false` — see below).

Under `backend: http`, `pz` moves **watermarks and sync state only**. Run results and the event
stream stay where they already are, so `artifacts: true` or `events: true` is `PZ0124` rather than
a quiet downgrade — including when the value arrives from a host-wide `PZ_STATE_ARTIFACTS`.

`events: true` with `artifacts: false` is likewise refused (`PZ0124`), wherever each value came
from: without the `runs` header row that only `artifacts` writes, a truncated event stream has
nowhere to report `events_dropped`, and the run's `run_events` rows are never candidates for
retention or `pz clean` — they would grow without bound.

**Precedence: an explicit `project.yml` key always wins over its `PZ_STATE_*` counterpart.** The
environment variables supply *defaults* for a project that expresses no opinion — they can never
override a key the project actually set. This is what lets one container image configure a
host-wide state store for every project it hosts, while a project that pins its own backend
stays reproducible wherever it runs. Full detail, the DDL-rights requirement, and the Azure
Container Apps recipe are in [Move state off the local disk](/how-to/remote-state/).

## `on_source_drift:`

```yaml
on_source_drift: warn        # ignore (default) | warn | fail
```

Run-time policy for contract-less source datasets (no `columns:` under `entities: <e>: read:`).
After a SourceLoad materializes its staging table, `ignore` (the default) does nothing at all —
no `DESCRIBE`, no baseline, no event, byte-identical artifacts to a project with no key set.
`warn` and `fail` `DESCRIBE` the staged table, seed a baseline in the keyed state store's
`schemas` scope on first sighting, and on later runs diff the observed schema against it:
`warn` publishes a `source_drift_detected` event and continues (repeating on every later run
until accepted); `fail` fails the SourceLoad node with `PZ0331`, retaining its staged table for
`pz retry` reuse. `on_source_drift: banana` (anything but `ignore`/`warn`/`fail`) is `PZ0126`.
See [Detect schema drift at run time](/how-to/schema-drift/) for the full walkthrough,
including `pz schema accept`.

## Next steps

- [Project structure](/concepts/project-structure/) — the full file layout and the rest of
  `project.yml`'s narrative context.
- [Move state off the local disk](/how-to/remote-state/) — the operator's guide to the
  `state:` block.
- [Detect schema drift at run time](/how-to/schema-drift/) — the operator's guide to
  `on_source_drift:`.
- [CLI verbs and exit codes](/reference/cli/).
