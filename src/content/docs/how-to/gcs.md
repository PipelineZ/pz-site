---
title: "Use Google Cloud Storage"
description: "GCS has a first-class `gcs` connector. The auth method selects the data plane: HMAC keys drive DuckDB-native gs:// reads and writes; service-account…"
---

GCS has a first-class `gcs` connector. Its one unusual property: **the `auth` method selects the
data plane**, because the two credential families reach different machinery by construction, not
by policy.

- **`auth: hmac`** (GCS's [interoperability keys](https://cloud.google.com/storage/docs/authentication/hmackeys))
  is the only method DuckDB's native `gs://` tier can authenticate. It carries **both
  directions**: reads compile to `read_parquet`/`read_csv`/`read_json` native scans, writes to
  `COPY … TO 'gs://…'` — data never enters .NET. This is the mode to prefer.
- **`auth: service_account`** (a key file, or the key JSON inline) and **`auth: adc`**
  (Application Default Credentials) are OAuth-only, which DuckDB cannot speak. They carry
  **writes only**, through Google SDK write sessions — including `partition_by` fan-out.
  A `source()` on such a connection is refused at open with the fix in the message.

## Option 1: HMAC keys (reads + writes, native)

1. In the Cloud Console: **Cloud Storage → Settings → Interoperability**.
2. Create an HMAC key for a service account with the right role on the target bucket
   (`roles/storage.objectViewer` to read, `roles/storage.objectAdmin` to write). You get a
   **key id** and a **secret**.

```yaml
# connections.yml
lake:
  connector: gcs
  auth: hmac
  root: my-bucket/exports           # or name bucket/path per entity instead
  key_id: "{{ env('GCS_HMAC_KEY_ID') }}"
  secret: "{{ env('GCS_HMAC_SECRET') }}"
  entities:
    events:
      read:
        format: parquet
        path: raw/events/*.parquet  # globs work; omit path to read <root>/events.parquet
```

```sql
-- pipelines/orders_out.sql — read from GCS, write back to GCS
INSERT INTO {{ sink('lake', 'orders_out', strategy: 'replace', format: 'parquet') }}
select * from {{ source('lake', 'events') }}
```

Everything the other file connectors do applies unchanged: parquet/csv/json (NDJSON) in both
directions, csv/json schema auto-detection without a `columns:` contract (with the inference
warnings; a declared contract prunes the read), date-templated paths with watermark-window
pruning, `strategy: append` writing a uniquely-named object per run vs `replace` overwriting one
stable name.

## Option 2: service account / ADC (writes only, SDK)

For a write-only destination where minting HMAC keys is not an option:

```yaml
lake:
  connector: gcs
  auth: service_account
  key_file: /secrets/writer-key.json   # or key_json: '<the raw key JSON>' — one, not both
  root: my-bucket/exports
```

`auth: adc` needs no further fields — it resolves the ambient credentials
(`gcloud auth application-default login`, `GOOGLE_APPLICATION_CREDENTIALS`, or the metadata
server on GCP compute).

Writes commit as **one atomic upload per object**: batches spool to a local temp file and the
final object appears only when its upload completes, so an aborted or failed run never leaves a
partial object behind. `partition_by` with a date-templated `path` fans out per calendar folder
(per-partition atomic, at-least-once at the set level — same contract as azureblob).

## Notes

- `endpoint` overrides the target host in both modes, but its shape differs by tier: the native
  (hmac) tier wants `host:port` with `url_style`/`use_ssl` alongside (DuckDB secret options,
  useful against MinIO or another interop endpoint), while the SDK tier wants a full base URL
  (e.g. `http://localhost:4443/storage/v1/` against an emulator). Leave it unset against real
  GCS.
- Sources on a `service_account`/`adc` connection fail at open with the HMAC next step — there
  is no universal read tier, so this is a refusal, not a fallback.
- Any *other* S3-compatible store remains reachable via the `s3` connector's `endpoint`
  override, which is also how this connector's native tier is exercised in the test suite
  against MinIO.
