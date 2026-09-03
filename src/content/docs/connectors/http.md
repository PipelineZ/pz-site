---
title: "HTTP API"
description: "Reference for the http connector: connection and auth keys, the raw and columns:-contract landing modes, all three pagination strategies, incremental extraction, and the write-side sink options."
sidebar:
  order: 16
---

The `http` connector pulls a JSON REST API's `GET` responses into a project, and can push a
pipeline's rows back out over `POST`/`PUT`/`PATCH`. It runs entirely on the universal Arrow tier:
there is no native DuckDB scan or copy path, since DuckDB has no HTTP-JSON data plane of its own.

## Connection

```yaml title="connections.yml"
github:
  connector: http
  base_url: https://api.github.com
  auth: { type: bearer, token: ${GITHUB_TOKEN} }
  headers: { X-GitHub-Api-Version: "2022-11-28" }
```

| Key | Required | Default | Meaning |
|---|---|---|---|
| `base_url` | Yes | — | Absolute `http(s)` URL every entity's `path` resolves against. |
| `auth` | No | — | `{ type: api_key \| bearer \| basic, ... }`. Shared by every entity on this connection. |
| `headers` | No | `{}` | Static extra headers sent on every request. |
| `check_path` | No | — | Request-relative path `pz validate --connect` probes to confirm connectivity. |
| `timeout_seconds` | No | `30` | Per-request timeout, 1–3600 seconds. |
| `max_response_mb` | No | `256` | Maximum response size, 1–4096 MiB. A page is buffered whole then parsed. |
| `allow_hosts` | No | `[]` | Extra bare hostnames this connection may follow, beyond `base_url`'s own origin. |

### Auth

| Type | YAML | Where the credential goes |
|---|---|---|
| API key | `auth: { type: api_key, key: ${API_KEY}, header: X-Api-Key }` or `..., param: api_key` | A request header or a query parameter, exactly one of `header`/`param`. Query-parameter keys are redacted in error messages and logs. |
| Bearer token | `auth: { type: bearer, token: ${TOKEN} }` | `Authorization: Bearer <token>` header. |
| Basic | `auth: { type: basic, user: ${USER}, password: ${PASSWORD} }` | `Authorization: Basic <base64(user:password)>` header. |

Credentials belong in environment variables, never literal in YAML. See
[Secure connection config](/how-to/secure-connection-config/).

## Read options

Shared keys (`columns`, `sync`, `retry` under `read:`, and `rate_limit` on the connection) are
documented in [connections.yml reference](/reference/connections-yml/).

| Key | Required | Default | Meaning |
|---|---|---|---|
| `path` | Yes | — | Request-relative path, must start with `/`. Never templated itself; only `query` values are. |
| `query` | No | `{}` | Map of query parameters. Values may reference `{{ watermark }}` or `{{ window_upper }}`. |
| `pagination` | No | none | One pagination block: `page`, `link_header`, or `cursor`. See below. |
| `items` | No | body root | JSON pointer to the array of records, when the response body wraps it in an envelope. |
| `columns` | No | — | Column-to-type contract. With no contract, the entity lands the raw envelope shape below. |
| `cursor` | Raw mode only | — | Column name driving incremental extraction. In contract mode, the cursor is just a declared `columns` entry instead. |
| `cursor_type` | Raw mode only, required with `cursor` | — | One of the contract types: `int`, `bigint`, `double`, `decimal`, `varchar`, `boolean`, `date`, `timestamp`. |
| `cursor_pointer` | No | `/<cursor>` | JSON pointer to the cursor's value in one record, when it differs from a same-named field. |
| `cursor_order` | No | inferred at run time | `asc` or `desc`: how the API serves records relative to the cursor. Makes a truncated crawl's safety checkable at compile time. |
| `max_pages` | No | `50000` ceiling | Caps a single run's crawl. |

### Landing modes

With no `columns:`, every record under `items` lands as one row of a fixed raw envelope:

| Column | Type | Meaning |
|---|---|---|
| `payload` | `varchar` | The record's JSON text, verbatim. |
| `pz_page` | `int` | Zero-based page index within the run. |
| `pz_fetched_at` | `timestamp` | Request-time UTC when the page was fetched. |
| *(cursor name)* | *(`cursor_type`)* | Present only when `cursor`/`cursor_type` are set. |

Declaring `columns:` instead types the fields you want at extraction time. Extra JSON keys are
ignored; a declared key absent from a record lands as null.

