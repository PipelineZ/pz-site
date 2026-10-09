---
title: "Change data capture without a daemon"
description: "A cursor column can't see a deleted row. mode: cdc reads the source's own change log instead, one bounded drain per pz run, with no replication service left running in between."
date: 2026-10-09
heroImage:
  dark: ./hero-dark.svg
  light: ./hero-light.svg
  alt: "The words Change data capture, above a yellow change-log line dotted with events, one window of it bracketed and rising into a pipeline terminal."
---

An incremental read asks one question every run: which rows have a cursor value past the last
one I saw? That covers new rows and, if the table keeps an honest `updated_at`, changed ones. It
can never cover a deleted row, because a deleted row has no cursor value left to compare. The
destination keeps it forever, and nothing in the run says anything is wrong.

Change data capture answers a different question: what did the source itself record as having
happened? pz reads that from the database's own change log with `mode: cdc`, and it does it
without the usual cost of CDC, a long-running replication service you now have to operate.

## What a cursor can't see

| | `mode: incremental` | `mode: cdc` |
|---|---|---|
| Reads | Rows past a stored cursor value | The source's change log since a stored log position |
| Inserts and updates | Yes, if the cursor column is reliable | Yes |
| Deletes | Never | Yes |
| Server-side setup | None | A publication and slot, or a capture instance |
| Needs a `cursor:` column | Yes | No |

That last row matters as much as the deletes. Plenty of source tables have no trustworthy
"last modified" column at all, and CDC doesn't need one.

## Reading the source's own log

Two builtin connectors support it today. On **Postgres** (14 or newer), pz reads a
logical-replication publication through a replication slot. On **SQL Server**, it reads the
server's own change tables through a capture instance. Either way, the entity just says so:

```yaml title="connections.yml"
crm:
  connector: postgres
  host: ${CRM_DB_HOST}
  database: crm
  user: ${CRM_DB_USER}
  password: ${CRM_DB_PASSWORD}
  entities:
    public.orders:
      read:
        sync:
          mode: cdc
```

The slot, publication, and capture instance all have defaults derived from the connection and
entity names, so most entities need nothing more than that.

What pz will not do is turn CDC on for you. Setting `wal_level = logical`, creating a
publication, or running `sp_cdc_enable_table` is a schema change, and a DBA should make it on
purpose. pz checks the prerequisites every time it opens the source and, when one is missing,
reports exactly which statement still needs to run.

## No daemon, just a run

Most CDC setups mean a process that sits on the replication stream around the clock. pz doesn't
do that. A `pz run` on a cdc entity drains whatever changed since the last run's log position,
lands it, and exits, exactly like every other entity in the project. Whatever already schedules
your runs schedules your CDC too.

The very first run, and any `--full-refresh`, takes a full snapshot instead: through an exported
replication-slot snapshot on Postgres, so the snapshot and the change stream that follows it line
up exactly, and through a plain table read on SQL Server. From then on, each run only reports
what changed:

```console
$ pz run --all
ok src_crm__public_orders 4802 rows 1204ms
ok lake.public_orders_curated 4802 rows 340ms
run 20260902T091003118Z-6f2a: 2 succeeded, 0 failed, 0 skipped (.pz/runs/20260902T091003118Z-6f2a/run_results.json)
```

The log position is state like any watermark, so it lives in the same state store and only
advances once the run's writes have committed.

## A delete has to land somewhere

Capturing a delete is only half the job; the sink has to know what to do with it. pz makes both
halves explicit at compile time rather than leaving them to luck.

A cdc-fed write must use `strategy: merge`. Anything else is refused (`PZ0335`): `replace` would
throw away every row outside the current change window, and `append` would land raw change
events, deletes included, as if they were brand new rows. And the merge must say what a delete
means, with `on_delete` (`PZ0336` if it's missing):

```sql title="pipelines/orders_curated.sql"
INSERT INTO {{ sink('lake', 'public.orders_curated', strategy: 'merge', keys: ['id'], on_delete: 'delete') }}
SELECT * FROM {{ source('crm', 'public.orders') }}
```

| `on_delete` | What a source-side delete does |
|---|---|
| `delete` | Removes the row from the destination. |
| `soft` | Keeps the row and stamps a nullable `_pz_deleted_at` column. |
| `ignore` | Nothing. The destination only ever sees inserts and updates. |

`soft` is the one to pick when a downstream report needs to know a row existed and then went
away. A sink creating the table adds `_pz_deleted_at` itself; on an existing table,
`schema_policy: additive` adds it for you.

## Knowing it's still healthy

CDC can break quietly between runs: a slot gets invalidated, a retention window passes, someone
drops a capture instance. `pz cdc status` reports on every cdc entity in the project and exits
`1` if any of them is unhealthy, so it slots straight into a health check:

```console
$ pz cdc status
dataset                      position             stored token         retained     health
crm.orders                   pz_crm_orders         000000180000A1B2    1048576      healthy
```

On Postgres, `retained` is the WAL the slot is still holding on the server, which is the number
to watch if runs ever stop: an abandoned slot keeps WAL around until something gives.

When an entity's CDC state needs a clean restart, `pz cdc drop crm.orders` tears it down for
exactly that one entity, so its next run re-snapshots. On Postgres that drops the replication
slot. On SQL Server, pz clears its own state only and prints the `sp_cdc_disable_table`
statement for you to run, for the same reason it never enabled CDC in the first place.

As of v0.8.0, both commands are built for platforms as well as people. `--log-format json`
writes one NDJSON `cdc_status` event per entity, or a `cdc_dropped` event for a drop, and
`--state-url` points them at the same remote state store a platform's runs already use. `pz cdc
drop` also accepts a schema-qualified entity now, so a SQL Server dataset like
`erp.dbo.orders` can be dropped exactly as `pz cdc status` names it.

## The sharp edges, written down

A source's change log has rules of its own, and pz would rather fail loudly than land a
destination that quietly disagrees with its source:

- **A Postgres `TRUNCATE`** arrives as one table-level event with no per-row deletes, so the
  run fails instead of reporting green over rows that should be gone.
- **A slot past `max_slot_wal_keep_size`** gets invalidated by Postgres. `pz cdc drop` and a
  `--full-refresh` recover it.
- **SQL Server's cleanup job** discards change rows after 3 days by default. If runs happen less
  often than that, widen its retention.
- **A column added after `sp_cdc_enable_table`** isn't in the capture instance. Re-enable
  capture on the table, then `--full-refresh`.

Each one has its exact remedy in the troubleshooting table of the how-to.

## Try it

[Capture changes with CDC](/how-to/capture-changes-with-cdc/) walks the whole path, from the
server-side setup for both databases through the first snapshot and `pz cdc status`. For where
`mode: cdc` sits next to cursors, bounded windows, and connector-managed tokens, see
[Incremental loads](/concepts/incremental-loads/#mode-cdc), and the
[`pz cdc` reference](/reference/cli/#pz-cdc) covers every option on both commands.
