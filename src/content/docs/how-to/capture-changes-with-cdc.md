---
title: "Capture changes with CDC"
description: "How to sync a Postgres or SQL Server table with sync: {mode: cdc}: server-side prerequisites, the YAML surface, what happens on the first run vs. every run..."
---

How to sync a Postgres or SQL Server table with `sync: {mode: cdc}`: server-side prerequisites,
the YAML surface, what happens on the first run vs. every run after, `pz cdc status`/`drop`, and
the retention tuning that keeps a quiet pipeline from losing changes.

CDC gives you deletes and updates without a reliable cursor column on the source table, at the
cost of a step of DBA setup — `pz` validates the server-side prerequisites and tells you the exact
statement to run; it never runs them for you. There is no streaming/daemon mode: each `pz run`
drains whatever changed since the last run's log position, then exits, riding the same
run-to-completion engine as every other dataset (see [Delivery
guarantees](/concepts/delivery-guarantees/)).

## Prerequisites

### Postgres

- PostgreSQL 14 or newer (pgoutput binary mode is a 14+ feature).
- `wal_level = logical`:

  ```sql
  ALTER SYSTEM SET wal_level = logical; -- then restart postgres
  ```

- The connecting role needs replication privilege:

  ```sql
  ALTER ROLE <user> REPLICATION;
  ```

- A publication covering the table — `pz` streams off exactly the publication named by the
  dataset's `publication:` option (default `pz_{source}`, sanitized):

  ```sql
  CREATE PUBLICATION pz_crm FOR TABLE public.orders;
  ```

  A `FOR ALL TABLES` publication also satisfies this. The publication must **not** declare a
  column list (`FOR TABLE t (id, name)`) — columns a column list omits never appear in the
  replication stream, and a merge would overwrite real data with nulls for them. Recreate the
  publication without a column list if you hit this refusal.

`pz run`/`pz cdc status` check all of the above on every open and report exactly which statement
is missing — see the copy-paste remediation text each check produces in
`PostgresCdc.ValidatePrerequisitesAsync`.

### SQL Server

- CDC enabled at the database level:

  ```sql
  EXEC sys.sp_cdc_enable_db;
  ```

- CDC enabled on the table:

  ```sql
  EXEC sys.sp_cdc_enable_table
    @source_schema = N'dbo', @source_name = N'orders', @role_name = NULL;
  ```

- SQL Server Agent running (the capture and cleanup jobs are agent jobs — in a container, set
  `MSSQL_AGENT_ENABLED=true`).

`pz` never runs `sp_cdc_enable_db`/`sp_cdc_enable_table` for you — enabling CDC is a schema change
the DBA makes deliberately.

## The YAML surface

A cdc-synced dataset declares `sync: {mode: cdc}` — no `cursor` (CDC needs no cursor column at
all):

```yaml
# connections.yml
crm:
  connector: postgres
  # ...host, credentials, connector options -- flat
  host: ${CRM_DB_HOST}
  database: crm
  user: ${CRM_DB_USER}
  password: ${CRM_DB_PASSWORD}
  entities:
    public.orders:                 # the key names the table; unqualified takes the connector
      read:
                                     # default schema (public for postgres, dbo for sqlserver)
        # publication: pz_crm        # postgres only; default pz_{source}
        # capture_instance: public_orders  # sqlserver only; default {schema}_{table}
        sync:
          mode: cdc
          # slot: pz_crm_orders      # postgres only; default pz_{source}_{dataset}
```

The output side declares `on_delete` on the receiving `write: {strategy: merge}` block — required
whenever a cdc-fed dataset feeds a merge output, because there is no safe default for how a
source-side delete should be applied:

```yaml
# connections.yml
lake:
  connector: postgres
  # ...host, credentials, connector options -- flat
  # ...host, credentials, connector options -- flat
```

```sql
-- the write options ride the sink() call in the pipeline that writes
INSERT INTO {{ sink('lake', 'public.orders_curated', strategy: 'merge', keys: ['id'], on_delete: 'delete') }}
```

