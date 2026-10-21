---
title: "Where did the time go?"
description: "A run that succeeded but took twice as long is still a question. pz records every run down to the phase, the node, the stage and the remote calls behind it, streams it as JSON, and exports it as OpenTelemetry traces and metrics."
date: 2026-10-27
heroImage:
  dark: ./hero-dark.svg
  light: ./hero-light.svg
  alt: "The words Where did the time go?, next to a trace waterfall of grey span bars where one long bar glows yellow, with a dotted line dropping from its end to the matching stretch of a time axis below."
---

The nightly job took 22 minutes yesterday. Today it took 49, and it succeeded. Nothing failed, so
there's no error to read, and "it got slower" is the whole bug report. Was it the source? The
staging query? The warehouse write? Something before any data moved at all?

Guessing means re-running the job with extra logging and hoping it's slow again. pz records the
answer on every run instead, at four levels of detail: which phase, which node, which stage of that
node, and what the remote system on the other end was doing. All of it lands in a file on disk,
the same figures stream as JSON while the run is going, and with OpenTelemetry on they arrive in
whatever tracing and metrics backend you already use.

## Phase, then node, then stage

Every run writes `.pz/runs/<run-id>/run_results.json`, incrementally as nodes finish, so it's
readable even after a crash. Since 0.10.0 it holds enough timing to narrow a slow run down in three
steps, without running anything again.

**Which phase.** A top-level `phases` object records the milliseconds each phase took: `loadMs`,
`compileMs`, `validateMs`, `restoreCheckMs`, `planMs`, `executeMs`, `finalizeMs`. If `executeMs`
didn't move, the extra 27 minutes went somewhere before or after the data, and no node is to blame.
[What happens when you run pz](/blog/what-happens-when-you-run-pz/) covers what each phase does.

**Which node.** Each entry under `nodes` has its `durationMs`, plus the `connector` and
`connection` it went through, the data-plane tier that actually moved its data (`strategy`:
`native_scan`, `native_copy` or `arrow`), and `attempts`, how many times it ran. A node that took
three attempts is a different problem from a node that took one long one.

