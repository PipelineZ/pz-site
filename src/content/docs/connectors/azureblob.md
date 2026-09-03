---
title: "Azure Blob Storage"
description: "Reference for the azureblob connector: the five auth modes, connection and option keys, path templating, partitioned writes, and declared capabilities for Azure Blob Storage and ADLS Gen2."
sidebar:
  order: 13
---

The `azureblob` connector reads and writes Azure Blob Storage and ADLS Gen2. Reads are
native-only: every read compiles to a DuckDB `read_parquet`/`read_csv`/`read_json` scan over the
`azure` extension. Writes go two ways: an unpartitioned write is a native `COPY`; a
`partition_by` write runs on the universal tier through the Azure Storage SDK.

## Connection

```yaml title="connections.yml"
lake:
  connector: azureblob
  auth: connection_string
  connection_string: ${AZURE_STORAGE_CONNECTION_STRING}
```

The `auth` mode picks which other keys are required.

| `auth` | Required keys | Meaning |
|---|---|---|
| `connection_string` | `connection_string` | The full Azure Storage connection string. |
| `account_key` | `account_name`, `account_key` | Storage account name plus its shared key. |
| `service_principal` | `account_name`, `tenant_id`, `client_id`, `client_secret` | Azure AD app registration credentials. |
| `credential_chain` | `account_name` | Azure's default credential chain (environment, managed identity, Azure CLI, in that order). |
| `managed_identity` | `account_name` | The identity of the host pz runs on. |

| Key | Required | Default | Meaning |
|---|---|---|---|
| `auth` | Yes | — | One of the five modes above. |
| `endpoint` | No | `https://{account_name}.blob.core.windows.net` | Override host, useful against Azurite or another emulator. |

## Read options

Shared keys (`columns`, `sync`, `retry` under `read:`, and `rate_limit` on the connection) are
documented in [connections.yml reference](/reference/connections-yml/).

| Key | Required | Default | Meaning |
|---|---|---|---|
| `scheme` | No | `az` | `az`, `azure`, or `abfss`. Picks blob-container listing (`az`/`azure`) or ADLS Gen2 directory listing (`abfss`). |
| `container` | Yes | — | Blob container (or ADLS filesystem) name. |
| `path` | Yes | — | Blob name or glob, relative to the container. Supports calendar tokens (see below). |
| `format` | No | `parquet` | `csv`, `parquet`, or `json`. |
| `columns` | Required for csv/json | — | Column-to-type contract. Parquet reads its schema from the file footer instead. |

```yaml title="connections.yml"
lake:
  connector: azureblob
  auth: connection_string
  connection_string: ${AZURE_STORAGE_CONNECTION_STRING}
  entities:
    events:
      read:
        container: raw
        path: events/{yyyy}/{MM}/{dd}/*.parquet
        sync:
          mode: incremental
          cursor: event_time
```

## Write options

| Key | Required | Default | Meaning |
|---|---|---|---|
| `container` | Yes | — | Destination container. |
| `path` | No | `""` | Destination prefix, relative to the container. Must carry calendar tokens if `partition_by` is set. |
| `format` | Yes | — | `csv`, `parquet`, or `json`. No default: every write must declare it. |
| `partition_by` | No | — | A single timestamp or date column. Fans rows out into one blob per calendar folder, rendered from `path`'s tokens. Universal tier only. |

Only `strategy: append` and `strategy: replace` are supported; there is no `merge` for a blob
store. `replace` writes one stable name (`<entity>.<format>`); `append` writes a run-unique,
guid-suffixed name so repeated runs accumulate blobs. Universal-tier parquet writes reject a
`decimal128` column.

### Path templating

`path` accepts the calendar tokens `{yyyy}`, `{yy}`, `{MM}`, `{dd}`, `{HH}`, `{mm}`, coarse to fine
with no gaps. On reads, they narrow a windowed or incremental entity to the watermark's cover
instead of listing the whole prefix. On writes, `partition_by` renders one folder per row from
its timestamp value using the same tokens; a `partition_by` output is refused unless `path`
carries matching tokens.

## Capabilities

| Flag | Meaning |
|---|---|
| `NativeScan` | Reads compile to a native DuckDB scan. |
| `NativeCopy` | An unpartitioned write compiles to a native DuckDB `COPY`. |
| `ReplaceWrites` | Supports `strategy: replace`. |
| `BoundedWindow` | Honors an entity's upper watermark bound. |
| `PathTemplating` | Understands calendar tokens in `path`, both for read pruning and `partition_by` writes. |
| `GatedOperations` | Universal-tier writes route through `rate_limit` pacing. |

## Notes

- Forcing the universal tier on a read (`engine.force_universal`, or setting
  `files_per_partition`) fails with `PZ0312`: reads have no universal path at all.
- A `partition_by` output declines the native `COPY` path even when the format would otherwise
  qualify, because a single `COPY` cannot fan out by row value.

## Related

- [Connections.yml reference](/reference/connections-yml/) for the shared `read:`/`write:` keys.
- [Amazon S3](/connectors/s3/) and [Google Cloud Storage](/connectors/gcs/) for the other
  object-store connectors.
- [Secure connection config](/how-to/secure-connection-config/) for keeping credentials out of the
  repository.
- [Incremental loads](/concepts/incremental-loads/) for how the watermark window drives path
  templating.