- **`on_delete: delete`** — a deleted source row is physically `DELETE`d from the destination.
- **`on_delete: soft`** — the destination row is kept and stamped in a nullable `_pz_deleted_at`
  marker column (`timestamptz`/`datetime2`) instead of being removed. See [Soft delete and
  `schema_policy`](#soft-delete-and-schema_policy) below — this column has to exist, and adding it
  automatically depends on `schema_policy`.
- **`on_delete: ignore`** — deletes are not applied at all; the destination only ever gets inserts
  and updates. Useful for an append-style audit destination that should never lose rows the source
  no longer has, but it means the destination is not a faithful mirror of the source table anymore
  — see the [pairing matrix](/concepts/delivery-guarantees/#the-pairing-matrix).

Any read shape other than `merge` refuses a cdc-fed output outright (`PZ0335`) — `replace` would
discard rows outside the current window, and `append` would materialize raw change events (including
deletes) as if they were new rows. Declaring `on_delete` without an upstream `sync: {mode: cdc}`
dataset, or on a non-merge output, is `PZ0337`; a cdc-fed merge output with no `on_delete` at all is
`PZ0336`. A source connector that doesn't declare `ConnectorCapabilities.ChangeCapture` is `PZ0338`;
a sink connector that doesn't declare `ApplyDeletes` for a `delete`/`soft` output is `PZ0339`; a
cdc-fed merge output whose declared merge `keys:` are missing or null in the deletes relation is
`PZ0340`.

## First-run snapshot, then bounded polls

The **first run** (and any `--full-refresh`) takes a full snapshot of the table through a
consistent read — Postgres via an exported replication-slot snapshot, SQL Server via a plain
table read — and stamps every row with the change-row header columns
(`_pz_op = 'insert'`, an all-zeros `_pz_lsn`, a null `_pz_changed_at`) so the collapse below treats
a snapshot identically to a change window. The log position at the moment of the snapshot becomes
the resume token for every run after.

**Every subsequent run** polls the change source for everything since that token:

- **Postgres** opens a bounded pgoutput logical-replication stream from the confirmed slot
  position up to the WAL position captured at read start, stopping at the first commit reaching
  that target. A caught-up-but-target-unreached stream is bounded by an idle timer (`5s` default,
  tune with the dataset's `poll_idle_timeout` option, e.g. `poll_idle_timeout: 10s`).
- **SQL Server** reads `[@from, @to]` through `fn_cdc_get_all_changes_<capture_instance>` in one
  bounded `SELECT`, where `@to` is `sys.fn_cdc_get_max_lsn()` captured once at read start — no idle
  timer needed, since the whole window is read to completion in a single query.

Either way, the raw change rows land in `<staging>__changes`, then collapse to
last-event-per-key upserts in the canonical `<staging>` table plus a `<staging>__deletes` side
table of net-deleted keys — the counts of this collapse (`inserts`/`updates`/`deletes`, raw, never
net) and the new log position are reported on the `SourceLoad` node — see [Run
events](/events/#node_completed)'s `cdc` field and `run_results.json`'s `cdc` block.

**Replay semantics.** The log position only advances to `.pz/state/sync-state.json` after every
downstream sink has committed — the same commit-gated rule watermarks follow (see [Sync
state](/concepts/delivery-guarantees/#sync-state-another-commit-gated-state-kind)). A crashed
or failed run simply re-polls the same window next time; `pz retry` reuses the failed run's staged
canonical `<staging>` table and `<staging>__deletes` (the raw `__changes` window is never copied —
nothing downstream reads it, and the collapse already ran) exactly like it reuses any other
`SourceLoad`'s staging. The node's reported `rows` is this canonical, post-collapse count, not the
raw window total — that's what the copy-and-count-verify guard compares against.

### Key changes and `TRUNCATE`

An `UPDATE` that **changes a row's replica-identity key** is not one event downstream: the row has to
disappear under its old key and reappear under the new one. `pz` emits both — a `delete` for the old key
immediately followed by the `update` carrying the new row — so the collapse records the delete as the old
key's final event and the upsert as the new key's, and the merge target is left holding only the new key.
Getting this wrong is unrecoverable rather than merely stale: a merge never removes rows the source stops
mentioning, so an orphaned old key survives even a `--full-refresh`.

On Postgres this depends on the old key reaching the stream, which is what `REPLICA IDENTITY` controls:

- **`DEFAULT`/`USING INDEX`** (the common case — the primary key) sends the old key precisely when the key
  changed, so that message *is* the signal.
- **`FULL`** sends the whole old row on every update; `pz` compares the key columns and emits the delete
  only when they actually moved, so an ordinary edit does not manufacture a spurious delete.
- A table with **neither a primary key nor a replica-identity index** cannot report a key change at all —
  its updates land as plain upserts, and a changed key would orphan the old one. Give the table a primary
  key if its keys are mutable.

SQL Server needs none of this: its change tables already represent a key change as a delete/insert pair.

A **`TRUNCATE` fails the run.** Postgres reports it as a single table-level event with no per-row deletes,
so no set of change rows could leave the target matching the source. `pz` refuses rather than reporting a
green run over a target that still holds every dropped row.

Recovering takes two steps, and `--full-refresh` on its own is **not** one of them: a re-snapshot feeds the
merge an empty (or shrunken) row set, and [a merge never removes rows its input
omits](/concepts/delivery-guarantees/#the-pairing-matrix) — so the destination would keep every
truncated row and the run would go green over the same divergence. Empty the destination first, then
re-snapshot:

```sql
truncate table orders_curated;  -- the destination, in its own database
```

```bash
pz run --full-refresh
```

`pz` will not empty the destination for you: that is a destructive write on your target table, and which
rows deserve to go is your call, not the connector's.

SQL Server never reaches this — the server itself refuses `TRUNCATE` on a cdc-enabled table.

Both rules are scoped to the polled table. Under a `FOR ALL TABLES` publication every table in the
database streams down the same slot; `pz` matches each event against the dataset's own relation, so another
table's inserts, updates, deletes, and truncates are ignored rather than decoded into this dataset's
columns.

## `pz cdc status` and `pz cdc drop`

`pz cdc status` reports every cdc dataset's server-side state without touching any run data:

```
$ pz cdc status
dataset                      position             stored token         retained     health
crm.orders                   pz_crm_orders         000000180000A1B2    1048576      healthy
```

`position` is the slot name (Postgres) or capture instance (SQL Server); `stored token` is the log
position `pz` last committed to `.pz/state/sync-state.json`; `retained` is bytes of WAL/log still
held for this dataset (Postgres only; SQL Server always reports `-` since its retention is governed
by the cleanup job's window, not a queryable byte count). Exit code is `0` when every dataset is
healthy, `1` if any is unhealthy (a retention gap, a missing slot/capture instance, etc. — printed
as detail lines under the row).

`pz cdc drop <source>.<dataset>` tears down local + (where applicable) server-side state for
**exactly one** dataset (no bulk drop) and clears the stored token, so the next run re-snapshots:

```
$ pz cdc drop crm.orders
crm.orders: dropped replication slot 'pz_crm_orders' and cleared pz's local sync-state entry (the
next run will re-snapshot).
```

SQL Server's drop is local-only — `pz` never runs `sp_cdc_disable_table` (disabling CDC
server-side is the DBA's call) — it prints the exact statement instead:

```
$ pz cdc drop crm.orders
crm.orders: cleared pz's local sync-state entry (the next run will re-snapshot).
SQL Server cdc was NOT disabled server-side -- pz never runs sp_cdc_disable_table. To disable it
yourself:
  EXEC sys.sp_cdc_disable_table @source_schema = N'dbo', @source_name = N'orders', @capture_instance = N'dbo_orders';
```

## WAL retention and retention-gap tuning

Both engines discard old change data on their own schedule — a run that doesn't happen often
enough can find its resume point already gone. `pz` never silently skips the gap: it fails loud
with an error naming `--full-refresh` as the fix (which re-snapshots and restarts the token from
scratch). Sizing the retention window so your actual run cadence never hits this is an operational
concern outside `pz`:

- **Postgres**: a replication slot pins WAL on disk until `pz` confirms past it — an
  unbounded pause (project paused, host down) can grow WAL without limit. Set
  `max_slot_wal_keep_size` in `postgresql.conf` as the safety net: if a slot's retained WAL exceeds
  that size, Postgres invalidates the slot rather than filling the disk. An invalidated slot surfaces
  as a replication error when the next run polls for changes. Recover by running `pz cdc drop
  <source>.<dataset>` to clear the slot, then re-run with `--full-refresh` to re-snapshot.
- **SQL Server**: the CDC cleanup job prunes change tables on a retention window (`3` days by
  default). Widen it with:

  ```sql
  EXEC sys.sp_cdc_change_job @job_type = N'cleanup', @retention = 4320; -- minutes (here: 3 days -> 3 more)
  ```

  so the window comfortably covers the longest gap you expect between `pz run`s.

## Soft delete and `schema_policy`

`on_delete: soft` requires a nullable `_pz_deleted_at` column (`timestamptz` on Postgres,
`datetime2` on SQL Server) on the destination table. When the sink creates the table itself (first
run against a table that doesn't exist yet), the column is added automatically — nothing to do.

When the destination table **already exists** — the common case for an established target —
`schema_policy` decides what happens to a missing `_pz_deleted_at` column, the same way it governs
every other declared column:

- **`schema_policy: fail_on_change`** (the default) treats the missing column as drift and refuses
  to write, naming the column in the error. You either add it by hand or switch to `additive`.
- **`schema_policy: additive`** `ALTER TABLE ... ADD COLUMN _pz_deleted_at <type>`s it in for you,
  scoped to exactly this one soft-delete column (not general schema evolution — `evolve` is not
  supported by either sink in v0).

If you're turning on `on_delete: soft` against a pre-existing target and don't want to hand-edit
the schema, set `schema_policy: additive` on that output — or run the `ALTER TABLE` yourself and
keep `fail_on_change`.

## Base-table schema changes mid-capture (SQL Server)

`sp_cdc_enable_table` freezes the change function's row shape at the moment it runs — adding a
column to the base table afterward does not retroactively add it to
`fn_cdc_get_all_changes_<instance>`'s output. `pz`'s incremental read always projects the base
table's *current* columns, so a column added after capture was enabled makes the very next poll
fail loudly, naming the column, instead of silently reading a stale or partial shape:

```
dataset 'orders': sqlserver cdc failed: Invalid column name 'extra_col'.
```

Recover by disabling and re-enabling capture on the table (`sp_cdc_disable_table` then
`sp_cdc_enable_table`) so the change function picks up the new column shape, then `pz run
--full-refresh` to re-snapshot — a plain re-poll from the old token cannot recover the pre-change
column shape's history. Dropping a column from the base table does not hit this failure (the read
just stops selecting it), but the change function still captures the old shape underneath, so plan
schema changes around a capture re-enable either way rather than relying on partial support for one
direction and not the other.

## Next steps

- [Delivery guarantees](/concepts/delivery-guarantees/#the-pairing-matrix) — the (read shape ×
  write strategy) legality matrix `cdc` is a row of, and the `PZ0335`-`PZ0340` codes above.
- [Run events](/events/#node_completed) — the `cdc` field's full shape in
  `run_results.json`/NDJSON.
- [Run checks and retry failures](/how-to/run-checks-and-retry/) — how `pz retry` reuses a cdc
  `SourceLoad`'s staged canonical table and `__deletes` like any other.
