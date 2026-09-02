---
title: "Move state off the local disk"
description: "How to move a pz project's watermarks and run results into SQL Server or an HTTP endpoint for hosts with no persistent disk between runs."
sidebar:
  order: 11
---

By default, `pz` keeps watermarks, run results, and the event stream under `.pz/state/` and
`.pz/runs/` on the local filesystem. That breaks on an ephemeral host, such as a container that
disappears between scheduled runs, because the next run has no memory of where the last one
stopped. This guide moves that [state](/concepts/state/) into SQL Server or behind an HTTP
endpoint instead. Read it once a project needs to run somewhere with no durable disk.

## Prerequisites

- A `pz` project that already runs locally. Follow the [quickstart](/quickstart/) if you don't have one.
- For the `sqlserver` backend: a SQL Server database and an account with `db_ddladmin` rights on
  it, or equivalent `CREATE SCHEMA`/`CREATE TABLE`/`ALTER TABLE` permissions. `pz` creates and
  migrates its own schema; it is never handed a pre-built one.
- For the `http` backend: a service that implements the keyed state contract at a URL you control.

## Steps

1. **Add a `state:` block to `project.yml`**, naming the backend and, for `sqlserver`, a
   connection from `connections.yml`:

   ```yaml
   # project.yml
   state:
     backend: sqlserver
     connection: ops
     schema: pz
   ```

   `connection` must name a `connections.yml` entry whose `connector:` is `sqlserver`. Every
   `state:` key has an environment-variable default (`PZ_STATE_BACKEND`, `PZ_STATE_SCHEMA`, and
   so on), so a host can set these once for every project it runs instead of editing each
   project's file. An explicit `project.yml` key always wins over its environment counterpart.
   See [Environment variables](/reference/environment-variables/#state-backend-variables) for the
   full list.

2. **Or, for a host that must not hold a database credential, use `backend: http`** instead. The
   dispatching system serves `pz`'s keyed state over HTTP, and `pz` reads and writes it through
   the one endpoint the run already has:

   ```yaml
   # project.yml
   state:
     backend: http
     url: https://state.example/api/agents/runs/<run-id>/state
   ```

   `backend: http` covers watermarks and sync state only. Run results and the event stream stay
   local (`run_results.json` and stdout). Set `PZ_STATE_TOKEN` if the endpoint requires a bearer
   token; `pz` sends it only when the variable is set.

3. **Grant DDL rights on the target database**, under `backend: sqlserver`. `pz` issues
   `CREATE SCHEMA`/`CREATE TABLE` on first use and migrates forward on every later connection.
   `db_datareader`/`db_datawriter` alone is not enough.

4. **Run once, and confirm the backend that was actually used**:

   ```console
   $ pz run --all
   note: state backend: sqlserver (from project.yml)
   ```

   The opening line names where the effective backend came from: `project.yml`, an environment
   variable, or `default`. That matters because a container image can set `PZ_STATE_BACKEND` for
   every project it runs, so the source is not always the file you're looking at.

## Verify

Run `pz state show` from a second host, or after clearing `.pz/state/` locally, and confirm the
prior run's watermarks are still there:

```console
$ pz state show crm.orders
```

A populated result means the remote store, not the local filesystem, is now the system of record
for this project's state.

## What still stays local

Moving state into SQL Server or HTTP does not move `staging.duckdb`. It stays on local disk by
design, because it is a run's buffer, not state, and it dies with the run's node exactly as
before. `.pz/state/audit.jsonl`, the record of every manual `pz state` edit, also always stays
local and is never touched by retention or `pz clean`, on any backend.

`pz retry` still works from a fresh host: it reads the prior run from whichever store
`state.artifacts` resolved to. What it loses on a new host is reuse of previously staged data,
since no local staging file survives; it re-extracts the failed nodes instead, which is slower
but not incorrect.

## Troubleshooting

| If you see | Do |
|---|---|
| `PZ0124` | `state:` sets a key that belongs to a different backend, such as `schema` under `backend: http`. Check which keys each backend accepts in [State](/concepts/state/#state-backends). |
| `PZ0125` | `state.connection` names a connection that doesn't exist or isn't `connector: sqlserver`, or a backend is missing its required credential (`state.connection` or `PZ_STATE_CONNECTION_STRING` for `sqlserver`; `state.url` or `PZ_STATE_URL` for `http`). |
| `PZ0518` | The state database or HTTP endpoint can't be reached, or answered something the contract doesn't allow. Check network access and credentials before anything else. |
| `PZ0519` | The connection succeeded but the schema is newer than this build understands, or DDL was refused. Check the account's DDL rights on that schema first, not the network. |
| `PZ0520` | Two runs advanced the same watermark concurrently. Confirm nothing else is scheduled against the same project and state store at the same time. |

## Related

- [State](/concepts/state/): what pz remembers between runs, the `.pz/` layout, and the three state backends in full.
- [Environment variables](/reference/environment-variables/#state-backend-variables): every `PZ_STATE_*` variable and the `project.yml` key it defaults.
- [project.yml reference](/reference/project-yml/#state): the complete `state:` key table.
- [Run in CI](/how-to/run-in-ci/): pointing a CI job's ephemeral `.pz/` at a remote state store.
- [Error codes](/reference/error-codes/): what `PZ0124`, `PZ0125`, `PZ0518`, `PZ0519`, and `PZ0520` mean in full.
