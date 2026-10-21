---
title: "REST APIs without the glue script"
description: "Auth, pagination, incremental reads, rate limits, and retries are the same five problems on every API. The http connector turns them into a few lines of YAML, so pulling an API is a source like any other."
date: 2026-10-21
heroImage:
  dark: ./hero-dark.svg
  light: ./hero-light.svg
  alt: "The words REST APIs without glue, above a stack of response pages linked by next arrows, the newest pages glowing yellow and flowing past a metered gate into a pipeline."
---

Most teams have one somewhere: a Python script that pulls an API into a table. It sets an
`Authorization` header, loops while there's a next page, sleeps when it gets a `429`, appends rows
to a file, and writes the last `updated_at` it saw into a text file for tomorrow. It works. Then a
token expires, the provider tightens its rate limit, or the job dies on page 400 of 600, and
someone has to remember how the loop decides where to start again.

None of that logic is specific to one API. Every REST source needs the same five things: auth,
pagination, a way to fetch only what changed, a polite request rate, and retries that don't start
over. pz's `http` connector makes each one a key in `connections.yml`, so an API becomes a
`source()` like a database table.

## One connection, one entity

The connection holds what every request shares: where the API lives, how to authenticate, and any
static headers. Each entity is one endpoint:

```yaml title="connections.yml"
github:
  connector: http
  base_url: https://api.github.com
  auth: { type: bearer, token: ${GITHUB_TOKEN} }
  headers: { X-GitHub-Api-Version: "2022-11-28" }
  entities:
    issues:
      read:
        path: /repos/duckdb/duckdb/issues
        query: { state: all, per_page: "100", sort: updated, direction: asc, since: "{{ watermark }}" }
        pagination: { strategy: link_header }
        cursor_order: asc
        columns:
          id: bigint
          number: bigint
          title: varchar
          state: varchar
          updated_at: timestamp
        sync: { mode: incremental, cursor: updated_at }
```

Three auth shapes cover most APIs, and the credential always comes from an environment variable,
never a literal in YAML:

| Type | YAML | Sent as |
|---|---|---|
| `bearer` | `auth: { type: bearer, token: ${TOKEN} }` | `Authorization: Bearer <token>` |
| `api_key` | `auth: { type: api_key, key: ${API_KEY}, header: X-Api-Key }` | A header, or a query parameter with `param:` instead of `header:` |
| `basic` | `auth: { type: basic, user: ${USER}, password: ${PASSWORD} }` | `Authorization: Basic <base64(user:password)>` |

A key sent as a query parameter is redacted from error messages and logs. And since every request
carries the connection's credentials, the connector never follows a redirect, a `Link` header, or
a delta link to a host outside `base_url`'s own origin unless you list it in `allow_hosts`. A
pagination link pointing somewhere unexpected fails the read instead of handing your token to it.

## Typed columns, or the raw payload

`columns:` types the fields you care about at extraction time. Every other key in the JSON is
ignored, and a declared key missing from a record lands as null. When the records sit inside an
envelope, like `{"data": [...], "meta": {...}}`, `items: /data` points at the array.

Leave `columns:` off and nothing is lost: each record lands verbatim as one row of a fixed raw
shape, with the JSON text in `payload`, the page it came from in `pz_page`, and the fetch time in
`pz_fetched_at`. That's the mode for exploring an API you don't know yet, or for one whose records
are too irregular to type up front. You can shape `payload` in SQL afterwards, inside the staging
database.

## Three ways to say "next page"

Pagination is where glue scripts differ most, and where they most often go quietly wrong. pz
supports the three shapes nearly every API uses:

| Strategy | YAML | The crawl ends when |
|---|---|---|
| Link header | `pagination: { strategy: link_header }` | There's no `rel="next"` link. |
| Cursor token | `pagination: { strategy: cursor, pointer: /meta/next_cursor, param: cursor }` | The token at `pointer` is missing, null, or empty. |
| Page number | `pagination: { strategy: page, param: page, start: 1, size_param: per_page, size: 100 }` | A page comes back empty. |

An empty page doesn't end a link-header or cursor crawl, because an API filtering server-side can
legitimately return one mid-stream. For page-number APIs that clamp an out-of-range page to the
last real one instead of returning nothing, `stop_on_short_page: true` ends the crawl on the first
page shorter than `size`.

Two guards stop a crawl from running forever. A crawl that requests a URL it already requested
fails with a permanent error, and so does one that passes `max_pages`, a per-run cap that defaults
to a 50,000-page ceiling. Past that point an unbounded crawl and a broken feed look exactly alike.

## Only what changed

The `since: "{{ watermark }}"` in the query is the whole incremental read. pz substitutes the
highest `updated_at` it stored after the last successful run. On the first run, or under
`--full-refresh`, there's no watermark, so the parameter is left out entirely rather than sent
empty, and the API returns everything.

```console
$ pz run --all
ok src_github__issues 487 rows 612ms
ok lake.issues_log 487 rows 41ms
run 20261021T090011003Z-8a2f: 2 succeeded, 0 failed, 0 skipped (.pz/runs/20261021T090011003Z-8a2f/run_results.json)

$ pz run --all
ok src_github__issues 12 rows 340ms
ok lake.issues_log 12 rows 9ms
run 20261021T090512118Z-1c3e: 2 succeeded, 0 failed, 0 skipped (.pz/runs/20261021T090512118Z-1c3e/run_results.json)
```