```yaml title="connections.yml"
github:
  connector: http
  base_url: https://api.github.com
  auth: { type: bearer, token: ${GITHUB_TOKEN} }
  entities:
    issues:
      read:
        path: /repos/duckdb/duckdb/issues
        query:
          state: all
          since: "{{ watermark }}"
        pagination: { strategy: link_header }
        columns:
          id: bigint
          title: varchar
          updated_at: timestamp
        sync:
          mode: incremental
          cursor: updated_at
```

### Pagination

Declare exactly one `pagination:` block.

| Strategy | YAML | When to use it |
|---|---|---|
| Link header | `pagination: { strategy: link_header }` | The API returns an RFC 8288 `Link` header (GitHub and most REST APIs that follow the convention). Follows the `rel="next"` link. |
| Page number | `pagination: { strategy: page, param: page, start: 1, size_param: per_page, size: 100 }` | Offset-style APIs. `param`/`start` default to `page`/`1`; `size_param`/`size` are optional and added together. |
| Cursor token | `pagination: { strategy: cursor, pointer: /meta/next_cursor, param: cursor }` | Token-style APIs. `pointer` is a JSON pointer to the next page's token in the body; it is copied to `param` on the next request. |

Link-header and cursor-token crawls end when their own signal is absent (no next link, or a
missing/null/empty token); an empty page alone does not end them. Page-number crawls, with no
other signal, end on an empty page. A crawl exceeding `max_pages`, or one that revisits a URL it
already requested, fails with a permanent error rather than looping.

### Incremental extraction

Reference the stored watermark in any `query` value with `{{ watermark }}`. On the first run, or
under `--full-refresh`, the parameter is omitted entirely rather than sent empty. For a large
historical range, declare `sync: { max_window: ... }` and reference `{{ window_upper }}` in
`query` to extract bounded `(lower, upper]` windows one run at a time instead of one open-ended
pull. See [Incremental loads](/concepts/incremental-loads/) for the full watermark and window
model.

## Write options

Per-write options are keyword arguments on the `sink()` call, alongside `strategy` and `keys`.

```sql title="pipelines/events_out.sql"
INSERT INTO {{ sink('webhook', 'events_out', strategy: 'append', path: '/events') }}
SELECT * FROM {{ ref('events_shaped') }}
```

| Option | Applies to | Default | Meaning |
|---|---|---|---|
| `path` | both | — | Required. Request-relative path, must start with `/`. Under `strategy: merge` it must contain a `{key}` token; under `append` the token is not allowed. |
| `method` | both | `post` (append), `put` (merge) | `post`, `put`, or `patch`. |
| `body_format` | `append` only | `json_array` | `json_array` (one `[...]` array per request) or `ndjson` (one JSON object per line). Setting it on `merge` is an error. |
| `rows_per_request` | `append` only | `500` | Rows chunked into each request. Setting it on `merge` is an error. |

`append` chunks rows into `rows_per_request`-sized requests; `merge` requires exactly one key
column and sends one keyed `PUT`/`PATCH` per row. `replace` is not supported: there is no way to
atomically overwrite an arbitrary endpoint's prior state.

## Capabilities

| Flag | Meaning |
|---|---|
| `BoundedWindow` | Honors an entity's upper watermark bound. |
| `SyncState` | Supports delta-link / change-feed reads via `delta_pointer`, for APIs with no orderable cursor. |
| `GatedOperations` | Every request routes through `rate_limit` pacing. |
| `StablePartitionIds` | Each page-fetch partition carries a stable id, enabling partition-scoped retry. |
| `CheckpointableReads` | A retried read can resume mid-crawl rather than restarting from page one. |
| `Merge` | The sink supports `strategy: merge`. |
| `CheckpointableWrites` | A retried write resumes past whatever prefix the destination already confirmed, instead of re-sending rows. |

## Notes

- `GET` only on the source side; no native scan or copy path in either direction.
- One partition per entity: no parallel fan-out across pages.
- The connector never follows a redirect, `Link` header, or delta token to a host outside
  `base_url`'s own origin unless it is listed in `allow_hosts`, since every request carries this
  connection's credentials.

## Related

- [Extract from an HTTP API](/how-to/extract-from-http-api/) for a worked walkthrough with
  auth setup and a full pagination example.
- [Connections.yml reference](/reference/connections-yml/) for the shared `read:`/`write:` keys.
- [Incremental loads](/concepts/incremental-loads/) for watermarks, bounded windows, and sync
  state.
- [Secure connection config](/how-to/secure-connection-config/) for keeping `auth` credentials out
  of the repository.
