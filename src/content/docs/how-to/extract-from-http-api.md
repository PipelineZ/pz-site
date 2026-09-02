---
title: "Extract from an HTTP API"
description: "How to pull a paginated JSON REST API into a pz project with the http connector, using GitHub's issues endpoint as a worked example."
sidebar:
  order: 1
---

This page walks through pulling a paginated JSON REST API into a `pz` project with the `http`
connector: GitHub's issues endpoint, landed as typed columns, extracted incrementally, and
written to a local parquet file. Read it if you're wiring up your first HTTP source.

## Prerequisites

- A `pz` project. Run `pz init --template http` to scaffold this exact example, or add the
  connection below to an existing project.
- Internet access. No credentials are required for this example: GitHub allows about 60
  unauthenticated requests per hour.

## Steps

### 1. Declare the connection

Add an `http` connection to `connections.yml`. `base_url` anchors every entity's `path`, and
`headers` apply to every request on this connection:

```yaml title="connections.yml"
github:
  connector: http
  base_url: https://api.github.com
  headers: { X-GitHub-Api-Version: "2022-11-28" }
```

### 2. Declare the entity

Add an entity under `entities:` naming the endpoint, its pagination, and the columns you want:

```yaml title="connections.yml"
  entities:
    issues:
      read:
        path: /repos/duckdb/duckdb/issues
        query: { state: all, per_page: "100", sort: updated, direction: asc, since: "{{ watermark }}" }
        pagination: { strategy: link_header }
        max_pages: 5
        cursor_order: asc
        columns:
          id: bigint
          number: bigint
          title: varchar
          state: varchar
          updated_at: timestamp
        sync: { mode: incremental, cursor: updated_at }
```

`path` is request-relative and starts with `/`. `pagination: { strategy: link_header }` follows
the RFC 8288 `Link` header GitHub returns, which is the most common pagination shape among REST
APIs. `max_pages: 5` caps a run at 500 issues, so a first try stays fast; drop it once you trust
the shape. `columns:` types exactly these five fields at extraction time; every other JSON key in
the response is ignored.

`sync: { mode: incremental, cursor: updated_at }` paired with `since: "{{ watermark }}"` in the
query makes this a [watermark](/concepts/incremental-loads/)-driven read: the first run omits
`since` entirely, and every later run sends the stored watermark. `cursor_order: asc` tells pz the
API serves oldest-first, so a `max_pages`-truncated crawl still advances the watermark safely. See
[Incremental loads](/concepts/incremental-loads/) for the full watermark model, and the
[HTTP connector reference](/connectors/http/) for every read option, all three pagination
strategies, and the raw landing mode you get with no `columns:` contract.

### 3. Add a sink and write the pipeline

Declare a `localfiles` connection to land the output, then write a pipeline that selects from the
source and inserts into the sink:

```yaml title="connections.yml"
lake:
  connector: localfiles
  root: out
```

```sql title="pipelines/issues_log.sql"
INSERT INTO {{ sink('lake', 'issues_log', format: 'parquet', path: 'out/issues/', strategy: 'append', duplicates: 'accept') }}
select id, number, title, state, updated_at
from {{ source('github', 'issues') }}
```

