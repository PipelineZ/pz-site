---
title: "Capture changes with CDC"
description: "How to sync a Postgres or SQL Server table with sync: mode: cdc, from server-side setup through the first snapshot to pz cdc status."
sidebar:
  order: 2
---

This page shows how to sync a Postgres or SQL Server table with change data capture: server-side
setup, the `sync: mode: cdc` YAML, and how to check its health. Read it once you need deletes and
updates from a source with no reliable cursor column.

CDC needs a step of DBA setup pz never runs for you, but no daemon: each `pz run` drains whatever
changed since the last run and exits, like every other entity. See
[Incremental loads](/concepts/incremental-loads/#mode-cdc) for how `mode: cdc` fits among the
other sync modes.

## Prerequisites

**Postgres 14 or newer**, with:

```sql
ALTER SYSTEM SET wal_level = logical; -- then restart postgres
ALTER ROLE <user> REPLICATION;
CREATE PUBLICATION pz_crm FOR TABLE public.orders;
```

The publication must not declare a column list. A column a column list omits never reaches the
replication stream, and a merge would overwrite real data with nulls for it.

**SQL Server**, with:

```sql
EXEC sys.sp_cdc_enable_db;
EXEC sys.sp_cdc_enable_table
  @source_schema = N'dbo', @source_name = N'orders', @role_name = NULL;
```

SQL Server Agent must be running. In a container, set `MSSQL_AGENT_ENABLED=true`.

`pz` never runs these statements for you. Enabling CDC is a schema change the DBA makes
deliberately. `pz run` and `pz cdc status` check the prerequisites on every open and report
exactly which statement is missing.

## Steps

### 1. Declare the source entity

Add `sync: { mode: cdc }` under the entity's `read:` block. No `cursor:` is needed:

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
          # slot: pz_crm_orders          -- postgres only; default pz_{connection}_{entity}
          # publication: pz_crm          -- postgres only; default pz_{connection}
          # capture_instance: dbo_orders -- sqlserver only; default {schema}_{table}
```

### 2. Declare the merge sink with on_delete

A cdc-fed write must use `strategy: merge`. Any other strategy is refused at compile time
(`PZ0335`), since `replace` would discard rows outside the current window and `append` would
materialize raw change events, deletes included, as if they were new rows. `on_delete` says how a
source-side delete is applied, and it's required whenever CDC feeds a merge (`PZ0336`):

```sql title="pipelines/orders_curated.sql"
INSERT INTO {{ sink('lake', 'public.orders_curated', strategy: 'merge', keys: ['id'], on_delete: 'delete') }}
select * from {{ source('crm', 'public.orders') }}
```

| `on_delete` | Behavior |
|---|---|
| `delete` | The deleted source row is removed from the destination. |
| `soft` | The row stays, stamped in a nullable `_pz_deleted_at` column instead of being removed. |
| `ignore` | Deletes are not applied. The destination only ever gets inserts and updates. |

`on_delete: soft` needs a nullable `_pz_deleted_at` column on the destination. A sink creating the
table for the first time adds it automatically. On a pre-existing target, `schema_policy:
additive` adds it for you; the default `fail_on_change` refuses the write until you add it by
hand. See [Schema contracts](/concepts/schema-contracts/) for `schema_policy` in full.

### 3. Run it

The first run, and any `--full-refresh`, takes a full snapshot through a consistent read: an
exported replication-slot snapshot on Postgres, a plain table read on SQL Server. Every
subsequent run polls the change source from the log position the last run reached.

```console
$ pz run --all
ok src_crm__public_orders 4802 rows 1204ms
ok lake.public_orders_curated 4802 rows 340ms
run 20260902T091003118Z-6f2a: 2 succeeded, 0 failed, 0 skipped (.pz/runs/20260902T091003118Z-6f2a/run_results.json)
```

Later runs report only what changed. `pz` never streams continuously: it drains the window since
the last run's log position, then exits.

## Verify

```console
$ pz cdc status
dataset                      position             stored token         retained     health
crm.orders                   pz_crm_orders         000000180000A1B2    1048576      healthy
```

Exit code is `0` when every entity is healthy, `1` if any is unhealthy. `position` is the slot
name on Postgres or the capture instance on SQL Server. `retained` is bytes of WAL still held for
this entity on Postgres; SQL Server always reports `-`.

## Reset an entity's CDC state

`pz cdc drop <connection>.<entity>` tears down local and, where applicable, server-side state for
exactly one entity, so the next run re-snapshots:

```console
$ pz cdc drop crm.orders
crm.orders: dropped replication slot 'pz_crm_orders' and cleared pz's local sync-state entry
```

SQL Server's drop is local-only. `pz` never runs `sp_cdc_disable_table`, and prints the statement
to run by hand instead.

## Troubleshooting

| If you see | Do |
|---|---|
| `PZ0335` at compile time | A cdc-fed output declares a strategy other than `merge`. Change it to `strategy: merge`. |
| `PZ0336` at compile time | A cdc-fed merge output has no `on_delete`. Add `delete`, `soft`, or `ignore`. |
| `PZ0337` at compile time | `on_delete` is declared on an output that isn't CDC-fed, or its delete keys can't be routed through a multi-source pipeline. |
| `PZ0338` while running | The source connector doesn't support change capture, or its landed change rows are malformed. |
| A replication error polling for changes | The retained WAL exceeded `max_slot_wal_keep_size` and Postgres invalidated the slot. Run `pz cdc drop`, then `pz run --full-refresh`. |
| A run fails on a `TRUNCATE` | Postgres reports a `TRUNCATE` as one table-level event with no per-row deletes, so pz refuses to report a green run over rows that should have been removed. Empty the destination table by hand, then `pz run --full-refresh`. `--full-refresh` alone is not enough: a merge never removes rows its input omits. |
| `sqlserver cdc failed: Invalid column name '...'` | A column was added to the base table after `sp_cdc_enable_table` ran. Disable and re-enable capture on the table, then `pz run --full-refresh`. |

Widen SQL Server's cleanup retention window if runs happen less often than every 3 days:

```sql
EXEC sys.sp_cdc_change_job @job_type = N'cleanup', @retention = 4320; -- minutes
```

An update that changes a row's key needs the old key to reach the replication stream. On
Postgres, that depends on `REPLICA IDENTITY`: the default (primary key) sends the old key exactly
when it changes. A table with neither a primary key nor a replica identity index can't report a
key change at all, and a changed key orphans the old row. Give the table a primary key if its
keys are mutable.

## Related

- [Incremental loads](/concepts/incremental-loads/#mode-cdc): where `mode: cdc` sits among the
  other sync modes, and the full `strategy: merge` contract.
- [Schema contracts](/concepts/schema-contracts/): `schema_policy` and the `_pz_deleted_at`
  column `on_delete: soft` needs.
- [State](/concepts/state/): where CDC's log position lives and how `pz state` inspects it.
- [Debug a failed run](/how-to/debug-a-failed-run/): reading a failed CDC node's error and
  retrying it.
- [Run events reference](/reference/events/): the `cdc` field `node_completed` reports.
