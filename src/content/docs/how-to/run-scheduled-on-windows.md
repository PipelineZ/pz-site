---
title: "Run on a schedule on Windows"
description: "How to run a pz project nightly on a Windows host using Task Scheduler, tested on an Azure Windows VM."
sidebar:
  order: 13
---

This guide sets up an unattended, nightly `pz run` on a Windows host, using Task Scheduler and
a PowerShell wrapper. It was tested on an Azure Windows VM. Read it once you have a project that
runs correctly by hand and need it running on its own every night.

## Prerequisites

- The .NET 10 SDK installed on the host.
- For Azure SQL authentication, a managed identity attached to the VM. See
  [Secure connection config](/how-to/secure-connection-config/).
- A release bundle built from a dev machine (`scripts/make-release-bundle.sh` writes
  `artifacts/pz-bundle-<version>.zip`).

## Steps

1. **Install `pz` from the release bundle.** Copy the bundle to the VM, extract it anywhere, and run:

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\install.ps1
   ```

   This installs `pz.exe` to `C:\pz\tool` from the bundle's own offline feed, with no nuget.org
   egress. Pass `-ToolPath` to change the location. Upgrades use the same command with a newer
   bundle; to roll back to an older one, uninstall first with
   `dotnet tool uninstall pz --tool-path C:\pz\tool`, since `dotnet tool update` refuses downgrades.

   Keep the extracted bundle directory. For a project that declares non-builtin `connectors:`, set
   `PZ_FEEDS` (machine or user scope) to the bundle's `feed` directory, or pass
   `pz restore --feeds <dir>`, so `pz restore` also stays offline.

   :::note
   The package id was `Pz.Cli` through `0.2.1` and is `pz` from `0.2.2` on. `install.ps1` handles
   the transition by removing any `Pz.Cli` a pre-rename bundle left at the tool path before
   installing `pz`, since both packages claim the same `pz.exe` shim.
   :::

   :::note
   **Air-gapped Azure reads:** azureblob entities read through DuckDB's `azure` extension, which
   DuckDB fetches on first `INSTALL azure`. On a host with no outbound internet, pre-provision it
   by running one azure-reading flow while networked, or by copying DuckDB's extension directory
   (`%USERPROFILE%\.duckdb\extensions` on Windows) from a networked machine. There is no SDK
   fallback read path.
   :::

2. **Lay out projects, state, and logs on the persistent data disk**, not `C:`:

   ```
   D:\pz\projects\<name>\    # git clone of the project (config + SQL)
   D:\pz\logs\               # NDJSON run logs and per-run stderr logs
   ```

   `.pz\state\watermarks.json` holds incremental-load state, local by default. Inspect it with
   `pz state show`, and repair it with `pz state rollback` / `set` / `clear` rather than an
   editor. Back up `.pz\state\audit.jsonl` alongside it: it is the record of every manual change
   and stays local even on a project that moves everything else to a remote store. A VM is
   long-lived, so local state is the right default here; on an ephemeral host with no persistent
   disk between runs, move state into SQL Server instead. See
   [Move state off the local disk](/how-to/remote-state/).

   `.pz\runs\<id>\` holds per-run artifacts, including a staging DuckDB file. Automatic retention
   (`retention:` in `project.yml`, `keep_last: 10` by default) deletes the staging database from
   runs past that window at the end of every `pz run`, keeping every `run_results.json`. The run
   directories themselves still accumulate; use `pz clean --older-than 30d --purge` if that
   becomes a problem. It's safe to run alongside a live `pz run`, since a run holds an OS lock on
   its own directory and `pz clean` skips locked ones.

3. **Set the task's environment.** Prefer a Key Vault fetch inside the wrapper for secrets, per
   [Secure connection config](/how-to/secure-connection-config/). Set the OpenTelemetry endpoint
   if you're forwarding telemetry:

   ```powershell
   $env:PZ_OTEL_ENDPOINT = "http://127.0.0.1:4317"
   ```

4. **Copy the wrapper script and create the scheduled task.** The bundle ships `run-pz.ps1`
   (also in `scripts/bundle/`): it runs `pz run --all` for one project, captures stdout NDJSON to
   a dated `.ndjson` log in `D:\pz\logs` and stderr to a sibling `.stderr.log` (deleted when
   empty), prunes logs older than 30 days, and exits with pz's own exit code.

   ```powershell
   Copy-Item .\run-pz.ps1 C:\pz\
   ```

   ```console
   schtasks /Create /TN "pz nightly mart" /SC DAILY /ST 03:00 /RU SYSTEM ^
     /TR "powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\pz\run-pz.ps1 -ProjectDir D:\pz\projects\mart"
   ```

   `/RU SYSTEM` runs headless with no stored password. The VM's system-assigned managed identity
   is available to any account, including SYSTEM; prefer a gMSA over a password-bearing account if
   you need a specific service account.

   Schedule one project per task. Never schedule two tasks over the same project directory at
   overlapping times: there is no engine-level guard, and concurrent runs read-modify-write the
   shared `.pz\state\watermarks.json`, so the last writer silently clobbers the other's watermark
   advancement.

## Verify

1. Right-click the task, choose Run, and confirm the log file appears with its node stream ending
   in a `run_completed` event. A `retention_swept` event may follow it as the stream's actual last
   line. See [Run events](/reference/events/) for the full event contract.
2. Break something so the run fails at run time, for example by pointing an entity at a table that
   no longer exists upstream. Run again and confirm the task's "Last Run Result" shows exit `1`.
   Fix the break, then run `pz retry --project D:\pz\projects\<name>` from the project directory.

A typo inside a pipeline's SQL fails validation instead, exit `2`, with nothing run. Both paths
should be visible in the task's exit code, which is what proves the schedule works unattended.

## Troubleshooting

| If you see | Do |
|---|---|
| Exit `2` in Task Scheduler's "Last Run Result" | Read the log's first `error` lines: they carry `PZ####` codes naming the file and the fix. Nothing ran, so nothing needs cleanup. |
| Exit `1` | Run `pz retry --project D:\pz\projects\<name>` to re-run only the failed nodes, reusing staged data where safe. |
| Exit `3`, or no log file at all | A host-level problem: disk, identity, or the .NET runtime. Set up a missing-run alert, per [Observe runs with Azure Monitor](/how-to/observe-runs-with-azure-monitor/), to catch total silence. |
| Two tasks silently disagree on a watermark | You scheduled two tasks against the same project directory with overlapping windows. Reschedule so only one task ever runs against a given project at a time. |

## Related

- [Secure connection config](/how-to/secure-connection-config/): getting secrets into the task's environment without a stored password.
- [Move state off the local disk](/how-to/remote-state/): the alternative to local `.pz\state` for a host with no persistent disk.
- [Observe runs with Azure Monitor](/how-to/observe-runs-with-azure-monitor/): forwarding `PZ_OTEL_ENDPOINT` telemetry from this task to Application Insights.
- [CLI reference](/reference/cli/): every `pz` exit code and flag used in the wrapper.
- [Run events](/reference/events/): the NDJSON event stream the wrapper's log captures.
