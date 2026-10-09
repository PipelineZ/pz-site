---
title: "Observe runs with Azure Monitor"
description: "How to send pz's OpenTelemetry traces and metrics straight to Application Insights over OTLP/HTTP, with a token pz re-reads during the run, and alert on failed or missing runs."
sidebar:
  order: 14
---

`pz run`, `pz test`, and `pz retry` export OpenTelemetry traces and metrics over OTLP when a target is
configured. Application Insights accepts OTLP/HTTP directly when its OTLP ingestion is turned on, so pz
can export to it with no collector in between. This guide sets that up and alerts when a run fails or
never happens. Read it once you have a project running on a schedule.

```
pz (OTLP/HTTP, gzip, bearer token from a file) -> Azure Monitor OTLP ingestion -> Application Insights
```

## Prerequisites

- pz 0.9.1 or later, and connectors built on SDK 0.9.1 or later if you want their spans too (older
  connectors export nothing over HTTP).
- An Azure subscription where you can register providers and create resources, and the Azure CLI.
- A project already running on a schedule, for example following
  [Run on a schedule on Windows](/how-to/run-scheduled-on-windows/).

## Steps

1. **Register the preview feature and the providers** (once per subscription):

   ```console
   az feature register --namespace Microsoft.Insights --name OtlpApplicationInsights
   az provider register --namespace Microsoft.Insights
   az provider register --namespace Microsoft.Monitor
   az provider register --namespace Microsoft.AlertsManagement
   ```

   Wait until `az feature show --namespace Microsoft.Insights --name OtlpApplicationInsights` says
   `Registered`, then register `Microsoft.Insights` again so the feature takes effect.

2. **Create an Application Insights resource with OTLP ingestion on.** OTLP ingestion is set when the
   component is created (API version `2025-01-23-preview`) and cannot be turned off later:

   ```console
   az rest --method put \
     --url "https://management.azure.com/subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.Insights/components/<name>?api-version=2025-01-23-preview" \
     --body '{"location":"<region>","kind":"web","properties":{"Application_Type":"web","AzureMonitorWorkspaceIngestionMode":"Enabled"}}'
   ```

   Azure creates a managed resource group next to it holding a Log Analytics workspace, an Azure
   Monitor workspace, a data collection endpoint and a data collection rule.

3. **Read the two ingestion URLs** from the component:

   ```console
   az rest --method get --url "https://management.azure.com/subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.Insights/components/<name>?api-version=2025-01-23-preview" \
     --query "properties.{traces:OTLPTracesEndpoint, metrics:OTLPMetricsEndpoint, rule:DataCollectionRuleResourceId}"
   ```

   Each URL is complete (it ends in `/v1/traces` or `/v1/metrics`); pz uses it as-is.

4. **Let the identity that runs pz publish.** Grant it the **Monitoring Metrics Publisher** role on
   the data collection rule from step 3:

   ```console
   az role assignment create --assignee <principal-id> --role "Monitoring Metrics Publisher" --scope <rule>
   ```

5. **Give pz a token in a headers file.** Azure Monitor ingestion takes an Entra bearer token for
   `https://monitor.azure.com`. Write it to a file only the run's account can read, one `Name=value`
   line:

   ```console
   echo "Authorization=Bearer $(az account get-access-token --resource https://monitor.azure.com --query accessToken -o tsv)" > /run/pz/otel-headers
   chmod 600 /run/pz/otel-headers
   ```

   pz re-reads the file before every export, so whatever runs pz can refresh the token while a long
   run is going (tokens last about an hour). A missing or malformed file sends without it and prints
   one `note:`; the file's content is never printed.