**Which stage.** `stages` splits a node into `extractMs`, `ingestMs`, `egressMs` and `writeMs`, with
the offset each one started at (`extractStartMs` and so on, from the node's start). A source load
that spent 48 minutes in `extractMs` is waiting on the source. A sink write that spent them in
`writeMs` is waiting on the destination.

`pz runs` lists past runs newest first, with their status and timing, so finding yesterday's run to
compare against is one command. It reads only `state:` from `project.yml`, so it keeps working even
when today's change broke the project.

## Which side was waiting

On the `arrow` tier, a source load's reader and its ingest run at the same time, connected by a
channel, so their stages overlap and don't add up to `durationMs`. What matters is which side sat
idle. Each node's `timings` records `producerStallMs` and `consumerStallMs`, measured around the one
batch-level wait each side already does, never per row.

When one side's stall covers at least 60% of the node's runtime, the console says so directly:

```console
$ pz run --all
ok src_bq__events 18730552 rows 2940113ms
hint: src_bq__events: source-bound — ingest idle 91% of the node's runtime
ok events_daily 412 rows 3120ms
ok warehouse.events_daily 412 rows 860ms
run 20261021T020011408Z-7d1e: 3 succeeded, 0 failed, 0 skipped (.pz/runs/20261021T020011408Z-7d1e/run_results.json)
```

| Hint | Node | Meaning |
|---|---|---|
| `source-bound` | Source load | Ingest sat idle waiting for the source to produce batches. |
| `ingest-bound` | Source load | The reader sat blocked waiting for staging to take its batches. |
| `staging-bound` | Sink write | The writer sat idle waiting for the staging query to produce rows. |
| `sink-bound` | Sink write | Staging sat idle waiting for the destination to accept rows. |

The hint is presentation only: it's computed from `timings` and `durationMs`, so anything reading
the file can work it out the same way.

## What the remote side did

"Source-bound" says the time went into BigQuery. It doesn't say why. Since 0.11.0 a connector can
report what it asked of its remote service, and pz records it on the node as `remote`:

| Field | Meaning |
|---|---|
| `requests` | Requests the connector made to the remote system. |
| `wireBytes` | Bytes moved over the wire, separate from the node's Arrow bytes. |
| `remoteMs` | Time spent waiting on the remote system, summed over requests. |
| `throttled` | Requests the remote system throttled. |
| `cost` | `{units, unit}` in the service's own billing unit: `bytes_billed`, `ru`, `dbu`, and so on. |
| `extras` | Up to eight connector-named figures, like `bigquery.slot_ms`. |

Here's the slow node from the run above:

```json
{
  "name": "src_bq__events",
  "durationMs": 2940113,
  "attempts": 1,
  "stages": { "extractMs": 2931870, "extractStartMs": 41, "ingestMs": 2936402, "ingestStartMs": 44 },
  "timings": { "producerStallMs": 11204, "consumerStallMs": 2675503 },
  "remote": {
    "requests": 412,
    "wireBytes": 9142338117,
    "remoteMs": 2810544,
    "throttled": 37,
    "cost": { "units": 412316882944, "unit": "bytes_billed" },
    "extras": { "bigquery.bytes_processed": 412316882944, "bigquery.slot_ms": 18440213 }
  }
}
```

37 of 412 requests were throttled, and the remote system accounts for almost all of the node's
runtime. That's now a specific question about the source, and the bill for it, not a vague one
about the pipeline.

`remote` is summed across every attempt and partition, and it's recorded on a failed node too, so
a node that kept getting throttled before it gave up shows the total it cost. Zero values are left
out, and so is the whole object when the connector reported nothing.

The first-party connectors outside the binary report it today, each with what its service can
actually tell it: BigQuery, ClickHouse and Cosmos DB report a cost unit, GitHub counts rate-limit
responses as throttles, Kafka reports librdkafka's request and byte counts. The
[connector telemetry table](/connectors/external/#telemetry) lists exactly what each one reports.
Read the numbers as lower bounds: retries inside a connector's own client library never reach the
counters.

## The same record, as it happens

`run_results.json` is the record after the fact. `--log-format json` writes the same facts to stdout
as they happen, one JSON object per line:

```console
$ pz run --all --log-format json | jq -c 'select(.event == "node_completed") | {name, status, durationMs, attempts}'
{"name":"src_bq__events","status":"success","durationMs":2940113,"attempts":1}
{"name":"events_daily","status":"success","durationMs":3120,"attempts":1}
{"name":"warehouse.events_daily","status":"success","durationMs":860,"attempts":1}
```

Every line carries `event`, `at` and `runId`, and `runId` matches the one in `run_results.json`.
`node_completed` carries everything above: `stages`, `timings`, `remote`, `strategy`, `attempts`.
`run_completed` carries the run's status, node counts and a `phases` object. Anything that schedules
pz can read this stream instead of parsing console text.

Fields on the stream are append-only. Renaming or removing one, or an `event` value, counts as a
breaking change, so a consumer written today keeps working, as long as it ignores fields it doesn't
recognize.

## Into the backend you already have

A file per run is fine for one job. For twenty jobs on a schedule, the numbers belong in a tracing
and metrics backend, with a dashboard and an alert. `pz run`, `pz test` and `pz retry` export
OpenTelemetry over OTLP once there's somewhere to send it:

```console
$ pz run --all --otel-endpoint http://otel-collector:4317
```

That's gRPC to a collector, the default. Since 0.9.1 pz also speaks OTLP over HTTP, so it can send
straight to a backend that accepts it, with no collector in between:

```console
$ pz run --all --otel-protocol http/protobuf \
    --otel-traces-endpoint "<traces URL>" \
    --otel-metrics-endpoint "<metrics URL>" \
    --otel-headers-file /run/pz/otel-headers
```

The headers file holds `Name=value` lines, typically `Authorization=Bearer <token>`. pz re-reads it
before every export, so whatever runs pz can refresh a token that expires mid-run, and its content
is never printed. Every flag has a `PZ_OTEL_*` variable for scheduled tasks, and when any `--otel-*`
flag is given, all the variables are ignored, so a half-set environment can't mix with the command
line.

**Traces.** Each run is one trace: a `run` root span with a `phase.<name>` child per phase and a
`node.<Kind>` child per node. The node spans carry the figures from `run_results.json` as attributes:
`pz.node.attempts`, `pz.node.rows`, `pz.stage.extract_ms` and the other stages, and since 0.11.0
`pz.remote.requests`, `pz.remote.throttled`, `pz.remote.cost` and the rest. An external connector's
own `pcp.*` and `remote.*` spans nest under the node that called it, in the same trace.

**Metrics.** `pz.rows_moved`, `pz.bytes_moved`, `pz.node.duration`, the `pz.remote.*` counters, and
`pz.run.completed`, a counter incremented once per run with a `pz.run.status` label of `success`,
`completed_with_failures` or `fatal`. Every point carries `pz.run.id`, so a spike on a graph leads
back to one run's file on disk.

`pz.run.completed` is the one to alert on, twice: when it increases with a status other than
`success`, and when it doesn't increase at all over the window a scheduled run should have
happened in. A crashed host or a hung run doesn't report `fatal`. It reports nothing, and only the
second alert catches that.

[Observe runs with Azure Monitor](/how-to/observe-runs-with-azure-monitor/) walks the whole setup for
Application Insights, which takes OTLP over HTTP directly: the token, the role assignment, and both
alerts.

## Part of a bigger trace

pz is rarely the whole story. A CI job, an orchestrator, or a service that kicks off a refresh
already has a trace of its own, and a pz run that starts a fresh one breaks the chain right where
the interesting part begins.

pz reads the W3C trace context from the environment. When whatever starts pz sets `TRACEPARENT`
(and optionally `TRACESTATE`), the `run` span becomes a child in that caller's trace instead of a
new root:

```console
$ TRACEPARENT=00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01 pz run --all
```

The caller's trace then shows its own work, pz's phases and nodes, and every connector's remote
calls, end to end. If the parent is unsampled (flags `00`), pz exports no spans for the run, the
same decision the caller made, but still exports metrics. An invalid value is ignored with a note,
not a failure.

## What never leaves the machine

Telemetry goes to a third-party backend, so pz is deliberate about what's in it. No span ever
carries SQL text, connection config, watermark values, sync tokens or CDC positions. A failed node's
span carries its error code, like `PZ0501`, and the exception type, but never the message or a stack
trace, because a connector's error message can echo the data values that caused it. The full
message stays in `run_results.json`, the JSON events and the console, on the machine that ran the
job.

Connector spans follow the same rule. A `remote.http` span carries the method, host, port and status
code, never a URL path, query string, header or error message.

## Try it

[Debug a failed run](/how-to/debug-a-failed-run/) walks the diagnostic ladder from the console
summary through `run_results.json` to the staged tables, and the
[run events reference](/reference/events/) lists every event and field. For the export side, see
[Observe runs with Azure Monitor](/how-to/observe-runs-with-azure-monitor/) and the `PZ_OTEL_*` and
`TRACEPARENT` entries in [Environment variables](/reference/environment-variables/). If you're
writing a connector, [Author a connector](/how-to/author-a-connector/#reporting-remote-stats) shows
how to report `remote` stats of your own.
