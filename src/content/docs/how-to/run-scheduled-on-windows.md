---
title: "Run scheduled on Windows"
description: "Production recipe for running pz projects nightly on a Windows host (tested on an Azure Windows VM). Prerequisites: .NET 10 SDK installed; for Azure SQL..."
---

Production recipe for running pz projects nightly on a Windows host (tested on an Azure
Windows VM). Prerequisites: .NET 10 SDK installed; for Azure SQL auth, the VM has a
managed identity (see [secure connection config](/how-to/secure-connection-config/)).

## 1. Install from the release bundle

Build the bundle on a dev machine and copy it over:

```console
scripts/make-release-bundle.sh          # writes artifacts/pz-bundle-<version>.zip
```

On the VM, extract it anywhere and run:

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

This installs `pz.exe` to `C:\pz\tool` from the bundle's own offline feed (no nuget.org
egress; pass `-ToolPath` to change the location). Upgrades use the same command with a
newer bundle. Keep the extracted bundle directory: for projects that declare non-builtin
`connectors:`, set `PZ_FEEDS` (machine or user scope) to the bundle's `feed` directory, or
pass `pz restore --feeds <dir>`, so `pz restore` also stays offline. To roll back to an older bundle, uninstall first (`dotnet tool
uninstall pz --tool-path C:\pz\tool`) — `dotnet tool update` refuses downgrades.

> [!NOTE]
> The package id was `Pz.Cli` up to and including `0.2.x`, and is `pz` from the rename on.
> `install.ps1` handles the transition: it removes any `Pz.Cli` a pre-rename bundle left at
> the tool path before installing `pz`, because both packages claim the same `pz.exe` shim
> and the install would otherwise fail on that collision. Rolling back to a pre-rename
> bundle works the same way in reverse — uninstall `pz` first.

> [!NOTE]
> **Air-gapped azure reads:** azure datasets read through DuckDB's `azure` extension, which
> DuckDB fetches on first `INSTALL azure`. On a host without outbound internet, pre-provision
> it (run one azure-reading flow while networked, or copy DuckDB's extension directory from a
> networked machine — `%USERPROFILE%\.duckdb\extensions` on Windows; pz does not override
> `extension_directory`) — there is no SDK fallback read path.

## 2. Lay out projects, state, and logs on the data disk

Keep everything that must survive OS servicing on the persistent data disk (not `C:`):

```
D:\pz\projects\<name>\    # git clone of the project (config + SQL)
D:\pz\logs\               # NDJSON run logs and per-run stderr logs (written by run-pz.ps1)
```

Two pieces of state matter inside each project directory:

- `.pz\state\watermarks.json` — incremental-load state, local by default. Inspect it with
  `pz state show`, and repair it with `pz state rollback` / `set` / `clear` rather than an
  editor. Losing it forces a full re-extract (merge/replace sinks stay correct; append sinks
  would duplicate) — back it up if that matters: a nightly `Copy-Item` to blob/another disk
  is sufficient at this stage. Back up `.pz\state\audit.jsonl` alongside it too: that is the
  record of every manual change, and it stays local even on a project that moves everything
  else to a remote store. A VM is long-lived, so local state is the right default here; on an
  ephemeral host (no persistent disk between runs) move state into SQL Server instead — see
  [Move state off the local disk](/how-to/remote-state/).
- `.pz\runs\<id>\` — per-run artifacts including a staging DuckDB file. Automatic retention
  (`retention:` in `project.yml`, on by default at `keep_last: 10`) deletes the staging DB
  from runs past that window at the end of every `pz run`, keeping every `run_results.json`
  and leaving `pz retry` able to reuse the newest run's staged data — no wrapper changes
  needed. The run directories themselves still accumulate; use
  [`pz clean --older-than 30d --purge`](/reference/cli/) if that becomes a problem. It
  is safe to run alongside a live `pz run`: a run holds an OS lock on its own directory, and
  `pz clean` skips locked ones.

## 3. Configure the task's environment

Set what the run needs in the environment the task will see (secrets: prefer a Key Vault
fetch inside the wrapper — see [secure connection config](/how-to/secure-connection-config/)):

```powershell
PZ_OTEL_ENDPOINT=http://127.0.0.1:4317   # see the Azure Monitor how-to
```

## 4. Create the scheduled task

The bundle ships `run-pz.ps1` (also in `scripts/bundle/`): it runs `pz run --all` for one
project, capturing stdout NDJSON to a dated `.ndjson` log in `D:\pz\logs` and stderr to a
sibling `.stderr.log` (deleted when empty), prunes logs older than 30 days (both patterns),
and exits with pz's own exit code (0 ok, 1 node failures, 2 config, 3 fatal — or 3 from
the wrapper itself if pz.exe is missing or fails to start). Copy
it from the extracted bundle to a stable path first:

```powershell
Copy-Item .\run-pz.ps1 C:\pz\
```

Then create the scheduled task:

```console
schtasks /Create /TN "pz nightly mart" /SC DAILY /ST 03:00 /RU SYSTEM ^
  /TR "powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\pz\run-pz.ps1 -ProjectDir D:\pz\projects\mart"
```

Notes:

- `/RU SYSTEM` runs headless without a stored password; the VM's **system-assigned managed
  identity** is available to any account, including SYSTEM. If you need a specific service
  account, prefer a gMSA over a password-bearing account.
- One project per task. Never schedule two tasks over the SAME project directory at
  overlapping times — there is no engine-level guard: concurrent runs read-modify-write
  the shared `.pz\state\watermarks.json`, so the last writer silently clobbers the
  other's watermark advancement.
- The task's "Last Run Result" shows pz's exit code; `0x1` = some nodes failed (check the
  log and Azure Monitor, then run `pz retry` in the project directory).

## 5. Verify end to end

1. Right-click the task > Run; confirm the log file appears and its node stream ends with a
   `run_completed` event (a `retention_swept` event may follow it as the stream's actual
   last line — see `docs/events.md`).
2. Check Application Insights for the `pz.run.completed` metric (status `success`).
3. Break something so the run fails at RUNTIME — e.g. point a source dataset's name
   at a table that no longer exists upstream — run again, and confirm the failure alert
   fires (nodes fail, exit 1, `pz.run.completed` reports `completed_with_failures`).
   Note: a typo inside a pipeline's SQL fails validation instead (exit 2, nothing runs,
   no metric) — that path is caught by the exit code in Task Scheduler, not by the
   metric alert. Fix, then `pz retry` from the project directory.

That third step passing is what proves the whole path works unattended.

## When it breaks

- `pz` exit 2 (config): the log's first `error` lines carry `PZ####` codes naming file and
  fix; nothing ran, nothing to clean up.
- Exit 1 (node failures): `pz retry --project D:\pz\projects\<name>` re-runs only what
  failed, reusing staged data where safe.
- Exit 3 / no log at all: host-level problem (disk, identity, .NET). The
  missing-run alert from the Azure Monitor how-to is what catches total silence.
