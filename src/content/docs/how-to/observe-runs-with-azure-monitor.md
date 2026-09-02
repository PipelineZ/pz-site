---
title: "Observe runs with Azure Monitor"
description: "How to bridge pz's OpenTelemetry traces and metrics into Azure Monitor with an OpenTelemetry Collector, and alert on failed or missing runs."
sidebar:
  order: 14
---

`pz run`, `pz test`, and `pz retry` export OpenTelemetry traces and metrics over OTLP when an
endpoint is configured. This guide bridges that telemetry into Azure Monitor so you can see run
health in Application Insights and alert when a run fails or never happens. Read it once you have
a project running on a schedule.

## Prerequisites

- A project already running on a schedule, for example following
  [Run on a schedule on Windows](/how-to/run-scheduled-on-windows/).
- An Application Insights resource and its connection string.
- Azure Monitor does not ingest raw OTLP directly from arbitrary processes, so this guide runs an
  OpenTelemetry Collector on the host as the bridge:

  ```
  pz (OTLP, http://127.0.0.1:4317) -> otel collector -> Azure Monitor (Application Insights)
  ```

## Steps

1. **Install the collector on the host.** Download the latest `otelcol-contrib` release, the
   *contrib* distribution that carries the `azuremonitor` exporter, and install it as a service
   per its own README.

2. **Configure the collector** (`C:\otelcol\config.yaml`):

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
   Insights resource's connection string. The collector listens on loopback only, so nothing is
   exposed off the machine.

3. **Point pz at the collector.** Set the endpoint in the scheduled task's environment:

   ```console
   PZ_OTEL_ENDPOINT=http://127.0.0.1:4317
   ```

   With neither `--otel-endpoint` nor `PZ_OTEL_ENDPOINT` set, telemetry is a zero-cost no-op. See
   [Environment variables](/reference/environment-variables/).

4. **Create an alert on failed runs.** In Application Insights > Logs, save this query:

   ```kusto
   customMetrics
   | where name == "pz.run.completed"
   | extend status = tostring(customDimensions["pz.run.status"])
   | where status != "success"
   ```

   Create an alert rule on it, for example count > 0 over a 15-minute window evaluated every 5
   minutes, and route it to your action group.

5. **Add a second alert for missing runs.** A crashed host or a hung run produces silence, not a
   `fatal` status, so alert when `customMetrics | where name == "pz.run.completed"` returns zero
   rows over the window you expect a scheduled run in.

## Verify

Run the project by hand once with `PZ_OTEL_ENDPOINT` set, then check Application Insights for a
`run` root span with per-node `node.<Kind>` child spans, and a `pz.run.completed` metric with
`pz.run.status = success` in `customMetrics`.

## What arrives

- **Traces:** a `run` root span (service name `pz`) with per-node `node.<Kind>` child spans.
- **Metrics** (meter `Pz.Engine`): `pz.rows_moved`, `pz.bytes_moved`, `pz.batches`,
  `pz.node.duration` (tag `pz.node.kind`), and `pz.run.completed`, a counter incremented once per
  run with tag `pz.run.status` of `success`, `completed_with_failures`, or `fatal`.

In Application Insights these land in the `customMetrics` table, with dimension names under
`customDimensions`.

## Troubleshooting

| If you see | Do |
|---|---|
| No spans or metrics arrive at all | Confirm `PZ_OTEL_ENDPOINT` is set in the task's environment, not just your interactive shell; the OTLP exporter flushes on process exit, so even a short run should still deliver its final events. |
| A gap in metrics between expected runs | Normal for schedule-driven workloads. pz emits no metrics between runs. Design alerts around expected run windows, not a continuous signal. |
| The failed-run alert never fires | Check the `pz.run.status` values you're filtering against `success`; a `fatal` run and a `completed_with_failures` run both count. |

## Related

- [Run on a schedule on Windows](/how-to/run-scheduled-on-windows/): the scheduled task this guide's `PZ_OTEL_ENDPOINT` environment variable is set inside.
- [Environment variables](/reference/environment-variables/): every variable pz reads, including `PZ_OTEL_ENDPOINT`.
- [Run events](/reference/events/): the full NDJSON event contract, for logs beyond what traces and metrics carry.
- [Delivery guarantees](/concepts/delivery-guarantees/): what `completed_with_failures` and `fatal` mean for a run.
- [CLI reference](/reference/cli/#pz-run): the `--otel-endpoint` flag and its defaults.
