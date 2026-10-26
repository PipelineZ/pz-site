---
title: "Use a DuckDB extension"
description: "How to call a DuckDB extension's functions from pipeline SQL, and how to run that project on a machine without internet access."
sidebar:
  order: 20
---

DuckDB extensions add functions that pipeline SQL can call: geometry from `spatial`, or typed
judgments from the [Jev](https://duckdb.org/2026/09/29/jev) community extension. This guide lists one in
`project.yml`, calls it from a pipeline, and prepares a machine with no internet access to run the
same project.

## Prerequisites

- A `pz` project that already runs. Follow the [quickstart](/quickstart/) if you don't have one.
- The name of the extension, exactly as you would write it after DuckDB's `INSTALL`.

## Steps

1. **List the extension in `project.yml`:**

   ```yaml
   # project.yml
   extensions:
     - jev
   ```

   pz decides whether a name is a core extension or a community one. Before any SQL runs, in
   every session that runs or validates the project, it runs `INSTALL jev FROM community; LOAD jev;`
   (a core extension gets a plain `INSTALL`). List only the extensions your SQL calls; the ones
   connectors and file formats need are loaded by those connectors.

2. **Call its functions from a pipeline:**

   ```sql
   -- pipelines/angry_tickets.sql
   INSERT INTO {{ sink('lake', 'angry_tickets', strategy: 'replace', format: 'csv') }}
   select t.id, t.subject, jev_prob(t, 'the customer is angry') as p_angry
   from {{ source('raw', 'tickets') }} t
   where jev(t, 'the customer is angry')
   ```

   Don't write `INSTALL` or `LOAD` in a pipeline file: a pipeline is one query. Secrets stay out
   of `project.yml` too. Jev, for instance, reads its key from the `TYPESAFE_API_KEY` environment
   variable.

3. **Validate:**

   ```bash
   pz validate
   ```

   The first run downloads the extension into DuckDB's extensions folder. A name that cannot be
   installed or loaded is `PZ0402`. A function called from an extension you did not list fails
   the pre-run SQL check (`PZ0401`) with a hint to add it under `extensions:`.

## Run on a machine without internet access

pz never downloads an extension that is already in DuckDB's extensions folder, so an offline
machine needs the files copied there ahead of time:

1. **Find the folder.** It is `~/.duckdb/extensions/<duckdb version>/<platform>/` for the user
   pz runs as, for example `~/.duckdb/extensions/v1.5.6/linux_amd64/`. The quickest way to get the
   exact path is to run `pz validate` once on that machine: the `PZ0402` error names it.
2. **Download each file** on a machine with internet access, for the same DuckDB version and
   platform:
   - core: `http://extensions.duckdb.org/<version>/<platform>/<name>.duckdb_extension.gz`
   - community: `http://community-extensions.duckdb.org/<version>/<platform>/<name>.duckdb_extension.gz`
3. **Unzip and copy** each `<name>.duckdb_extension` into the folder. A few file names differ from
   the extension name (`sqlite` is `sqlite_scanner.duckdb_extension`); the `PZ0402` error names
   the file it wants.
4. **Copy the connectors' extensions as well.** Connectors that read cloud storage or other
   databases install extensions of their own (`httpfs` for S3 and GCS, `azure` for Azure Blob,
   `iceberg`, `sqlite`, and so on). The same folder covers them.
5. **Validate again.** `pz validate` passes without touching the network.

Each extension file works with one DuckDB version and one platform. After a pz upgrade that moves
DuckDB to a new version, copy the files again for the new version.

## Things to know

- **An extension runs inside pz.** It is native code with access to the run's data and
  credentials. A community extension can be published by anyone, so list one only if you trust it.
- **Extensions that call outside services still need the network.** Jev sends rows to TypeSafe's
  API on every call, so a machine without any internet access cannot use it, however the file got
  there.
- **Which build ran is recorded.** The terminal `run_results.json` lists each loaded extension and
  the build DuckDB reports for it, so a behaviour change can be traced to a new extension build.

## Related

- [project.yml reference](/reference/project-yml/#extensions): the `extensions:` key.
- [Error codes](/reference/error-codes/): `PZ0401` and `PZ0402`.
- [Inspect and validate](/how-to/inspect-and-validate/): `pz validate` and the pre-run checks.
