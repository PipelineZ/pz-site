---
title: "Download files and exports from an API"
description: "How to land CSV, JSON and XML files served by an HTTP API with the http connector: zip and gzip archives, several tables from one archive, dated URLs, catching up missed days, and asynchronous export jobs."
sidebar:
  order: 21
---

This page shows how to read files that an API serves instead of JSON pages: a daily zip of CSV
exports, an XML report, or a file an export job builds in the background. Read it when an
endpoint answers with a file, or when you have to start a job and wait before there is anything
to download.

## Prerequisites

- A `pz` project with an `http` connection to the API. See
  [Extract from an HTTP API](/how-to/extract-from-http-api/) for connection and auth setup.
- Disk space for one download: files stream through a temporary file that is deleted after the
  read.

## Steps

### 1. Read one file

Add a `file:` block to the entity's `read:`. `format` is `csv`, `tsv`, `json` or `xml`, and
`columns:` types the fields you want:

```yaml title="connections.yml"
vendor:
  connector: http
  base_url: https://api.vendor.example
  auth: { type: bearer, token: ${VENDOR_TOKEN} }
  entities:
    products:
      read:
        path: /exports/products.csv
        file: { format: csv }
        columns: { sku: varchar, name: varchar, price: decimal }
```

CSV columns are matched to the header by name. Set `header: false` to match by position, and
`delimiter: ";"` for a semicolon-separated file. A gzip-compressed file is detected from its first
bytes and unpacked, so `/exports/products.csv.gz` needs no extra key.

For JSON, `layout: lines` (the default) reads NDJSON, one record per line, and `layout: document`
reads one document whose records `items` points at. For XML, `records` names the element path of
one record:

```yaml title="connections.yml"
    campaigns:
      read:
        path: /reports/campaigns.xml
        file: { format: xml, records: /report/campaigns/campaign }
        columns: { id: bigint, name: varchar, budget: decimal }
```

Each XML column is filled from the record's child element of that name, or from its attribute.

### 2. Read several tables from one zip

A zip needs `members`, a glob choosing the entries to read. Declare one entity per table; each
downloads the same archive and reads its own members with its own format:

```yaml title="connections.yml"
    daily_sessions:
      read:
        path: /exports/daily.zip
        file: { format: csv, members: "sessions_*.csv" }
        columns: { session_id: varchar, started_at: timestamp, duration_s: int }
    daily_events:
      read:
        path: /exports/daily.zip
        file: { format: json, layout: lines, members: "events.jsonl" }
    daily_campaigns:
      read:
        path: /exports/daily.zip
        file:
          format: xml
          members: "campaigns.xml"
          records: /report/campaigns/campaign
          if_missing: empty
        columns: { id: bigint, name: varchar, budget: decimal }
```

`daily_events` has no `columns:`, so it lands the raw envelope: each record as JSON text in
`payload`, the member path in `pz_file`, and its position in `pz_row`. `if_missing: empty` reads
zero rows, with a notice, on days the vendor leaves `campaigns.xml` out of the zip; without it, a
missing member fails the read and lists the entries the zip does contain.

### 3. Fetch yesterday's file

Most daily exports are named by date. `{{ run_date }}` is the day of the run, shifted by
`run_date: { offset_days: ... }`:

```yaml title="connections.yml"
    daily_sessions:
      read:
        path: /exports/daily/{{ run_date }}.zip
        run_date: { offset_days: -1, timezone: Europe/Bucharest }
        file: { format: csv, members: "sessions_*.csv" }
        columns: { session_id: varchar, started_at: timestamp, duration_s: int }
```

With `offset_days: -1`, a run on 2026-11-09 in Bucharest time requests
`/exports/daily/2026-11-08.zip`. `run_date` also works in `query:` (`query: { date: "{{ run_date }}" }`)
and in a POST `body`. Change the text with `format`, for example `format: yyyyMMdd`.

### 4. Catch up missed days

