---
title: "Call an API once per record"
description: "How to read child data that an API exposes only per parent, such as /orders/{id}/lines, with the http connector's for_each: a list request or a fixed list of values, one item request per record, status rules, deduplication, parallel items, and safe resume."
sidebar:
  order: 22
---

This page shows how to read data that an API serves only one parent at a time: the lines of each
order at `/orders/{id}/lines`, or the files of each export listed at `/exports`. Read it when no
single endpoint returns everything you need, and you would otherwise call the API once per id by
hand.

`for_each:` describes a list request. Each record it returns drives one item request, described
by the entity's own `path`, `query`, `body`, `pagination` and `items`.

## Prerequisites

- A `pz` project with an `http` connection to the API. See
  [Extract from an HTTP API](/how-to/extract-from-http-api/) for connection and auth setup.
- A merge-capable sink, such as [duckdb](/connectors/duckdb/) or
  [postgres](/connectors/postgres/), if the read is retried or resumed (see step 4).

## Steps

### 1. Describe the list and item requests

```yaml title="connections.yml"
shop:
  connector: http
  base_url: https://api.shop.example
  auth: { type: bearer, token: ${SHOP_TOKEN} }
  entities:
    order_lines:
      read:
        for_each:
          path: /orders
          items: /data
          pagination: { strategy: cursor, param: cursor, pointer: /next_cursor }
          fields: { order_id: /id, customer: /customer/name }
        path: /orders/{{ item.order_id }}/lines
        items: /lines
        pagination: { strategy: page, size_param: per_page, size: 100 }
        columns: { order_id: varchar, customer: varchar, line_id: bigint, sku: varchar, qty: int }
```

The list request pages through `/orders` with its own `pagination`. `fields` maps a name to a
JSON pointer into each order record, and `{{ item.order_id }}` puts that value into the item
request's path. Each order's lines are paged to the end before the next order starts.

`columns:` entries named like a field (`order_id`, `customer`) are filled from the order, so every
line row says which order it belongs to. Without `columns:`, each row carries a `pz_item` column
instead, a JSON object of all declared fields.

Item references work in the item request's `path`, `query` and `body`. Values are escaped for
where they land, and a field that is missing, null, an object or an array fails the read, naming
the list page, the record and the field. In a POST body, write the body as a map, not as a JSON
string; a string JSON body with `{{ item.* }}` is refused at validation.

### 2. Make it incremental

Filter the list request on the watermark, and use an item field as the cursor:

```yaml title="connections.yml"
    order_lines:
      read:
        for_each:
          path: /orders
          query: { updated_since: "{{ watermark }}" }
          items: /data
          pagination: { strategy: cursor, param: cursor, pointer: /next_cursor }
          fields: { order_id: /id, updated_at: /updated_at }
        path: /orders/{{ item.order_id }}/lines
        items: /lines
        columns: { order_id: varchar, updated_at: timestamp, line_id: bigint, sku: varchar, qty: int }
        sync: { mode: incremental, cursor: updated_at }
```

Each run lists only the orders updated since the last run, and reads their lines.

On an incremental entity, `for_each.max_items`, `for_each.max_pages` and `max_pages` are refused
at validation: an order cut short would be skipped for good once the watermark passed it. On a
plain entity they work as caps, and the run prints a notice when one stops the read early.

### 3. Skip records that have disappeared

A record can be deleted between the list request and its item request. By default, the item's
`404` fails the read. To move on instead:

```yaml title="connections.yml"
        for_each:
          path: /orders
          items: /data
          fields: { order_id: /id }
          on_missing: skip
```

`on_missing: skip` skips an item whose first request returns `404` or `410`, and the run prints
one notice at the end with the count and the first skipped item. A `404` on a later page of an
item still fails.

Some APIs answer a missing or inaccessible record with another status. Add a rule to the entity's
`on_status`, which covers the item requests:

```yaml title="connections.yml"
    order_lines:
      read:
        for_each:
          path: /orders
          items: /data
          fields: { order_id: /id }
          on_missing: skip
          on_status:
            - { status: 5xx, body_contains: "maintenance", action: transient, retry_after: 2m }
        path: /orders/{{ item.order_id }}/lines
        items: /lines
        on_status:
          - { status: 403, body_contains: "order archived", action: skip }
```

