---
title: "Environment variables"
description: "Every environment variable pz reads, what it controls, its default, and which project.yml key overrides it."
sidebar:
  order: 7
---

This page lists every environment variable the `pz` command reads. Variables your own
`connections.yml` references through `${NAME}` are not listed here; see
[connections.yml](/reference/connections-yml/).

## Variables pz reads

| Variable | Default | Effect |
|---|---|---|
| `PZ_CACHE_DIR` | `~/.pz/cache` | Where `pz restore` stores downloaded connector packages. |
| `PZ_FEEDS` | `https://api.nuget.org/v3/index.json` | NuGet feeds `pz restore` resolves connector packages from. Separate several with `;`. The `--feeds` flag wins over the variable. |
| `PZ_OTEL_ENDPOINT` | unset | OpenTelemetry collector endpoint for `pz run`, `pz test`, and `pz retry`. The `--otel-endpoint` flag wins over the variable. |
| `PZ_DOCS_URL` | `https://pipelinez.dev` | Base URL the `pz mcp` server reads `llms.txt` from. Set it to serve documentation from a mirror. |
| `CI` | unset | When set to any value, pz renders plain non-interactive output. Redirected output has the same effect. |

## State backend variables

These supply **defaults** for the `state:` block in `project.yml`. A key the project sets always
wins over its variable. That lets one container image configure a host-wide state store while a
project that pins its own backend stays reproducible.

| Variable | `project.yml` key | Meaning |
|---|---|---|
| `PZ_STATE_BACKEND` | `state.backend` | `local`, `sqlserver`, or `http`. |
| `PZ_STATE_CONNECTION_STRING` | none | A full SQL Server connection string for `backend: sqlserver`. Has no `project.yml` spelling because it is a credential. |
| `PZ_STATE_SCHEMA` | `state.schema` | SQL schema for the state tables. Default `pz`. |
| `PZ_STATE_ARTIFACTS` | `state.artifacts` | Persist run results to the backend. |
| `PZ_STATE_EVENTS` | `state.events` | Persist the run-event stream to the backend. |
| `PZ_STATE_URL` | `state.url` | Run-scoped endpoint for `backend: http`. |
| `PZ_STATE_TOKEN` | none | Bearer token for `backend: http`. Has no `project.yml` spelling because it is a credential. |

The combination rules, such as `events` requiring `artifacts`, are in the
[project.yml reference](/reference/project-yml/#state).

## Variables passed to out-of-process connectors

A third-party connector runs in its own process. pz starts that process with an **empty**
environment and copies only these variables from its own:

```text
PATH HOME TMPDIR LANG LC_ALL
http_proxy https_proxy no_proxy HTTP_PROXY HTTPS_PROXY NO_PROXY
```

Nothing else crosses, including every `PZ_*` variable and any secret. A connector receives its
configuration through the protocol, never through the environment.

## Secrets in connections.yml

`connections.yml` may reference any variable with `${NAME}`. pz substitutes the value at load
time and fails with `PZ0103` when the variable is unset. Values are redacted from logs and
artifacts. See [Secure connection config](/how-to/secure-connection-config/).

## Related

- [project.yml reference](/reference/project-yml/): the keys these variables default.
- [Move state off the local disk](/how-to/remote-state/): using the state variables in a container.
- [Error codes](/reference/error-codes/): what `PZ0103` and its neighbours mean.