A fixed `run_date` fetches one day per run, so a day the job did not run is never fetched. When
the file has a date column, make the entity incremental on it and let each run take the next day:

```yaml title="connections.yml"
    daily_sessions:
      read:
        sync: { mode: incremental, cursor: day, initial: "2026-10-01", max_window: 1d }
        path: /exports/daily/{{ window_upper }}.zip
        file: { format: csv, members: "sessions_*.csv" }
        columns: { day: date, session_id: varchar, started_at: timestamp, duration_s: int }
```

Each run downloads the day after the stored watermark. The window can reach today, whose file may
not be published yet: that download fails with `404`, the watermark stays where it was, and a
later run fetches the day. To avoid the failure, schedule the run after the vendor publishes, or
set `until:` in `sync:`. See [Backfill in slices](/how-to/backfill-in-slices/) for the window
model.

### 5. Start an export job and download its result

Some APIs build a file on request: you start a job, poll its status, then download the result.
Describe the start request as usual, and the rest in `export:`:

```yaml title="connections.yml"
analytics:
  connector: http
  base_url: https://analytics.example.com/api
  allow_hosts: [exports.s3.amazonaws.com]
  auth:
    type: oauth2_client_credentials
    token_url: https://analytics.example.com/oauth/token
    client_id: ${ANALYTICS_CLIENT_ID}
    client_secret: ${ANALYTICS_CLIENT_SECRET}
  entities:
    traffic:
      read:
        method: post
        path: /reports
        body: { metrics: [visits, bounces], day: "{{ run_date }}" }
        run_date: { offset_days: -1 }
        export:
          job_id: /id
          status_path: /reports/{job_id}
          status_pointer: /state
          ready: [done]
          failed: [failed, cancelled]
          message_pointer: /error/message
          download_pointer: /result/url
          poll_interval_seconds: 15
          timeout_minutes: 60
        file: { format: csv }
        columns: { day: date, visits: bigint, bounces: bigint }
```

The read:

1. Sends `POST /reports` and takes the job id from `/id` in the response.
2. Polls `GET /reports/<id>` every 15 seconds until `/state` is `done`. A state of `failed` or
   `cancelled` fails the read, quoting `/error/message`.
3. Downloads the URL at `/result/url` in the last status response and reads it as CSV.

The download URL here is a pre-signed link on another host, so that host is listed in
`allow_hosts`. It is fetched without the connection's credentials, since the link carries its
own. If the API serves the file from a fixed path instead, use `download_path:
/reports/{job_id}/file` in place of `download_pointer`.

A job that is not ready within `timeout_minutes` fails with a transient error, and the engine's
retry starts a new job. The start request is not retried on its own, but a `5xx` or a timeout on
it is transient too, so the node's retry sends a new start.

#### Cancel jobs that do not finish

Each abandoned job keeps running on the vendor's side, and some APIs limit how many can run at
once. If the API has a cancel endpoint, add it:

```yaml title="connections.yml"
        export:
          job_id: /id
          status_path: /reports/{job_id}
          status_pointer: /state
          ready: [done]
          failed: [failed, cancelled]
          download_pointer: /result/url
          cancel_path: /reports/{job_id}
          cancel_method: delete
```

pz now sends `DELETE /reports/<id>` when a job times out, reports `failed`, fails a poll, or is
still running when the run is cancelled. For an API that cancels with
`POST /reports/{job_id}/cancel`, set `cancel_path: /reports/{job_id}/cancel` and
`cancel_method: post`. A job that became ready is never cancelled, even if its
download fails. The cancel is sent once and waits at most 10 seconds; its outcome is printed as a
notice, and the read still fails with its own error.

#### Read a result split into several files

Large exports often come back as a list of files. Point `download_pointer` at the list:

```yaml title="connections.yml"
        export:
          job_id: /id
          status_path: /reports/{job_id}
          status_pointer: /state
          ready: [done]
          download_pointer: /result/files
        file: { format: csv, file_column: source_file }
        columns: { day: date, visits: bigint, bounces: bigint }
```

