---
title: "Move state off the local disk"
description: "By default, a pz run keeps its watermarks, run results, and (optionally) its event stream on the local filesystem, under .pz/state/ and .pz/runs/. That is..."
---

By default, a `pz` run keeps its watermarks, run results, and (optionally) its event stream on
the local filesystem, under `.pz/state/` and `.pz/runs/`. That is fine on a long-lived VM. It is
not fine on an ephemeral host — Azure Container Apps being the motivating case — because the
machine is gone before the next scheduled run starts, and "where did we get to" goes with it.

This how-to covers moving that state into SQL Server: the `state:` block, the environment-variable
defaults an operator can set once for every project on a host, the permissions `pz` needs, a
Container Apps recipe, and what still stays local even after you do this.

There is a third backend, `http`, for the case where the host must not hold a database credential
at all — an HTTP service holds the state instead, and the run reaches it over the one endpoint it
already has. See [Watermarks over HTTP](#watermarks-over-http-backend-http) below.

## The `state:` block

```yaml
# project.yml
state:
  backend: sqlserver        # local (default) | sqlserver
  connection: ops           # a connection name from connections.yml, connector: sqlserver
  schema: pz                # SQL schema name (default: pz)
  artifacts: true           # persist run results (default: true when backend is not local)
  events: false             # persist the run-event stream (default: false)
```

| Key | Meaning | Default |
|---|---|---|
| `backend` | `local`, `sqlserver`, or `http` (see [Watermarks over HTTP](#watermarks-over-http-backend-http)). An absent `state:` block is exactly `backend: local`. | `local` |
| `connection` | Name of a `connections.yml` entry whose `connector:` is `sqlserver`. Credentials are read from that connection, the same way a pipeline's own sqlserver reads/writes are. | none |
| `schema` | The SQL schema `pz` creates its tables in. | `pz` |
| `artifacts` | Persist `run_results.json`'s data (run header + per-node results) to `pz.runs`/`pz.run_nodes` instead of the local file. | `true` when `backend` is not `local`, else n/a |
| `events` | Persist the NDJSON event stream to `pz.run_events` in addition to stdout. The only key that defaults to off — a large run publishes thousands of `node_progress` events, and watermarks/run-results are what correctness depends on, not the event stream. Requires `artifacts: true` (`PZ0124`): the run's header row is where a truncated stream reports `events_dropped`, and it is what makes the run's `run_events` rows retention candidates. | `false` |

Each backend accepts only its own keys. Under `backend: local` (or no `state:` block at all),
setting any of the others is an error (`PZ0124`) rather than silently ignored — a stray
`state.schema` under a local backend is almost certainly a mistake, not a no-op the author
intended. The same holds across backends: `schema` under `backend: http`, or `url` under
`backend: sqlserver`, is `PZ0124` too.

## `PZ_STATE_*` environment variables

A container image hosts many projects and shouldn't need an edit to every project's
`project.yml` to point them at the shared store. Every key above has an environment-variable
counterpart that supplies its **default**:

| Variable | Supplies |
|---|---|
| `PZ_STATE_BACKEND` | `state.backend` |
| `PZ_STATE_CONNECTION_STRING` | The SQL Server connection string directly — no `connections.yml` entry needed |
| `PZ_STATE_SCHEMA` | `state.schema` |
| `PZ_STATE_ARTIFACTS` | `state.artifacts` (`true`/`false`) |
| `PZ_STATE_EVENTS` | `state.events` (`true`/`false`) |
| `PZ_STATE_URL` | `state.url` — the run-scoped state endpoint, under `backend: http` |
| `PZ_STATE_TOKEN` | The bearer token for that endpoint. No `project.yml` spelling: it is a credential |

**Precedence: an explicit `state:` key in `project.yml` always wins over its environment
counterpart.** The environment supplies a default for projects that express no opinion; a
project that pins its own backend stays reproducible wherever it runs. There is deliberately no
way for the environment to override an explicit `project.yml` key — silently redirecting a
project's state away from where it says it lives is exactly the failure this precedence rule
prevents. If both `state.connection` and `PZ_STATE_CONNECTION_STRING` are present,
`state.connection` wins by the same rule.

An environment that sets `PZ_STATE_BACKEND=sqlserver` with no connection string anywhere (no
`PZ_STATE_CONNECTION_STRING`, no `state.connection`) is `PZ0125` at validation time — before the
first watermark write, not as a runtime surprise.

Because the effective backend can come from ambient environment rather than the project file
itself, `pz` prints where it came from — `project.yml`, an environment variable's name, or
`default` — on the run's opening console line and on `pz state show`'s header:

```console
$ pz run --all
note: state backend: sqlserver (from PZ_STATE_BACKEND)
```

## Watermarks over HTTP (`backend: http`)

`backend: sqlserver` needs a database credential on the host. When the run is dispatched by a larger
system — an agent on a worker box, a job runner — that is often exactly what you cannot give it: a
connection string to that system's database is far broader than the scoped token the agent already
carries, and it needs an inbound route to TCP 1433 that an outbound-only agent deliberately does not
have.

`backend: http` closes that gap. The dispatching system serves `pz`'s keyed state over HTTP itself,
and `pz` reads and writes it using the same endpoint and credential the agent already has:

```yaml
# project.yml — or, more usually, the agent sets PZ_STATE_URL and nothing changes in the project
state:
  backend: http
  url: https://state.example/api/agents/runs/<run-id>/state
```

**Scope: watermarks and sync state (including CDC positions) only.** Run results and the event
stream stay wherever they already live — `run_results.json` and stdout by default. `artifacts: true`
or `events: true` under this backend is `PZ0124`, not a silent downgrade.

**The URL is issued per run, not composed.** It carries the server's run id, which is what lets
the server resolve the project and environment on its side; `pz`'s own run id is a different
identifier. `pz` appends `/{scope}/{key}` and nothing else. A URL that is not absolute `http`/
`https` is `PZ0125` at load time.

**The token is optional.** When `PZ_STATE_TOKEN` is set, every request carries
`Authorization: Bearer …`; when it is not, the header is omitted. Servers that do not yet check
it are served correctly either way, and turning authentication on later is a server-side change.

Two failure modes are worth knowing apart:

- **`PZ0518`** — the endpoint could not be reached, or answered something the contract does not
  allow. A `404` lands here too, and deliberately so: an unknown run id in `PZ_STATE_URL` must not
  read as "no watermark stored", which would silently re-extract every source from the beginning.
  Only an explicit *empty* answer means "nothing stored yet".
- **`PZ0520`** — another writer advanced the same key while this run was executing. Under a server
  that serializes runs per project this should be unreachable; if you see it, two runs are sharing
  one project's state.

## `pz` needs DDL rights on the state database

`pz` creates and migrates its own schema — it is not handed a pre-built one. On first use
against a database it issues `CREATE SCHEMA`/`CREATE TABLE` and stamps a `schema_version` row; on
every later connection it compares versions and migrates forward inside one transaction. **Grant
the account `pz` connects as `db_ddladmin` (or equivalent CREATE SCHEMA/CREATE TABLE/ALTER TABLE
rights) on the target database**, not just `db_datareader`/`db_datawriter`. Locked-down enterprise
SQL Server installations will care about this — say so up front when requesting the account.

If that account cannot reach the server at all, `pz` fails with **PZ0518** (`StateStoreUnavailable`).
If it *can* connect but the DDL is refused (or a migration fails partway for any other reason), that
surfaces as **PZ0519** (`StateSchemaVersionMismatch`) instead — the connection succeeded, so it is
never reported as "can't reach the store." Don't chase network/firewall issues on a PZ0519; check
the account's DDL rights on that schema first.

A newer schema than the connected build understands is also PZ0519 — a newer `pz` elsewhere may
already depend on columns this build does not know about, and guessing would be worse than
failing loud. Upgrade `pz`, or point `state.connection` at a store this build actually created.

## The Azure Container Apps recipe

This is the motivating deployment: a container image with no writable persistent disk, running
on a schedule. The connection string comes in as an environment variable bound to a Container
Apps secret — there is no file to mount, and none is needed.

1. Store the SQL Server connection string as a Container Apps secret:

   ```bash
   az containerapp secret set \
     --name pz-scheduled-job --resource-group rg-pz \
     --secrets pz-state-cxn="Server=tcp:my-server.database.windows.net;Database=pzstate;Authentication=Active Directory Managed Identity;"
   ```

2. Bind the secret to `PZ_STATE_CONNECTION_STRING` on the container (Bicep/ARM snippet — the same
   shape applies via `az containerapp update --set-env-vars` or the portal):

   ```json
   {
     "env": [
       { "name": "PZ_STATE_BACKEND", "value": "sqlserver" },
       { "name": "PZ_STATE_CONNECTION_STRING", "secretRef": "pz-state-cxn" }
     ]
   }
   ```

3. Grant the container app's managed identity `db_ddladmin` on the state database (see above),
   and leave every project's own `project.yml` free of a `state:` block. Every job scheduled on
   this image now shares one state store without a per-project edit — a project only needs its
   own `state:` block if it wants to pin a *different* store than the host-wide default, or
   override `schema`/`artifacts`/`events` for itself.

No secret ever touches disk in this recipe: the Container Apps platform injects it directly into
the process environment at container start, and `pz` never logs connection strings or SQL text
(the same secret-hygiene rule that already applies to `connections.yml`).

## What still does not survive an ephemeral host

Moving watermarks, run results, and events into SQL Server does not move `staging.duckdb` — it
stays on local disk by design, because it is the run's buffer manager, not state. It dies with
the node exactly as before.

`pz retry` itself works normally: it selects the failed and skipped nodes out of whichever artifact
store `state.artifacts` resolved to, so under a remote backend it reads the prior run from
`pz.runs`/`pz.run_nodes` — including on a host that never saw that run.

What cannot engage on a fresh host is retry's staged-data *reuse*, since there is no staged data
left to reuse. The existing fallback — re-extract the failed nodes, with a note — covers it.
Because the advancement-time provenance gate only counts a carried-forward sink when its
`SourceLoad` landed as `reused`, a retry on a new host correctly re-runs the extraction before
advancing any watermark. The result is the same as a retry on the original host, just slower: no
correctness is lost, only the reuse optimization.

## Retention and `pz clean` under a remote backend

`retention:` (`keep_last: 10` by default) and `pz clean` both sweep whichever store
`state.artifacts` resolved to. Under `backend: local` this is unchanged: only `staging.duckdb` is
deleted unless `--purge` asks for the whole run directory.

**Under a remote backend, a swept run is always deleted whole — the equivalent of `--purge` —
regardless of whether `--purge` was passed.** A SQL-backed run candidate has no `staging.duckdb`
to delete a "part" of; if the sweep only ever deleted staging files, a remote project's
`pz.runs`/`pz.run_nodes`/`pz.run_events` rows would never be reclaimed at all and would grow
without bound. `--keep-last`/`--older-than` still choose *which* runs are candidates the same way
they do locally; only the *depth* of deletion for a chosen candidate is forced to whole-run under
a remote backend.

"Whole" includes the run's **local** `.pz/runs/<id>/` directory. Moving artifacts into SQL Server
does not move `staging.duckdb` (see above), so that directory still appears on every run — under a
remote backend it holds nothing else, which is why deleting it and deleting the staging database
are the same act. A sweep therefore reclaims real disk, and reports the real byte count; only the
rows removed alongside it contribute nothing to that total, because a row count is not a byte
count. Local directories the store no longer has rows for are swept on the same pass, so a run
whose rows were reclaimed earlier cannot strand its staging database on disk. A run directory a
live process owns is never touched, on either backend.

`.pz/state/audit.jsonl` (the record of manual `pz state` edits) always stays local and is never
touched by retention or `pz clean`, on any backend — it is deliberately a different kind of record
from "what is the current state" (see [Inspect and validate a project](/how-to/inspect-and-validate/)).

## `pz state show`/`set`/`rollback`/`clear` under a remote backend

Under `backend: local`, every `pz state` subcommand is still free: `project.yml`'s own `state:` key
is the only thing read — no pipeline validation, no `connections.yml`, no connectors, no network.
That matters because the occasion for reaching for these verbs is usually that something is
already broken, and a project that no longer validates must not also stop you inspecting
watermarks. `pz clean` behaves the same way, for the same reason.

Under a remote backend, all four additionally read `connections.yml` — only when
`state.connection` names an entry there — and do real network I/O to reach the store, so they can
fail with **PZ0518** (unreachable) or **PZ0519** (schema mismatch) — failure modes that don't
apply under a local backend, where only local file I/O can fail. Reads still never mutate
anything, on either backend — that guarantee is unconditional.

`pz cdc status` and `pz cdc drop` follow the same rule: sync-state is read from, and cleared in,
whichever store `state:` resolved to — the one the next run actually reads, so a drop under a
remote backend really does force the re-snapshot it promises. (Both verbs load the full project
either way; unlike `pz state`/`pz clean` they always needed `connections.yml` and the connector
registry to reach the server-side change-capture state.)

## Errors you may see

| Code | Raised when |
|---|---|
| `PZ0124` | `state:` is malformed, names an unknown backend, sets keys belonging to a different backend (including `token:`, which is a credential and has no `project.yml` spelling), combines `events: true` with `artifacts: false`, or asks for `artifacts`/`events` under `backend: http` (wherever each value came from — `project.yml` or its `PZ_STATE_*` counterpart). |
| `PZ0125` | `state.connection` names a connection that doesn't exist or isn't `connector: sqlserver`; a `sqlserver` backend has no credentials from either path; or a `http` backend has no `state.url`/`PZ_STATE_URL`, or one that isn't an absolute http(s) URL. |
| `PZ0518` | The state database can't be reached, or authentication fails. Under `backend: http`, also an endpoint that answered something the contract does not allow — a `404` included, so a wrong run id never reads as "no watermark stored". Never carries the credential. |
| `PZ0519` | The store's schema is newer than this build understands, or a migration/DDL failed partway — check DDL rights first. |
| `PZ0520` | A keyed-state write (a watermark or sync-state advance) lost its optimistic-concurrency check — another run advanced the same dataset concurrently. This is the mechanism that makes concurrent replicas on the same store safe without a distributed lock; seeing it means two runs raced, not that the store is broken. |

See also: [project.yml reference](/reference/project-yml/) for every key, and
[Run events](/events/) for what `state.events: true` persists.