`duplicates: 'accept'` is required here: GitHub's `since` is inclusive, so the boundary row can
re-land on the next run. That makes this pairing at-least-once rather than effectively-once. `pz`
refuses an incremental read feeding a plain `append` sink without this consent
([`PZ0214`](/reference/error-codes/)). Deduplicate downstream by keeping the highest `updated_at`
per `id`, or point the sink at a merge-capable connector instead. See
[Incremental loads](/concepts/incremental-loads/#strategy-merge-and-re-extraction) for the merge
alternative.

### 4. Run it

Validate the config offline first, since the schema here is declared, not probed:

```console
$ pz validate
validation passed (1 pipelines, 2 connections checked)
```

Then run it, twice:

```console
$ pz run --all
ok src_github__issues 487 rows 612ms
ok lake.issues_log 487 rows 41ms
run 20260902T090011003Z-8a2f: 2 succeeded, 0 failed, 0 skipped (.pz/runs/20260902T090011003Z-8a2f/run_results.json)

$ pz run --all
ok src_github__issues 12 rows 340ms
ok lake.issues_log 12 rows 9ms
run 20260902T090512118Z-1c3e: 2 succeeded, 0 failed, 0 skipped (.pz/runs/20260902T090512118Z-1c3e/run_results.json)
```

Row counts vary since this hits live data. The second run only lands issues updated since the
first run's watermark.

## Verify

Query the parquet output directly with DuckDB, deduplicating on the highest `updated_at` per
`id` since the read is at-least-once:

```console
$ duckdb -c "select * from read_parquet('out/issues/*.parquet')
             qualify row_number() over (partition by id order by updated_at desc) = 1
             limit 5"
```

Confirm the watermark advanced between runs:

```console
$ pz state show github.issues
github.issues — cursor updated_at (timestamp)
  current  2026-09-02T08:58:04Z  run 20260902T090512118Z-1c3e
```

## Add authentication

Unauthenticated GitHub access is rate-limited to about 60 requests an hour. For heavier use,
export a token and reference it with `${VAR}` interpolation, never a literal in YAML:

```yaml title="connections.yml"
github:
  connector: http
  base_url: https://api.github.com
  auth: { type: bearer, token: ${GITHUB_TOKEN} }
  headers: { X-GitHub-Api-Version: "2022-11-28" }
```

```console
$ export GITHUB_TOKEN=ghp_...
```

`auth` also supports `api_key` and `basic`. See the [HTTP connector reference](/connectors/http/)
for all three shapes, and [Secure connection config](/how-to/secure-connection-config/) for
keeping credentials out of the repository.

## Write to an HTTP API

The `http` connector also ships a sink, for pushing a pipeline's rows to a REST endpoint with
`POST`, `PUT`, or `PATCH`:

```sql title="pipelines/events_out.sql"
INSERT INTO {{ sink('webhook', 'events_out', strategy: 'append', path: '/events') }}
select * from {{ ref('events_shaped') }}
```

`append` chunks rows into request bodies; `strategy: 'merge'` sends one keyed `PUT` per row
instead, with a `{key}` token in `path`. See the [HTTP connector reference](/connectors/http/)
for every write option and the write-side capability limits.

## Troubleshooting

| If you see | Do |
|---|---|
| `PZ0103` naming `GITHUB_TOKEN` | The `${GITHUB_TOKEN}` reference is unset. Export it, or remove the `auth:` line to run unauthenticated. |
| `PZ0214` at compile time | An incremental read feeds a plain `append` sink. Add `duplicates: 'accept'` to the sink, or switch to a merge-capable connector. |
| `PZ0229` at compile time | `cursor_order: desc` is set alongside `max_pages`. A truncated descending crawl could skip rows; drop `max_pages` or switch the cursor order. |
| An error naming a host and pointing at `allow_hosts` | A pagination link or redirect pointed outside `base_url`'s origin. Add the host to `allow_hosts` on the connection, only if you trust it. |
| `401`/`403` from the API | The token is missing, expired, or lacks scope. Requests fail the whole `SourceLoad` rather than landing a partial page. |
| A permanent error naming `max_pages` | The crawl passed 50,000 pages with no `max_pages` cap. Set one, since an unbounded crawl and a broken feed look identical past that point. |

## Related

- [HTTP connector reference](/connectors/http/): every connection, read, and write option, and
  all three pagination strategies.
- [Incremental loads](/concepts/incremental-loads/): watermarks, bounded windows, and the
  `strategy: merge` alternative to `duplicates: accept`.
- [Secure connection config](/how-to/secure-connection-config/): keeping `auth` credentials out
  of `connections.yml`.
- [Throttle a source](/how-to/throttle-a-source/): pace requests with `rate_limit` when an API
  enforces its own rate limit.
- [Debug a failed run](/how-to/debug-a-failed-run/): reading `run_results.json` when a crawl
  fails partway through.