`cursor_order` tells pz which way the API serves records relative to the cursor, and it matters
the moment a crawl is cut short. If an ascending crawl stops at `max_pages`, everything it fetched
is older than everything it didn't, so advancing the watermark to the last row is safe. A
descending crawl cut short would have fetched the newest rows and skipped the ones in between, so
`cursor_order: desc` together with `max_pages` is refused at compile time with `PZ0229`, before it
can move the watermark past rows it never read.

For a long history, the same windowing as a database source works here too: declare `max_window`
under `sync:` and reference `{{ window_upper }}` in the query, and each run fetches one bounded
`(lower, upper]` slice. [A year of history, one slice at a time](/blog/a-year-of-history-one-slice-at-a-time/)
covers that loop in full.

## Being a polite client

Most APIs publish a rate limit, and most glue scripts discover it by hitting it. `rate_limit:` on
the connection paces every request before it's sent:

```yaml title="connections.yml"
github:
  connector: http
  base_url: https://api.github.com
  auth: { type: bearer, token: ${GITHUB_TOKEN} }
  rate_limit:
    requests_per_minute: 60
    burst: 10
```

It's a token bucket: it starts full at `burst` and refills at `requests_per_minute / 60` tokens a
second. One page fetch costs one token, and the budget is shared across every entity on the
connection and every retry attempt for the whole run, so five endpoints on one API key can't
collectively blow through it.

pz also listens when the API reports its own budget. When a response carries
`X-RateLimit-Remaining: 0` (or the standard `RateLimit-Remaining`) with a reset time, the next
request on that connection waits until the reset, capped at 15 minutes so a misbehaving header
can't stall a run indefinitely.

When a request fails anyway, pz retries that one page, not the whole crawl. A `408`, `429`, `500`,
`502`, `503`, or `504` is transient: the fetch is repeated under the connection's `retry:` policy,
three attempts with exponential backoff and jitter by default. If the response included a
`Retry-After` header, that delay replaces the computed backoff, still capped by `max_delay`. Any
other status, like a `401` from an expired token, is permanent and fails the read straight away
with the status and the redacted URL, since retrying a bad credential only burns quota.

| Lever | Where | What it bounds |
|---|---|---|
| `rate_limit:` | Connection | Requests per minute, across every entity on the connection |
| API budget headers | The API's responses | Waits out an exhausted budget until its reset |
| `retry:` | Connection, or one entity's `read:` | How many times, and how patiently, a failed page is re-requested |
| `engine.breaker` | `project.yml` | Stops sending requests to a connection that keeps failing |

[Throttle a source](/how-to/throttle-a-source/) and [Tune retries](/how-to/tune-retries/) cover
each lever and how they combine.

## When the crawl dies on page 400

A page that keeps failing past its retries fails that attempt at the read, but the next attempt
doesn't start from page one. The continuation link for the next page is recorded as a checkpoint,
and only once every row from the pages before it is safely staged. The next attempt, whether the
node's own retry or a later `pz retry`, resumes from that link, so the 400 pages that already
landed aren't requested again.

Nothing moves the watermark until the sink has committed, so a crawl that fails at any point
leaves tomorrow's starting point exactly where it was.
[Retry without starting over](/blog/retry-without-starting-over/) covers how `pz retry` picks up
the rest of the run.

## Landing it, and sending it back

On the way in, an API is a source like any other, so the sink is up to you. GitHub's `since` is
inclusive, which means the boundary issue arrives again on the next run. Into a merge-capable
destination that's harmless:

```sql title="pipelines/issues_current.sql"
INSERT INTO {{ sink('warehouse', 'issues_current', strategy: 'merge', keys: ['id']) }}
SELECT id, number, title, state, updated_at
FROM {{ source('github', 'issues') }}
```

Into a plain file, pz makes you say out loud that you accept the overlap, with
`duplicates: 'accept'`, or refuses the pairing with `PZ0214`.

The connector works in the other direction too. As a sink, it pushes a pipeline's rows to an
endpoint: `append` sends batches of `rows_per_request` rows (500 by default) as a JSON array or
NDJSON, and `merge` sends one keyed `PUT` or `PATCH` per row to a path with a `{key}` token in it:

```sql title="pipelines/crm_sync.sql"
INSERT INTO {{ sink('crm', 'contacts', strategy: 'merge', keys: ['id'], path: '/contacts/{key}') }}
SELECT id, email, plan, updated_at
FROM {{ ref('contacts_shaped') }}
```

An `append` write that fails partway resumes past the batches the endpoint already confirmed,
rather than sending everything again. `replace` isn't offered at all: there's no general way to
atomically overwrite whatever an arbitrary endpoint already holds, so pz doesn't pretend there is.

## Try it

`pz init --template http` scaffolds the GitHub example above, ready to run with no token.
[Extract from an HTTP API](/how-to/extract-from-http-api/) walks it step by step, through
authentication and troubleshooting, and the [HTTP connector reference](/connectors/http/) lists
every connection, read, and write option. For the watermark model behind `{{ watermark }}`, see
[Incremental loads](/concepts/incremental-loads/).
