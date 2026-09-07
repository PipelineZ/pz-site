---
title: "Approved external connectors"
description: "Third-party connectors published and maintained by the PipelineZ org: what makes one 'approved', and the deltalake, kafka, and snowflake connectors it covers today."
sidebar:
  order: 17
---

[Third-party connectors](/connectors/#third-party-connectors) are NuGet packages, and anyone can
publish one. This page lists the ones published and maintained by the PipelineZ org itself — held
to the same bar as a builtin, just shipped and versioned separately because their dependencies
(a Rust runtime, a proprietary driver) don't belong in the `pz` binary.

All three are built on [`Pz.Connectors.Sdk`](/how-to/author-a-connector/) and ship a
`runtime: "process"` manifest: pz spawns the self-contained binary the package carries for your
platform and talks to it over PCP, so each needs **pz 0.5.1 or newer**. Releases of deltalake and
snowflake before 0.2.0 were in-process packages, which `PZ0360` refuses; pin 0.2.0 or later.

## What "approved" means here

Every connector on this page:

- lives in a `pz-connector-*` repo under the [PipelineZ GitHub org](https://github.com/PipelineZ),
  not a community fork;
- ships a versioned `pz.connector.json` manifest and runs the same
  [`Pz.Connectors.TestKit`](/how-to/author-a-connector/) acceptance suite every builtin connector
  runs against;
- states plainly what is proven and what isn't — which backends its own test suite has actually
  talked to, and which are merely shipped. Read that connector's own README before depending on a
  path it hasn't tested.

Approved is not a guarantee of production hardening beyond what its own README claims. Check each
connector's stated platform and backend coverage before you rely on it.

## Capability matrix

Same columns as the [builtin matrix](/connectors/#capability-matrix): "Native DuckDB tier" means at
least one direction hands DuckDB a native scan or copy instead of streaming through Arrow.

| Connector | Package | Read | Write | Native DuckDB tier | Incremental | CDC | Merge |
|---|---|---|---|---|---|---|---|
| [deltalake](https://github.com/PipelineZ/pz-connector-deltalake) | `Pz.Connector.DeltaLake` | ✓ | ✓ | ✓ (read only) | ✓ | – | ✓ |
| [kafka](https://github.com/PipelineZ/pz-connector-kafka) | `Pz.Connector.Kafka` | ✓ | ✓ | – | ✓ | – | – |
| [snowflake](https://github.com/PipelineZ/pz-connector-snowflake) | `Pz.Connector.Snowflake` | ✓ | ✓ | – | ✓ | – | ✓ |

## deltalake

Reads through DuckDB's `delta` extension, so rows never enter .NET on the read side. Writes —
`append`, `replace`, `merge` — go through `delta-rs` instead, on the universal Arrow tier, since
DuckDB has no native Delta write path.

```yaml title="project.yml"
connectors:
  - package: Pz.Connector.DeltaLake
    version: 0.2.0
```

**Before you install it:** it's a 200 MB download — the package ships a Native AOT binary plus
delta-rs's two Rust libraries for each of four platforms, and `pz restore` fetches the whole nupkg
(printing nothing while it does) before materializing only your platform's 150 MB, 138 MB of which
is the Rust pair. And only
`linux-x64` has actually been run against; `linux-arm64`, `osx-arm64`, and `win-x64` are shipped
but never exercised by this connector's own suite, and `osx-x64` is not shipped. See its
[README](https://github.com/PipelineZ/pz-connector-deltalake#readme) for the full platform table,
merge-cost numbers on a partitioned table, and what's proven per backend.

## kafka

Reads as an offset-resumed feed source: each partition is bounded at its high watermark as of the
run's start, and the stored offset token picks up from there on the next run. Rows land in a fixed
text envelope — `topic, partition, offset, timestamp, key, value, headers` — with `key` and `value`
as text and `headers` as a JSON object. The sink is append-only produce: whole-row JSON by default,
or a verbatim `value:` column, with optional `key:`/`headers:` columns; the producer is idempotent,
giving at-least-once delivery across runs.

```yaml title="project.yml"
connectors:
  - package: Pz.Connector.Kafka
    version: 0.1.1
```

**Before you install it:** there's no Schema Registry / Avro / Protobuf decoding — `value` arrives
as text, so decode Avro or Protobuf payloads in SQL after landing. A feed source paired with an
`append` output needs `duplicates: accept` (incremental → append is otherwise a compile error,
PZ0214). A stored offset that retention has already dropped fails the run rather than silently
skipping ahead — recover with `--full-refresh` or by clearing the offset through `pz state`. The
package is self-contained rather than Native AOT, since the Kafka client library has no AOT
support; it ships `linux-x64`, `linux-arm64`, `osx-arm64`, and `win-x64`, but only `linux-x64` has
actually been exercised by its own CI. See its
[README](https://github.com/PipelineZ/pz-connector-kafka#readme) for the full platform table and
what's proven per backend.

## snowflake

Runs entirely on the universal Arrow-stream tier, both directions — a typed reader on the read
side, a spool → PUT → COPY load on the write side. Key-pair (JWT) authentication only; there is no
password-auth surface.

```yaml title="project.yml"
connectors:
  - package: Pz.Connector.Snowflake
    version: 0.2.0
```

**Before you install it:** prefer a glibc Linux host over Alpine — the driver's documented Linux
support is glibc-based, and the self-contained binary is glibc-linked. There's no regional-endpoint
option for GCP-hosted accounts, either. The package is self-contained rather than Native AOT, since
`Snowflake.Data` binds through reflection; it ships `linux-x64`, `linux-arm64`, `osx-arm64`, and
`win-x64` as a 203 MB download of which only your platform's ~55 MB is materialized, and only
`linux-x64` has been exercised through pz end to end. A relative `private_key_path` resolves
against the project directory (the manifest declares a project-directory anchor). See its
[README](https://github.com/PipelineZ/pz-connector-snowflake#readme) for connection keys, schema
policy, and type mapping.

## Related

- [Connector matrix](/connectors/): every builtin connector's capabilities, and how a third-party
  package gets restored.
- [Connectors](/concepts/connectors/): what a connector is, builtin versus third-party, isolation.
- [Author a connector](/how-to/author-a-connector/): the ABI and test suite every connector here
  implements.
