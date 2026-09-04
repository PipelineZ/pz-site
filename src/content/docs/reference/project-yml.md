---
title: "project.yml"
description: "Every key project.yml accepts, its type, its default, and the error code it raises when malformed."
sidebar:
  order: 2
---

This page lists every key `project.yml` accepts: its type, its default, and what happens when
it is malformed. For what the file is for and how it fits with `connections.yml` and
`pipelines/*.sql`, see [Project layout](/concepts/project-layout/).

## Annotated sample

```yaml title="project.yml"
name: acme_orders
version: 0.4.0

# Engine-version constraint. Reserved; not checked against the running pz build yet.
pz: ">=1.0 <2.0"

# Non-builtin connector packages to restore. Builtin connectors need no entry.
connectors:
  - package: Some.Connector.Package
    version: 1.0.0

# Referenced in SQL via {{ var('min_amount') }}. Values may use ${VAR} interpolation.
vars:
  min_amount: 10
  statuses: [shipped, returned]

engine:
  threads: 4
  batch_bytes: 33554432
  force_universal: false
  check_samples: true
  duckdb:
    memory_limit: 4GiB
    threads: 4
    temp_directory: /tmp/pz-duckdb
  breaker:
    failure_threshold: 5
    cool_down: 2m

# After each run, delete staging.duckdb from all but the newest 10 runs.
retention:
  keep_last: 10

state:
  backend: local

on_source_drift: warn
```

## Top-level keys

An unrecognized top-level key is `PZ0101`, except a leftover dbt-style `outputs:` block, which
gets the targeted `PZ0347`.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `name` | string | required (`PZ0101`) | The project's identity. Appears in the `run_started` event's `projectName` field. |
| `version` | string | required (`PZ0101`) | The project's own version string. Free text; nothing checks it. |
| `pz` | string | none | Engine version constraint, e.g. `">=1.0 <2.0"`. Reserved and accepted; not enforced against the running build yet. |
| `connectors` | list of `{package, version}` | empty | Non-builtin connector packages `pz restore` resolves. Builtin connectors ([localfiles](/connectors/localfiles/), [postgres](/connectors/postgres/), [s3](/connectors/s3/), [sqlserver](/connectors/sqlserver/), [azureblob](/connectors/azureblob/), [gcs](/connectors/gcs/), [http](/connectors/http/), [mysql](/connectors/mysql/), [sqlite](/connectors/sqlite/), [duckdb](/connectors/duckdb/), [ducklake](/connectors/ducklake/), [motherduck](/connectors/motherduck/), [quack](/connectors/quack/), [iceberg](/connectors/iceberg/), [sftp](/connectors/sftp/)) need no entry. |
| `vars` | map of name to value | empty | Project variables, read in SQL via `{{ var('name') }}`. Overridable per invocation with `pz run --vars '{...}'`. Values may reference `${VAR}`. |
| `engine` | map | see below | Concurrency, batching, and DuckDB settings. |
| `retention` | map, or `off`/`false`/`no` | `keep_last: 10` | Automatic disk reclamation at the end of every run. |
| `state` | map | `backend: local` | Where watermarks, run results, and the run-event stream live. |
| `on_source_drift` | `ignore`\|`warn`\|`fail` | `ignore` | Run-time schema drift policy for contract-less source entities. |
| `feeds` | — | retired | Removed. Declaring it is `PZ0352`: feeds are host configuration (`PZ_FEEDS` or `pz restore --feeds`), not project authoring. |

## `engine:`

Every sub-key below is malformed-value errors as `PZ0120`, aggregated: a typo'd `threads:
banana` is refused, never silently defaulted.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `threads` | integer, >= 1 | `4` | How many nodes the dispatcher runs concurrently. |
| `batch_bytes` | integer, 1MiB–512MiB | `33554432` (32MiB) | Target size of one Arrow batch on the universal (non-native) execution path. |
| `force_universal` | bool | `false` | Force every entity through the universal batch path, skipping native scan/copy tiers. |
| `check_samples` | bool | `true` | Project-wide default for whether a failing check reports sample violating rows. |
| `duckdb.memory_limit` | string | DuckDB's own default | DuckDB's `memory_limit` setting, e.g. `4GiB`. |
| `duckdb.threads` | integer | DuckDB's own default | DuckDB's own thread pool size, independent of `engine.threads`. |
| `duckdb.temp_directory` | string | DuckDB's own default | Where DuckDB spills to disk under memory pressure. |
| `breaker.failure_threshold` | integer, 1–2147483647 | breaker disabled | Consecutive failures against one connection before its circuit breaker opens (`PZ0506`). Required if `breaker:` is present at all. |
| `breaker.cool_down` | duration | breaker disabled | How long the breaker stays open before allowing another attempt. Required if `breaker:` is present at all. |

`breaker:` is absent by default, meaning no circuit breaker runs. Declaring it requires both
`failure_threshold` and `cool_down` together; either one alone is `PZ0120`. The same
`failure_threshold`/`cool_down` pair applies to every connection's own breaker instance; there is
no per-connection override.

## `retention:`

```yaml
retention:
  keep_last: 10             # after each run, sweep older than the newest 10 runs
