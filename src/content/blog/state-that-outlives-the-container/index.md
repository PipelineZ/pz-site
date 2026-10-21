---
title: "State that outlives the container"
description: "A scheduled container starts with an empty disk, so every run is a first run. A state: block moves watermarks and run history into SQL Server or behind an HTTP endpoint, and the container can go back to forgetting everything."
date: 2026-11-01
heroImage:
  dark: ./hero-dark.svg
  light: ./hero-light.svg
  alt: "The words State that outlives the container, above a timeline of short-lived container boxes, the past ones faded to dashed outlines and the current one glowing yellow, each wired to the same persistent database."
---

A pz project that runs fine on a laptop gets packaged into a container image and scheduled to run
every hour. Each run starts in a fresh container, does its work, and the container is thrown away.
Nothing fails. But `.pz/` is created empty every time, so there's no watermark to read: every
incremental entity extracts its whole history, every hour, as if it had never run before. `pz
retry` finds no earlier run to retry, and `pz runs` has nothing to list.

pz keeps everything it remembers in that one directory, so the fix is to put the part that matters
somewhere that doesn't disappear with the container.

## What has to survive

Not everything under `.pz/` is worth keeping, and one part should never be kept:

| What | Where it lives by default | On an ephemeral host |
|---|---|---|
| Watermarks and sync state | `.pz/state/` | Must survive, or every run is a first run |
| Run results | `.pz/runs/<id>/run_results.json` | Should survive, for `pz retry` and `pz runs` |
| Event stream | stdout | Optional |
| Staging database | `.pz/runs/<id>/staging.duckdb` | Stays local: it's a run's buffer, not state |
| Manual-edit audit log | `.pz/state/audit.jsonl` | Always local, on every backend |

The `state:` block in `project.yml` moves the first three. There are two remote backends:
`sqlserver`, which holds everything pz knows how to persist, and `http`, which holds only
watermarks and sync state and needs no database credential at all.

## One block in project.yml

The `sqlserver` backend reuses a connection you already declare in `connections.yml`:

```yaml title="connections.yml"
ops:
  connector: sqlserver
  host: ${OPS_DB_HOST}
  database: pz_state
  user: ${OPS_DB_USER}
  password: ${OPS_DB_PASSWORD}
```

```yaml title="project.yml"
state:
  backend: sqlserver
  connection: ops
  schema: pz
```

`connection` has to name an entry whose `connector:` is `sqlserver`, or the project fails to load
with `PZ0125`. `schema` defaults to `pz`. Each backend only accepts its own keys, so a leftover
`schema:` under `backend: http` is `PZ0124` rather than being silently ignored.

pz creates its own tables on first use and never expects you to hand it a prebuilt schema, so the
account needs DDL rights on that database (`db_ddladmin`, or the equivalent `CREATE SCHEMA`,
`CREATE TABLE`, and `ALTER TABLE` permissions). `db_datareader` and `db_datawriter` alone aren't
enough. Every run then says where its state went:

```console
$ pz run --all
note: state backend: sqlserver (from project.yml)
```

## Or from the image's environment

A platform that runs many projects from one image doesn't want to edit every `project.yml`. Every
`state:` key has a `PZ_STATE_*` environment variable that supplies a default:

```console
$ export PZ_STATE_BACKEND=sqlserver
$ export PZ_STATE_CONNECTION_STRING="$OPS_DB_CONNECTION_STRING"
$ pz run --all
note: state backend: sqlserver (from PZ_STATE_BACKEND)
```

`PZ_STATE_CONNECTION_STRING` has no `project.yml` spelling on purpose: it's a credential, so it
only ever comes from the environment. If both are set, the named `state.connection` wins.

The rule that keeps this predictable is that **`project.yml` always wins over its environment
counterpart**. The environment fills in a default for a project that doesn't say anything about
state. It can never redirect a project that pins its own backend, so that project behaves the same
wherever it runs. The `note:` line names the source either way, `project.yml`, the variable's name,
or `default`, so when a run's state isn't where you expected, the first line of its output says
why.

## When the host shouldn't hold a database credential

Some hosts run code you'd rather not hand a database password to. `backend: http` turns it around:
whatever dispatches the run serves pz's state over HTTP, and pz reads and writes it through a URL
issued for that run:

```yaml title="project.yml"
state:
  backend: http
  url: https://state.example/api/agents/runs/<run-id>/state
```

`PZ_STATE_URL` can supply the URL instead, and `PZ_STATE_TOKEN`, when set, is sent as a bearer
token. A token headed for a plain `http://` URL that isn't a loopback address gets a `PZ0530`
warning. `timeout_seconds` (default `100`) bounds each request, and one that runs past it fails
with `PZ0518`.

The trade is scope. `http` holds watermarks and sync state only: run results stay in
`run_results.json` and events stay on stdout, so `artifacts` and `events` can only be `false` under
this backend.

## What the database holds

Under `sqlserver`, pz owns five tables in its schema: `schema_version`, `state`, `runs`,
`run_nodes`, and `run_events`. Two keys decide how much goes into them:

| Key | Default | What it stores |
|---|---|---|
| `artifacts` | `true` on a remote backend | Run results, in place of `run_results.json` |
| `events` | `false` | The NDJSON event stream, in addition to stdout. Requires `artifacts: true` |

With artifacts in the database, run history is no longer tied to the host that made it. `pz runs`
and `pz state show` work the same from a laptop as from the container, and `pz retry` in a brand
new container finds the failed run and selects the same nodes. What it can't do there is
[reuse the failed run's staged reads](/blog/retry-without-starting-over/): the staging database
died with the old container, so the retry re-extracts the failed nodes' sources. That's slower, but
no less correct.

## Two containers at once

Schedules overlap. A slow run is still going when the next one starts, or two flows on independent
schedules share a project. Runs that touch different datasets can run side by side on any backend.

What none of them allow is two runs advancing the same dataset's watermark at the same time. Each
run would write its own `MAX(cursor)`, and if the slower, older one landed last it would move the
watermark backwards without a word. Instead the later write loses an optimistic-concurrency check
and fails with `PZ0520`. If two runs really do need to cover the same dataset at once, split it so
each owns a disjoint slice.

## Upgrading without a migration step

A new pz release can change the state schema, and there's nothing to run by hand when it does. The
first newer build to connect takes an exclusive lock, migrates the schema forward in a single
transaction, and stamps the new version. A second process racing it waits on the lock, sees the
finished migration, and does nothing. A wait that runs past 30 seconds fails with `PZ0528` instead
of hanging behind a stuck migrator.

The other direction is refused. An older build that connects to a schema a newer one has already
migrated fails with `PZ0519` and writes nothing, because the newer build may already depend on
columns the older one doesn't know about. In practice: once one image on the new version has
touched a shared state store, roll the rest forward too.

## Try it

[Move state off the local disk](/how-to/remote-state/) walks both backends step by step, with a
troubleshooting table for every state error code. [State](/concepts/state/) covers the full `.pz/`
layout, retention, and `pz state` for inspecting and repairing watermarks, and
[Run in CI](/how-to/run-in-ci/) compares remote state with caching `.pz/state` between jobs. Every
key and variable is in the [`project.yml` reference](/reference/project-yml/#state) and
[Environment variables](/reference/environment-variables/#state-backend-variables).
