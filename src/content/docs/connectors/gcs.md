---
title: "Google Cloud Storage"
description: "Reference for the gcs connector: HMAC vs service-account/ADC auth, which mode reads and which only writes, connection and option keys, path templating, and declared capabilities."
sidebar:
  order: 14
---

The `gcs` connector reads and writes Google Cloud Storage. Its `auth` mode decides which data
plane a connection can reach. `auth: hmac` drives DuckDB's native `gs://` tier in both directions;
`auth: service_account` and `auth: adc` are OAuth-only, so DuckDB cannot use them, and those
connections carry writes only, over the universal-tier Google Cloud Storage SDK.

## Connection

```yaml title="connections.yml"
lake:
  connector: gcs
  auth: hmac
  root: my-bucket/exports
  key_id: ${GCS_HMAC_KEY_ID}
  secret: ${GCS_HMAC_SECRET}
```

| `auth` | Required keys | Reads | Writes |
|---|---|---|---|
| `hmac` | `key_id`, `secret` | Yes (native `gs://` scan) | Yes (native `COPY`) |
| `service_account` | `key_file` or `key_json` (exactly one) | No | Yes (universal-tier SDK) |
| `adc` | none extra | No | Yes (universal-tier SDK) |

| Key | Required | Default | Meaning |
|---|---|---|---|
| `auth` | Yes | — | `hmac`, `service_account`, or `adc`. |
| `root` | No | — | `bucket` or `bucket/prefix`. Fills the bucket and path prefix for every entity that omits its own. |
| `endpoint` | No | Real GCS | Override host. Under `hmac` this is a `host:port` DuckDB secret option (useful against MinIO-style interop endpoints); under `service_account`/`adc` it is a full base URL (useful against an emulator). |

`hmac` keys are GCS's [interoperability keys](https://cloud.google.com/storage/docs/authentication/hmackeys),
created under **Cloud Storage → Settings → Interoperability** for a service account with the
right role on the bucket. `auth: adc` needs no further fields: it resolves Application Default
Credentials from `gcloud auth application-default login`, `GOOGLE_APPLICATION_CREDENTIALS`, or the
metadata server on GCP compute.

A source opened on a `service_account`/`adc` connection is refused at open, naming `hmac` as the
fix: there is no universal read tier for this connector, so that is a refusal, not a fallback.

## Read options

Only reachable under `auth: hmac`. Shared keys (`columns`, `sync`, `retry` under `read:`, and
`rate_limit` on the connection) are documented in
[connections.yml reference](/reference/connections-yml/).

| Key | Meaning |
|---|---|
| `bucket` | Object bucket. Defaults to the connection's `root` bucket. |
| `path` | Object key, relative to the resolved prefix. Defaults to `<entity>.<format>`. Supports globs and calendar tokens (see below). |
| `format` | `csv`, `tsv`, `parquet`, or `json`. Defaults to `parquet`. |
| `columns` | Column-to-type contract. With no contract, csv/tsv/json auto-detect their schema. |
| `delimiter` | csv only, one ASCII character other than a quote, newline, or carriage return. Defaults to `,`. tsv is fixed to tab; setting `delimiter` on it is `PZ0362`. |
| `layout` | json only. `ndjson` (default, newline-delimited) or `array` (one top-level JSON array). Reads are `hmac`-only, so both layouts read natively here. |

```yaml title="connections.yml"
lake:
  connector: gcs
  auth: hmac
  root: my-bucket/exports
  key_id: ${GCS_HMAC_KEY_ID}
  secret: ${GCS_HMAC_SECRET}
  entities:
    events:
      read:
        path: raw/events/*.parquet
```

## Write options

| Key | Required | Default | Meaning |
|---|---|---|---|
| `bucket` | No | The connection's `root` bucket | Destination bucket. |
| `path` | No | `""` | Destination prefix, relative to the resolved root. |
| `format` | Yes | — | `csv`, `tsv`, `parquet`, or `json`. No default: every write must declare it. |
| `partition_by` | No | — | A single timestamp or date column. Fans rows out into one object per calendar folder. Only under `service_account`/`adc`; refused under `hmac`, since fan-out needs the SDK write tier. |
| `delimiter` | No | `,` | csv only, one ASCII character other than a quote, newline, or carriage return. tsv is fixed to tab; setting `delimiter` on it is `PZ0362`. |
| `layout` | No | `ndjson` | json only. `ndjson` (newline-delimited) or `array` (one top-level JSON array). `array` is native-only: it works under `hmac`'s native `COPY`, but the `service_account`/`adc` managed SDK writer refuses it with `PZ0361`. |

Only `strategy: append` and `strategy: replace` are supported; there is no `merge` for an object
store. `replace` writes one stable name (`<entity>.<format>`); `append` writes a run-unique,
guid-suffixed name. Under `service_account`/`adc`, a write commits as one atomic upload per
object: batches spool to a local temp file first, so an aborted or failed run never leaves a
partial object behind.

### Path templating

`path` accepts the calendar tokens `{yyyy}`, `{yy}`, `{MM}`, `{dd}`, `{HH}`, `{mm}`, coarse to fine
with no gaps. Under `hmac`, reads use them to narrow a windowed or incremental entity to the
watermark's cover. `partition_by` writes (SDK tier only) render one folder per row from its
timestamp value using the same tokens.

## Capabilities

| Flag | Meaning |
|---|---|
| `NativeScan` | Under `hmac`, reads compile to a native DuckDB scan. |
| `NativeCopy` | Under `hmac`, an unpartitioned write compiles to a native DuckDB `COPY`. |
| `ReplaceWrites` | Supports `strategy: replace`. |
| `BoundedWindow` | Honors an entity's upper watermark bound. |
| `PathTemplating` | Understands calendar tokens in `path`, for both read pruning and `partition_by` writes. |
| `GatedOperations` | SDK-tier writes route through `rate_limit` pacing. |

## Notes

- Forcing the universal tier on a read (`engine.force_universal`, or setting
  `files_per_partition`) fails with `PZ0312`: `hmac` reads have no universal path at all.
- Any other S3-compatible store, not just GCS, stays reachable through the `s3` connector's own
  `endpoint` override.

## Related

- [Connections.yml reference](/reference/connections-yml/) for the shared `read:`/`write:` keys.
- [Amazon S3](/connectors/s3/) and [Azure Blob Storage](/connectors/azureblob/) for the other
  object-store connectors.
- [Secure connection config](/how-to/secure-connection-config/) for keeping keys out of the
  repository.
- [Incremental loads](/concepts/incremental-loads/) for how the watermark window drives path
  templating.