```

| Key | Type | Default | Meaning |
|---|---|---|---|
| `keep_last` | integer, >= 1 | `10` | Runs to keep after each automatic sweep. `0` is rejected (`PZ0123`): the run that just finished is never a candidate for deletion. |

Writing `retention: off` (also `false` or `no`, any case) disables the automatic sweep entirely;
manage disk with `pz clean` by hand instead. A scalar outside that off-set, or a map with a
missing or invalid `keep_last`, is `PZ0123`. Under a SQL-backed `state.artifacts`, the sweep
deletes whole runs from the store rather than only `staging.duckdb`. See
[Move state off the local disk](/how-to/remote-state/).

## `state:`

```yaml
state:
  backend: sqlserver        # local (default) | sqlserver | http
  connection: ops           # a connection name from connections.yml, connector: sqlserver
  schema: pz                # SQL schema name (default: pz)
  artifacts: true           # persist run results (default: true when backend is not local)
  events: false              # persist the run-event stream (default: false)
```

| Key | Type | Default | `PZ_STATE_*` counterpart | Meaning |
|---|---|---|---|---|
| `backend` | `local`\|`sqlserver`\|`http` | `local` | `PZ_STATE_BACKEND` | Which store watermarks, sync state, and (per the other keys) run artifacts/events live in. |
| `connection` | connection name | none | — | Names a `connections.yml` entry whose `connector:` is `sqlserver`. Its credential bag is reused verbatim. |
| — | connection string | none | `PZ_STATE_CONNECTION_STRING` | A full SQL Server connection string from the environment. No `project.yml` spelling: it is a credential. |
| `schema` | string | `pz` | `PZ_STATE_SCHEMA` | The SQL schema `pz` creates its tables in. |
| `artifacts` | bool | `true` when `backend` is not `local` | `PZ_STATE_ARTIFACTS` | Persist run results to the backend instead of `run_results.json`. |
| `events` | bool | `false` | `PZ_STATE_EVENTS` | Persist the NDJSON event stream to the backend, in addition to stdout. Requires `artifacts: true` (`PZ0124`). |
| `url` | URL | none | `PZ_STATE_URL` | `backend: http` only. The run-scoped state endpoint a server issued for this run. Must be an absolute `http`/`https` URL (`PZ0125`). |
| — | bearer token | none | `PZ_STATE_TOKEN` | `backend: http` only. Sent as `Authorization: Bearer …` when set. No `project.yml` spelling: it is a credential. |

Each backend accepts only its own keys; a key from a different backend is `PZ0124`.
`backend: local` accepts `backend` alone; `backend: sqlserver` adds `connection`/`schema`/
`artifacts`/`events`; `backend: http` adds `url` (plus `artifacts`/`events`, which may only be
`false`). An explicit `project.yml` key always wins over its `PZ_STATE_*` counterpart: the
environment supplies defaults for a project that expresses no opinion, never an override. Full
detail is in [Move state off the local disk](/how-to/remote-state/).

## `on_source_drift:`

```yaml
on_source_drift: warn        # ignore (default) | warn | fail
```

Run-time policy for contract-less source entities, those with no `columns:` under
`entities: <e>: read:`. `ignore` (the default) does nothing. `warn` and `fail` describe the
staged entity, seed a baseline on first sighting, and diff later runs against it: `warn`
publishes a `source_drift_detected` event and continues; `fail` fails the load node with
`PZ0331`. Any other value is `PZ0126`. See
[Detect schema drift at run time](/how-to/handle-schema-drift/), including `pz schema accept`.

## Errors

| Code | Meaning |
|---|---|
| [`PZ0101`](/reference/error-codes/) | Missing `name`/`version`, a malformed `connectors`/`vars`/`engine` shape, or an unrecognized top-level key. |
| [`PZ0102`](/reference/error-codes/) | `vars:` is not a mapping of name to value (also raised for a malformed `--vars` flag). |
| [`PZ0103`](/reference/error-codes/) | A `${VAR}` reference in `vars:` names a variable that is not set in the environment. |
| [`PZ0120`](/reference/error-codes/) | `engine:` or one of its sub-keys is malformed or out of bounds. |
| [`PZ0123`](/reference/error-codes/) | `retention:` is malformed: not `off` and not a map with a valid `keep_last`. |
| [`PZ0124`](/reference/error-codes/) | `state:` is malformed, names an unknown backend, or sets a key that backend does not accept. |
| [`PZ0125`](/reference/error-codes/) | `state.connection` names an entity that does not resolve to usable credentials. |
| [`PZ0126`](/reference/error-codes/) | `on_source_drift:` is not `ignore`, `warn`, or `fail`. |
| [`PZ0331`](/reference/error-codes/) | A source's observed schema drifted from its baseline under `on_source_drift: fail`. |
| [`PZ0347`](/reference/error-codes/) | A top-level `outputs:` block is present. That block is retired; declare each place as a connection in `connections.yml`. |
| [`PZ0352`](/reference/error-codes/) | A top-level `feeds:` key is present. Feeds are host configuration now, set via `PZ_FEEDS` or `pz restore --feeds`. |

## Related

- [Project layout](/concepts/project-layout/): where `project.yml` sits among the rest of the project's files.
- [connections.yml reference](/reference/connections-yml/): the file `project.yml`'s `connectors:` and `state.connection` point into.
- [Move state off the local disk](/how-to/remote-state/): the operator's guide to the `state:` block.
- [Detect schema drift at run time](/how-to/handle-schema-drift/): the operator's guide to `on_source_drift:`.
- [CLI reference](/reference/cli/): the verbs and flags that read `project.yml`.
