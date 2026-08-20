---
title: "Observe runs with Azure Monitor"
description: "Azure Monitor does not ingest raw OTLP directly from arbitrary processes, so run an OpenTelemetry Collector on the host as the bridge:"
---

`pz run` / `pz test` / `pz retry` export OpenTelemetry traces and metrics over OTLP when an
endpoint is configured — via `--otel-endpoint <url>` or the `PZ_OTEL_ENDPOINT` environment
variable. With neither set, telemetry is a zero-cost no-op.

Azure Monitor does not ingest raw OTLP directly from arbitrary processes, so run an
OpenTelemetry Collector on the host as the bridge:

```
pz (OTLP, http://127.0.0.1:4317) -> otel collector -> Azure Monitor (Application Insights)
```

## 1. Install the collector on the VM

Download the latest `otelcol-contrib` Windows release (the *contrib* distribution — it
carries the `azuremonitor` exporter) and install it as a Windows service per its README.

Collector config (`C:\otelcol\config.yaml`):

```yaml
receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 127.0.0.1:4317
exporters:
  azuremonitor:
    connection_string: "${env:APPLICATIONINSIGHTS_CONNECTION_STRING}"
service:
  pipelines:
    traces:
      receivers: [otlp]
      exporters: [azuremonitor]
    metrics:
      receivers: [otlp]
      exporters: [azuremonitor]
```

Set `APPLICATIONINSIGHTS_CONNECTION_STRING` for the collector service to your Application
Insights resource's connection string. The collector listens on loopback only — nothing
is exposed off-machine.

## 2. Point pz at it

Set the endpoint for the scheduled task's environment (see
[run scheduled on Windows](/how-to/run-scheduled-on-windows/)):

```console
PZ_OTEL_ENDPOINT=http://127.0.0.1:4317
```

## 3. What arrives

- Traces: a `run` root span with per-node `node.<Kind>` child spans (service name `pz`).
- Metrics (meter `Pz.Engine`): `pz.rows_moved`, `pz.bytes_moved`, `pz.batches`,
  `pz.node.duration` (tag `pz.node.kind`), and `pz.run.completed` — a counter incremented
  once per run with tag `pz.run.status` = `success` | `completed_with_failures` | `fatal`.

In Application Insights these land in the `customMetrics` table (dimension names under
`customDimensions`).

## 4. Alert on failed runs

Log-based alert query (Application Insights > Logs):

```kusto
customMetrics
| where name == "pz.run.completed"
| extend status = tostring(customDimensions["pz.run.status"])
| where status != "success"
```

Create an alert rule on this query (e.g. count > 0 over a 15-minute window, evaluated
every 5 minutes) and route it to your action group. A second, complementary alert catches
the run that never reported at all — alert when
`customMetrics | where name == "pz.run.completed"` returns **zero** rows over the window
you expect a scheduled run in (a missing-heartbeat alert): a crashed host or a hung run
produces silence, not a `fatal`.

## Caveats

- The OTLP exporter flushes on process exit (providers are disposed after the run
  summary), so short-lived CLI runs still deliver their final events.
- pz emits no metrics between runs; gaps are normal for schedule-driven workloads. Design
  alerts around "expected run windows", not continuous signal.
