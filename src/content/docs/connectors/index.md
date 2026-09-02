---
title: "Connectors"
description: "The connectors that ship with pz today — file, object storage, and database sources and sinks — with what each one is and where to read more."
---

`pz` moves data through **connectors**: small, independently-versioned packages that read from
a source and write to a sink over DuckDB's own Arrow-native data plane wherever DuckDB can do the
work directly, falling back to a streamed Arrow path only where it can't. This page lists what
ships today; the architecture behind it — hosting, isolation, and the ABI a connector
implements — is covered in [Connectors: the plugin architecture](/concepts/connectors/). Want to
write your own? See [Author a connector](/how-to/author-a-connector/).

## File and object storage

| Connector | Direction | What it is |
|---|---|---|
| `localfiles` | source · sink | The local filesystem — csv, parquet, and json (NDJSON), all resolved against the project directory. |
| `s3` | source · sink | Amazon S3, read and written natively through DuckDB's `httpfs` extension — no AWS SDK in the data path. |
| `azureblob` | source · sink | Azure Blob Storage, over the Azure Storage SDK on the write side and native `az://` reads. |
| `gcs` | source · sink | Google Cloud Storage — native `gs://` reads/writes for HMAC credentials, or the Google Cloud Storage SDK (writes only) for service-account/ADC auth. See [Use Google Cloud Storage](/how-to/gcs/). |

## Databases

| Connector | Direction | What it is |
|---|---|---|
| `postgres` | source · sink | PostgreSQL, with `append`/`replace`/`merge` sinks and CDC-capable incremental extraction. |
| `sqlserver` | source · sink | SQL Server — also the backend `pz` itself can use for remote run state. |
| `mysql` | source · sink | MySQL, entirely through DuckDB's own `mysql` extension — no .NET MySQL driver in the connector at all. |
| `sqlite` | source · sink | SQLite, over DuckDB's `sqlite` extension — a file path is the whole connection, no server and no credential. |

## APIs

| Connector | Direction | What it is |
|---|---|---|
| `http` | source · sink | Pulls a `GET` JSON REST API into a project, with pagination and two ways to land the response. See [Extract from an HTTP API](/how-to/extract-from-http-api/). |

## Bringing your own

Every connector runs out-of-process, discovered and version-checked from a NuGet-style package —
the same isolation boundary whether it shipped with `pz` or came from your own team.
[Author a connector](/how-to/author-a-connector/) covers writing and packaging one.
