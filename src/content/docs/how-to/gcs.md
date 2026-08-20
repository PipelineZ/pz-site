---
title: "Use Google Cloud Storage"
description: "There is no dedicated GCS connector, and there doesn't need to be one: Google Cloud Storage speaks the S3 protocol on storage.googleapis.com (its..."
---

There is no dedicated GCS connector, and there doesn't need to be one: Google Cloud Storage
speaks the S3 protocol on `storage.googleapis.com` (its [interoperability
mode](https://cloud.google.com/storage/docs/interoperability)), and the `s3` connector's
`endpoint` override exists for exactly this kind of S3-compatible target. DuckDB — whose
`httpfs` extension is the s3 connector's entire data plane — documents the same route for
its own GCS support. Both directions work: reads (`source()`) and writes (`sink()`), in
parquet, csv, and NDJSON json.

## 1. Create HMAC credentials

GCS's S3-compatible auth uses HMAC keys, not your usual service-account JSON:

1. In the Cloud Console: **Cloud Storage → Settings → Interoperability**.
2. Create an HMAC key for a service account that has the right role on the target bucket
   (`roles/storage.objectViewer` to read, `roles/storage.objectAdmin` to write).
3. You get an **access key** and a **secret** — these fill the s3 connector's
   `access_key`/`secret_key`.

## 2. Point the s3 connector at GCS

```yaml
# connections.yml
gcs:
  connector: s3
  connection:
    root: my-bucket/exports          # or name bucket/path per entity instead
    access_key: "{{ env('GCS_HMAC_ACCESS_KEY') }}"
    secret_key: "{{ env('GCS_HMAC_SECRET') }}"
    endpoint: storage.googleapis.com
    url_style: path
  entities:
    events:
      read:
        format: parquet
        path: raw/events/*.parquet   # globs work; omit path to read <root>/events.parquet
```

```sql
-- pipelines/orders_out.sql — read from GCS, write back to GCS
INSERT INTO {{ sink('gcs', 'orders_out', strategy: 'replace', format: 'parquet') }}
select * from {{ source('gcs', 'events') }}
```

Reads compile to DuckDB `read_parquet`/`read_csv`/`read_json` native scans over
`s3://my-bucket/…`, writes to a `COPY … TO 's3://…'` — both under one scoped
`CREATE SECRET` carrying the endpoint override, exactly as against AWS.

Notes:

- `url_style: path` is the reliable choice against `storage.googleapis.com`.
- `region` can be omitted (GCS ignores it; the connector defaults to `us-east-1`).
- `use_ssl` defaults to true — leave it.
- csv/json reads without a `columns:` contract auto-detect their schema as part of the
  scan (and get the PZ0523/PZ0524 inference warnings); a declared contract prunes the
  read to exactly the declared columns.
- `strategy: append` writes a uniquely-named object per run; `replace` overwrites one
  stable object name. Both are plain object operations — no S3 multipart dependency.

## What this recipe rests on

The endpoint-override mechanism (custom endpoint + path-style URLs + HMAC-style keys) is
exercised continuously in this repo's test suite against MinIO, another S3-compatible
store — including full `pz run` round-trips in both directions and per format. The
GCS-specific half (that `storage.googleapis.com` faithfully implements the S3 surface
DuckDB's `httpfs` uses) is Google's documented interoperability contract and DuckDB's
documented GCS route. If you hit a GCS-specific edge, please open an issue — a failing
`connections.yml` shape plus the PZ0311 error text is enough to act on.