With a ready status response such as this one:

```json
{
  "state": "done",
  "result": {
    "files": [
      "https://exports.s3.amazonaws.com/traffic/part-0.csv",
      "https://exports.s3.amazonaws.com/traffic/part-1.csv"
    ]
  }
}
```

pz checks every URL against `allow_hosts` first, then downloads and reads the files in order, one
at a time, each within the full `max_download_mb`. `file_column` records which file each row came
from. A URL listed twice is read once; an empty list lands no rows, with a notice. There is no
checkpoint between files: a failed read starts a new job on retry.

### 6. Land it

Write a pipeline per entity, as for any source. This one lands into the `lake` `localfiles`
connection from [Extract from an HTTP API](/how-to/extract-from-http-api/#3-add-a-sink-and-write-the-pipeline):

```sql title="pipelines/sessions_log.sql"
INSERT INTO {{ sink('lake', 'sessions_log', format: 'parquet', path: 'out/sessions/', strategy: 'append') }}
SELECT session_id, started_at, duration_s
FROM {{ source('vendor', 'daily_sessions') }}
```

An entity made incremental in step 4 feeds an `append` sink only with
`duplicates: 'accept'` ([`PZ0214`](/reference/error-codes/)), or use a merge-capable sink.

## Verify

Validate the config offline, then run:

```console
$ pz validate
$ pz run --all
```

`pz validate` checks every `file:` and `export:` key without downloading anything. Notices such
as an `if_missing: empty` zero-row read are printed during the run, prefixed with the
connection name. For an incremental entity,
`pz state show vendor.daily_sessions` shows the last day landed.

## Troubleshooting

| If you see | Do |
|---|---|
| `the download is a zip archive; set file.members` | The file is a zip. Add `members:` with a glob for the entries to read; the message lists them. |
| `no zip entry matches file.members` | The glob matches no entry. Globs match the full path and are case-sensitive; the message lists the entries. Use `if_missing: empty` if the member is legitimately absent some days. |
| `expected a csv file but ... answered text/html` | The API returned an error or login page with HTTP 200. Check the URL and the credentials. |
| `download exceeds 'max_download_mb'` | The file is larger than the cap (4096 MiB by default). Raise `max_download_mb` on the connection. |
| `decompressed content exceeds 20 × 'max_download_mb'` | The archive unpacks to more than 20 times the cap. Raise `max_download_mb` if the file is genuine. |
| A `404` on today's date | The vendor has not published the file yet. Nothing is lost; schedule later or set `until:`. |
| `export job ... not ready after N minutes` | Raise `export.timeout_minutes`. The error is transient, so the engine retries with a new job. |
| An error naming the download URL's host and `allow_hosts` | The export's download link points at another host. Add it to `allow_hosts`. |
| A notice `could not cancel export job ...` | The cancel endpoint refused. Check `cancel_path` and `cancel_method` against the API's docs; the read's own error is reported separately. |
| `does not resolve to a URL or a list of URLs` | `download_pointer` points at an object or a number. Point it at the URL string or the array of URLs. |
| `export job id '...' cannot be used in a URL path` | The job id is empty, has a `.` or `..` segment, or contains `\` or a control character. pz refuses it rather than build a path from it. |
| `'pagination' cannot be combined with 'file'` | A file is read in one request. Remove `pagination`, `max_pages` or `delta_pointer`. To download many files, list them with [`for_each`](/how-to/call-an-api-per-record/). |

## Related

- [HTTP connector reference](/connectors/http/#files): every `file:` and `export:` key and its
  default.
- [Call an API once per record](/how-to/call-an-api-per-record/): list the available exports,
  then download each one.
- [Backfill in slices](/how-to/backfill-in-slices/): windows with `max_window` and `until`.
- [Extract from an HTTP API](/how-to/extract-from-http-api/): connection, auth and JSON pages.
