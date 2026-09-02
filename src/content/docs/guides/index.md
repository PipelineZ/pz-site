---
title: "How-to guides"
description: "Every task-oriented pz guide, grouped by job: ingesting data, keeping runs reliable, running in production, working with AI agents, and extending pz."
---

Each guide solves one task and shows how to verify the result. If you are new to pz, read the
[Quickstart](/quickstart/) first; the guides assume a project already exists.

## Ingest

- [Extract from an HTTP API](/how-to/extract-from-http-api/): paginated reads, cursors, and writing back to an endpoint.
- [Capture changes with CDC](/how-to/capture-changes-with-cdc/): read change feeds from SQL Server and PostgreSQL.
- [Backfill in slices](/how-to/backfill-in-slices/): load history in bounded windows without losing your place.

## Reliability

- [Run checks and retry](/how-to/run-checks-and-retry/): `pz test`, `pz retry`, and what a retry reuses.
- [Tune retries](/how-to/tune-retries/): attempts, backoff, and jitter per connection or per call.
- [Throttle a source](/how-to/throttle-a-source/): rate limits, concurrency caps, and the circuit breaker.
- [Guard against schema changes](/how-to/handle-schema-drift/): validate-time contracts and sink schema policy.
- [Detect source drift at run time](/how-to/schema-drift/): `on_source_drift` and `pz schema accept`.
- [Debug a failed run](/how-to/debug-a-failed-run/): read the event stream, run results, and staged tables.

## Production

- [Secure connection config](/how-to/secure-connection-config/): secrets through environment variables and managed identity.
- [Move state off the local disk](/how-to/remote-state/): SQL Server or HTTP state backends for containers.
- [Run in CI](/how-to/run-in-ci/): a GitHub Actions job that validates and runs a project.
- [Run on a schedule on Windows](/how-to/run-scheduled-on-windows/): Task Scheduler and the wrapper script.
- [Observe runs with Azure Monitor](/how-to/observe-runs-with-azure-monitor/): OpenTelemetry metrics and traces.
- [Inspect and validate](/how-to/inspect-and-validate/): `pz ls`, `pz plan`, and `pz validate --connect`.

## AI agents

- [Use pz with an AI agent](/how-to/use-with-an-ai-agent/): the MCP server and what an agent can do with it.

## Extend

- [Author a connector](/how-to/author-a-connector/): build, test, and package a connector.

## Related

- [Connectors](/connectors/): per-connector options when a guide points at one.
- [CLI reference](/reference/cli/): the flags the guides use.
