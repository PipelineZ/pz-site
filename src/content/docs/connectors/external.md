---
title: "Approved external connectors"
description: "Third-party connectors published and maintained by the PipelineZ org: what makes one 'approved', and the deltalake and snowflake connectors it covers today."
sidebar:
  order: 17
---

[Third-party connectors](/connectors/#third-party-connectors) are NuGet packages, and anyone can
publish one. This page lists the ones published and maintained by the PipelineZ org itself — held
to the same bar as a builtin, just shipped and versioned separately because their dependencies
(a Rust runtime, a proprietary driver) don't belong in the `pz` binary.

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
| [snowflake](https://github.com/PipelineZ/pz-connector-snowflake) | `Pz.Connector.Snowflake` | ✓ | ✓ | – | ✓ | – | ✓ |

## deltalake

Reads through DuckDB's `delta` extension, so rows never enter .NET on the read side. Writes —
`append`, `replace`, `merge` — go through `delta-rs` instead, on the universal Arrow tier, since
DuckDB has no native Delta write path.

```yaml title="project.yml"
connectors:
  - package: Pz.Connector.DeltaLake
    version: 0.1.0
```

**Before you install it:** it's a 222 MB download — `DeltaLake.Net` ships every RID's Rust
libraries in one package, and `pz restore` prints nothing while fetching it. And only `linux-x64`
has actually been run against; `linux-arm64`, `osx-x64`, `osx-arm64`, and `win-x64` are shipped by
the underlying package but never exercised by this connector's own suite. See its
[README](https://github.com/PipelineZ/pz-connector-deltalake#readme) for the full platform table,
merge-cost numbers on a partitioned table, and what's proven per backend.

## snowflake

Runs entirely on the universal Arrow-stream tier, both directions — a typed reader on the read
side, a spool → PUT → COPY load on the write side. Key-pair (JWT) authentication only; there is no
password-auth surface.

```yaml title="project.yml"
connectors:
  - package: Pz.Connector.Snowflake
    version: 0.1.0
```

**Before you install it:** prefer a glibc Linux host over Alpine — the driver's documented Linux
support is glibc-based, and musl isn't officially validated even though the pinned package ships
musl-targeted assets. There's no regional-endpoint option for GCP-hosted accounts, either. See its
[README](https://github.com/PipelineZ/pz-connector-snowflake#readme) for connection keys, schema
policy, and type mapping.

## Related

- [Connector matrix](/connectors/): every builtin connector's capabilities, and how a third-party
  package gets restored.
- [Connectors](/concepts/connectors/): what a connector is, builtin versus third-party, isolation.
- [Author a connector](/how-to/author-a-connector/): the ABI and test suite every connector here
  implements.