6. **Point pz at Azure Monitor:**

   ```console
   pz run --otel-protocol http/protobuf \
     --otel-traces-endpoint "<traces URL>" \
     --otel-metrics-endpoint "<metrics URL>" \
     --otel-headers-file /run/pz/otel-headers
   ```

   Or set `PZ_OTEL_PROTOCOL`, `PZ_OTEL_TRACES_ENDPOINT`, `PZ_OTEL_METRICS_ENDPOINT` and
   `PZ_OTEL_HEADERS_FILE` in the scheduled task's environment. When any `--otel-*` flag is given, the
   `PZ_OTEL_*` variables are ignored. See [Environment variables](/reference/environment-variables/).

7. **Alert on failed runs.** Metrics land in the Azure Monitor workspace and are queried with PromQL.
   Start from `{__name__="pz.run.completed"}` to see the series and their labels, then create a
   Prometheus alert rule that fires when the count of runs whose status label is not `success`
   increases over your window.

8. **Alert on missing runs.** A crashed host or a hung run produces silence, not a `fatal` status, so
   also alert when `{__name__="pz.run.completed"}` has no increase over the window you expect a
   scheduled run in.

## Verify

Run the project by hand once with the flags above, then:

- In Application Insights > Logs, `union requests, dependencies | where timestamp > ago(1h)` lists the
  `run` span and its `node.<Kind>` children. Each span's `operation_Id` is the run's trace id, so
  `union requests, dependencies | where operation_Id == '<trace id>'` shows exactly one run.
- In the Azure Monitor workspace, `{__name__="pz.rows_moved"}` returns the run's rows.

## What arrives

- **Traces:** a `run` root span (service name `pz`) with per-node `node.<Kind>` child spans, in the
  classic `requests`/`dependencies` tables and in the workspace's `OTelSpans` table.
- **Metrics** (meter `Pz.Engine`, delta, with a base-2 exponential `pz.node.duration`): `pz.rows_moved`,
  `pz.bytes_moved`, `pz.batches`, `pz.node.duration` (label `pz.node.kind`), and `pz.run.completed`, a
  counter incremented once per run with label `pz.run.status` of `success`, `completed_with_failures`,
  or `fatal`. Every point carries `pz.run.id`, because Azure Monitor keeps no resource attributes on
  metrics other than the service name and instance.
- **External connector spans and metrics:** a `runtime: "process"` connector exports its own
  `pcp.<Rpc>` spans (service name `pz-connector`) nested under the engine's `node.<Kind>` span, in the
  same trace, using the same URLs and headers file. See
  [Author a connector](/how-to/author-a-connector/#telemetry).
- **A caller's trace:** when whatever starts pz sets `TRACEPARENT`, the `run` span is a child in that
  trace instead of a new root.

## Limits

- **1 MB per request.** Larger requests are refused (`413 ContentLengthLimitExceeded`) and that batch
  is dropped. pz gzips every body and sends at most 256 spans per request, which stays well under it.
- **Label values are lowercased** in the Azure Monitor workspace; compare against lowercase values.
- **The token expires.** A run that outlives the token in the file exports nothing after the expiry
  unless something rewrites the file.

## Troubleshooting

| If you see | Do |
|---|---|
| `note: telemetry headers file '...' could not be read` | The path is wrong or the run's account cannot read it. |
| No spans or metrics arrive, no note | Check the identity has Monitoring Metrics Publisher on the data collection rule, and that the token's resource is `https://monitor.azure.com`. |
| Spans arrive but connector spans do not | The connector predates SDK 0.9.1; rebuild it on 0.9.1 or later. |
| A gap in metrics between expected runs | Normal for schedule-driven workloads; pz emits no metrics between runs. |

## Related

- [Run on a schedule on Windows](/how-to/run-scheduled-on-windows/): the scheduled task the flags or variables go into.
- [Environment variables](/reference/environment-variables/): every variable pz reads, including the `PZ_OTEL_*` ones.
- [CLI reference](/reference/cli/#pz-run): the `--otel-*` flags.
- [Delivery guarantees](/concepts/delivery-guarantees/): what `completed_with_failures` and `fatal` mean for a run.