An item whose first request matches the `skip` rule is skipped and counted in the same end notice
as `on_missing` skips. `for_each.on_status` covers the list request only, so the list keeps its own
rules; the two never inherit from each other. A `skip` rule is refused on an incremental entity
and with `columns:`, so this entity lands raw rows with a `pz_item` column. See
[Status rules](/connectors/http/#status-rules-on_status).

### 4. Land it into a merge sink

A retried read resumes at the item and page it reached. The list page is fetched again, and if
the list has shifted since (records added or removed before the checkpoint), that list page is
read again from its first record. Some rows can therefore land twice. Key the sink on the item
and record ids so a repeat replaces the row instead of duplicating it:

```yaml title="connections.yml"
warehouse:
  connector: duckdb
  path: warehouse.duckdb
```

```sql title="pipelines/order_lines.sql"
INSERT INTO {{ sink('warehouse', 'order_lines', strategy: 'merge', keys: ['order_id', 'line_id']) }}
SELECT order_id, updated_at, line_id, sku, qty
FROM {{ source('shop', 'order_lines') }}
```

### 5. Run several items at once

Item requests run one after another by default. For many small items, run several at a time and
pace the connection:

```yaml title="connections.yml"
shop:
  connector: http
  base_url: https://api.shop.example
  auth: { type: bearer, token: ${SHOP_TOKEN} }
  rate_limit:
    requests_per_minute: 600
    burst: 20
  entities:
    order_lines:
      read:
        for_each:
          path: /orders
          items: /data
          pagination: { strategy: cursor, param: cursor, pointer: /next_cursor }
          fields: { order_id: /id }
          concurrency: 8
        path: /orders/{{ item.order_id }}/lines
        items: /lines
        columns: { order_id: varchar, line_id: bigint, sku: varchar, qty: int }
```

With `concurrency: 8`, up to eight orders of one list page are read at once, and the next list
page is fetched once all of them have finished. What changes:

- Rows from different orders interleave; each order's own rows stay in order.
- Checkpoints are taken only between list pages, so a retry re-reads every item of the current
  list page.
- A `429` or `503` with `Retry-After` pauses every request of the read until that time, up to 600
  seconds.
- In file mode, each worker downloads into its own temporary file, so disk use can reach eight
  times one download.

`rate_limit:` keeps the read under the API's limit in the first place; the `Retry-After` pause
only reacts once the API has started refusing. See [Throttle a source](/how-to/throttle-a-source/).

### 6. Call the same endpoint for a fixed list

When the "list" is a handful of regions, accounts or metrics you already know, write it into the
YAML with `values` instead of a list request:

```yaml title="connections.yml"
    regional_sales:
      read:
        for_each:
          values:
            - { region: eu, currency: EUR }
            - { region: us, currency: USD }
            - { region: apac, currency: USD }
        path: /sales/{{ item.region }}
        query: { currency: "{{ item.currency }}", day: "{{ run_date }}" }
        run_date: { offset_days: -1 }
        items: /rows
        columns: { region: varchar, currency: varchar, sku: varchar, amount: decimal }
```

Each map is one item, and its keys are the item fields: every entry needs the same keys, and the
values are strings, numbers, booleans or null. `values` replaces the list request, so `path`,
`query`, `fields`, `pagination`, `max_items` and the other list keys are refused next to it.
`concurrency` and `on_missing` work as before. If you edit the list between a failure and its
retry, the retry starts again from the first value.

### 7. Skip duplicate list records

Some list endpoints repeat a record, for example when records shift between pages while you page
through them. `dedupe: true` reads each distinct item once:

```yaml title="connections.yml"
        for_each:
          path: /orders
          items: /data
          pagination: { strategy: page, size_param: per_page, size: 100 }
          fields: { order_id: /id }
          dedupe: true
```

A list record whose declared fields all equal an earlier record's is skipped, and one notice at the
end gives the count and the first duplicate. Fields compare as JSON values, so `"1"` and `1` are
different items. Duplicates do not count toward `max_items`. A retry that resumes mid-list may read
an item again that it saw on an earlier list page, so keep the merge sink from step 4. Memory grows
by roughly 30–60 bytes per distinct item.

### 8. Download a file per record

When the item request returns a file, add `file:` to the entity. This lists yesterday's exports
and downloads each one:

```yaml title="connections.yml"
    daily_exports:
      read:
        for_each:
          path: /exports
          query: { date: "{{ run_date }}" }
          items: /exports
          fields: { export_id: /id }
        run_date: { offset_days: -1 }
        path: /exports/{{ item.export_id }}/file
        file: { format: csv }
        columns: { export_id: varchar, account: varchar, amount: decimal }
```

`run_date:` stays at entity level and is shared by both requests. A file item checkpoints only
between items. See [Download files and exports from an API](/how-to/download-files-from-an-api/)
for the `file:` keys.

## Verify

```console
$ pz validate
$ pz run --all
```

`pz validate` refuses an unknown `{{ item.<name> }}`, a cap on an incremental entity, and a string
JSON body with item references, without calling the API. After the run, count rows per parent to
confirm every item landed:

```console
$ duckdb warehouse.duckdb -c "select order_id, count(*) from order_lines group by order_id limit 5"
```

## Troubleshooting

| If you see | Do |
|---|---|
| `unknown item field '...'` | The reference names a field not declared in `for_each.fields`. Add it there. |
| `item field '...' is missing from the record` | A list record lacks the field. Check the pointer in `fields` against a real list response. |
| `for_each on an incremental dataset cannot use max_items` | Remove the cap. An incremental `for_each` must read every item it lists. |
| `a string 'body' with a JSON content type cannot reference '{{ item.* }}'` | Rewrite the body as a YAML map. |
| `path cannot contain '?' or '#' in a for_each dataset` | Move query parameters from `path` into `query:`. |
| `pagination.concurrency is not supported with for_each` | Use `for_each.concurrency` instead. |
| A `404` failing the read on one item | The record was deleted after the list was read. Set `on_missing: skip`. |
| `for_each.<key> cannot be combined with for_each.values` | Remove the list-request keys; `values` is the list. |
| `action 'skip' is not allowed on a dataset that is or could be incremental` | A `skip` rule needs a non-incremental entity without `columns:`. Use `action: permanent` or `transient`, or `on_missing: skip` for `404`/`410`. |
| Duplicate rows after a retried run | Expected after a resume when the list shifted. Land into a `strategy: merge` sink keyed on the ids. |

## Related

- [HTTP connector reference](/connectors/http/#one-request-per-record-for_each): every
  `for_each` key and refusal.
- [Download files and exports from an API](/how-to/download-files-from-an-api/): `file:` items.
- [Throttle a source](/how-to/throttle-a-source/): `rate_limit:` for parallel items.
- [Incremental loads](/concepts/incremental-loads/): watermarks and merge sinks.
