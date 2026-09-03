---
title: "SFTP"
description: "Reference for the sftp connector: connection and auth keys, read and write options, path templating, partitioned writes, and declared capabilities for reading and writing files over SFTP."
sidebar:
  order: 14
---

The `sftp` connector reads and writes csv, parquet, and json files over SFTP. There is no native
DuckDB path for SFTP, so every read and write runs on the universal Arrow tier: SSH.NET streams
files through managed format readers and writers.

## Connection

```yaml title="connections.yml"
lake:
  connector: sftp
  host: sftp.example.com
  username: pz-service
  password: ${SFTP_PASSWORD}
  root: /exports
```

| Key | Required | Default | Meaning |
|---|---|---|---|
| `host` | Yes | — | SFTP server hostname. |
| `username` | Yes | — | Login user. |
| `password` | One of `password`/`private_key_path` | — | Password auth. Exclusive with `private_key_path`. |
| `private_key_path` | One of `password`/`private_key_path` | — | Private key file auth. Exclusive with `password`. |
| `private_key_passphrase` | No | — | Passphrase for `private_key_path`. Invalid without it. |
| `host_key_fingerprint` | No | — | SHA-256 host key pin (`SHA256:<base64>` or the bare base64 body), checked before authenticating. |
| `port` | No | `22` | SSH port, 1–65535. |
| `root` | No | — | Base directory every entity's `path` resolves under. |

## Read options

Shared keys (`columns`, `sync`, `retry` under `read:`, and `rate_limit` on the connection) are
documented in [connections.yml reference](/reference/connections-yml/).

| Key | Required | Default | Meaning |
|---|---|---|---|
| `path` | No | `<entity>.<format>` | Remote path or glob, relative to `root`. Supports calendar tokens (see below). |
| `format` | No | `csv` | `csv`, `parquet`, or `json`. |
| `columns` | Required for json | — | Column-to-type contract. json has no schema inference; csv without a contract reports every header column as `varchar`; parquet reads its footer. |
| `files_per_partition` | No | `1` | How many matched files load into each partition. |

```yaml title="connections.yml"
lake:
  connector: sftp
  host: sftp.example.com
  username: pz-service
  password: ${SFTP_PASSWORD}
  root: /exports
  entities:
    events:
      read:
        path: events/{yyyy}/{MM}/{dd}/*.csv
        format: csv
        sync:
          mode: incremental
          cursor: event_time
```

## Write options

| Key | Required | Default | Meaning |
|---|---|---|---|
| `format` | No | `parquet` | `csv`, `parquet`, or `json`. |
| `path` | No | `<entity>` | Destination directory, relative to `root`. Must carry calendar tokens if `partition_by` is set. |
| `partition_by` | No | — | A single timestamp or date column. Fans rows out into one file per calendar folder, rendered from `path`'s tokens. |

Only `strategy: append` and `strategy: replace` are supported; there is no `merge` for a file
store. `replace` writes one stable name (`<entity>.<format>`); `append` writes a run-unique,
guid-suffixed name so repeated runs accumulate files. Every write lands via a temp-file-then-rename
commit, so a failed or aborted write never leaves a partial file at the final path.

### Path templating

`path` accepts the calendar tokens `{yyyy}`, `{yy}`, `{MM}`, `{dd}`, `{HH}`, `{mm}`, coarse to fine
with no gaps. On reads, they narrow a windowed or incremental entity to the watermark's cover
before listing, instead of listing the whole directory tree. On writes, `partition_by` renders one
folder per row from its timestamp value using the same tokens.

## Capabilities

| Flag | Meaning |
|---|---|
| `PartitionedRead` | Splits matched files across more than one partition (`files_per_partition`). |
| `ReplaceWrites` | Supports `strategy: replace`. |
| `BoundedWindow` | Honors an entity's upper watermark bound, applied row-by-row since there is no native filter pushdown. |
| `PathTemplating` | Understands calendar tokens in `path`, for both read pruning and `partition_by` writes. |
| `GatedOperations` | Every SSH operation routes through `rate_limit` pacing. |

## Notes

- `password` and `private_key_path` are mutually exclusive; declaring both, or neither, fails
  validation.
- A json entity always needs a `columns` contract. There is no managed NDJSON schema inference for
  this connector.

## Related

- [Connections.yml reference](/reference/connections-yml/) for the shared `read:`/`write:` keys.
- [localfiles](/connectors/localfiles/) for the equivalent local-disk connector.
- [Secure connection config](/how-to/secure-connection-config/) for keeping credentials out of the
  repository.
- [Incremental loads](/concepts/incremental-loads/) for how the watermark window drives path
  templating.
