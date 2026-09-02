---
title: "Run in CI"
description: "How to run a pz project on a schedule in GitHub Actions: install pz, restore connectors, validate, run, and handle exit codes and state."
sidebar:
  order: 12
---

This guide sets up a GitHub Actions workflow that installs `pz`, validates a project, and runs
it on a schedule. Read it once a project is ready to run unattended instead of from your own
machine.

## Prerequisites

- A `pz` project committed to the repository, including `pz.lock.json` if `project.yml` declares
  any non-builtin `connectors:`.
- Any credential the project needs, stored as a GitHub Actions secret.

## Steps

1. **Add a workflow file** that installs the .NET 10 SDK, installs `pz` as a global tool, and
   runs the project on a schedule:

   ```yaml title=".github/workflows/pz-run.yml"
   name: pz nightly run
   on:
     schedule:
       - cron: "0 3 * * *"
     workflow_dispatch:
   jobs:
     run:
       runs-on: ubuntu-latest
       env:
         DB_PASSWORD: ${{ secrets.DB_PASSWORD }}
       steps:
         - uses: actions/checkout@v4
         - uses: actions/setup-dotnet@v4
           with:
             dotnet-version: "10.0.x"
         - run: dotnet tool install --global pz
         - run: echo "$HOME/.dotnet/tools" >> "$GITHUB_PATH"
         - run: pz restore
         - run: pz validate
         - run: pz run --all --log-format json
   ```

   `--log-format json` emits NDJSON, one object per run event, which is easier to grep from a
   failed job's log than the interactive tree renderer. See [Run events](/reference/events/).

2. **Pass secrets as environment variables**, referenced from `connections.yml` with `${VAR}`:

   ```yaml
   # connections.yml
   warehouse:
     connector: sqlserver
     host: ${DB_HOST}
     database: sales
     user: ${DB_USER}
     password: ${DB_PASSWORD}
   ```

   Map each one from a GitHub Actions secret into the job's `env:`, as `DB_PASSWORD` is above. A
   variable `connections.yml` references but the job never sets fails validation with `PZ0103`
   before anything runs. See [Secure connection config](/how-to/secure-connection-config/).

3. **Run `pz restore` when `project.yml` declares `connectors:`.** It resolves those packages
   against the host feeds, materializes them under `.pz/packages`, and rewrites `pz.lock.json`.
   Commit `pz.lock.json` to the repository; `pz run` and `pz validate` refuse to start if it no
   longer matches `project.yml`'s declared connectors. `pz restore` is harmless to run even when
   the project declares no connectors at all.

   :::caution
   Don't reach for `--no-lock-check` in CI. It's a loud bypass, not a fix: it silences the exact
   drift check that catches an out-of-date `pz.lock.json` before it reaches a scheduled run.
   Regenerate the lock file with `pz restore` and commit it instead.
   :::

4. **Handle the exit code.** `pz run` exits `0` on full success, `1` when at least one node
   failed, `2` on a usage or configuration error, and `3` on a fatal engine error. GitHub Actions
   fails the step (and the job) on any non-zero exit automatically, so no extra handling is
   needed to get a red job on failure. See the [CLI reference](/reference/cli/#exit-codes) for
   the full table.

5. **Decide where state lives.** `.pz/` is created fresh in the runner's ephemeral workspace on
   every job, so watermarks, run results, and staging databases do not survive between runs
   unless you do something about it. Two options:

   - Point the project at a remote state store, following
     [Move state off the local disk](/how-to/remote-state/), so watermarks and run results live
     outside the runner entirely. This is the only option that also survives a runner OS change
     or a concurrent job.
   - Cache `.pz/state` (not `.pz/runs`, which holds a staging database you don't want to persist)
     with `actions/cache`, keyed on the repository and branch, so watermarks survive between
     scheduled runs on the same workflow. This only works for one workflow running at a time; two
     concurrent jobs racing on the same cache key will not merge cleanly.

## Verify

Trigger the workflow manually from the Actions tab (`workflow_dispatch`) and confirm the
`pz validate` step passes before `pz run` executes. A green job with `pz run --all` in its log
means the schedule is ready to run unattended.

## Troubleshooting

| If you see | Do |
|---|---|
| `pz validate` fails with `PZ0103` | A `connections.yml` variable has no matching `env:` entry in the workflow. Add the secret to the job's `env:` block. |
| `pz run`/`pz validate` refuses to start over a lock mismatch | `pz.lock.json` is out of date. Run `pz restore` locally and commit the result, rather than adding `--no-lock-check`. |
| The job exits `1` | At least one node failed at run time. Read the NDJSON log for the failing node's error, then re-run with `pz retry` locally or in a follow-up job. |
| The job exits `2` | A configuration or validation error. Nothing ran; fix the file and line the error names. |
| Watermarks reset to the beginning every run | `.pz/state` isn't persisted between jobs. Add remote state or an `actions/cache` step, per step 5 above. |

## Related

- [Move state off the local disk](/how-to/remote-state/): the durable alternative to a runner's ephemeral `.pz/` for watermarks and run results.
- [Secure connection config](/how-to/secure-connection-config/): getting a secret from the environment into `connections.yml`.
- [CLI reference](/reference/cli/): every flag and exit code used in the workflow.
- [Connectors](/concepts/connectors/): what `pz restore` and `pz.lock.json` do for non-builtin connectors.
- [Environment variables](/reference/environment-variables/): what `CI` and every other variable pz reads controls.
