---
title: "Contributing"
description: "This page is for people working on PipelineZ itself: the solution layout, build and test commands, Native AOT, release scripts, CI workflows, and the conventions worth stating up front."
sidebar:
  order: 7
---

This page is for people working on PipelineZ itself, not using it. It covers the solution
layout, how to build and test, Native AOT packaging, the release bundle scripts, what CI
actually runs, and the conventions worth stating up front. Users can skip it.

## Solution layout

```text
pz/
├── Pz.slnx                            # solution file (not .sln)
├── src/                                # 13 projects
│   ├── Pz.Cli/                         # dotnet tool; verbs, console renderers
│   ├── Pz.Core/                        # project model, compiler, DAG, validation
│   ├── Pz.Engine/                      # dispatcher, node executors, retries, artifacts
│   ├── Pz.DuckDb/                      # C-API interop: arrow ingest/export, queries
│   ├── Pz.PackageManagement/           # NuGet resolve, lock file, out-of-process connector host (PCP)
│   ├── Pz.Connectors.Abstractions/     # THE contract; references Apache.Arrow only
│   ├── Pz.Connectors.Protocol/         # generated gRPC/protobuf code for the PCP wire format
│   ├── Pz.Connectors.TestKit/          # acceptance suite for connector authors
│   ├── Pz.Connectors.Toolkit/          # shared mechanism for builtin connectors; not part of the ABI
│   ├── Pz.Diagnostics/                 # events, ActivitySource, meters, renderer glue
│   ├── Pz.Mcp/                         # the `pz mcp` server
│   ├── Pz.State.Http/                  # pluggable state backend over HTTP
│   └── Pz.State.SqlServer/             # pluggable state backend over SQL Server
├── connectors/                         # 10 first-party connectors: LocalFiles, Postgres, S3,
│                                        #   SqlServer, AzureBlob, Gcs, Http, MySql, Sqlite, Sftp
├── tests/                              # 24 test projects, one per src/connectors project, plus
│                                        #   Pz.EndToEnd.Tests (Testcontainers) and Pz.Benchmarks
│                                        #   (BenchmarkDotNet); Pz.TestSupport holds shared utilities
├── rust/                               # pz-connector: Rust SDK for out-of-process sink connectors
├── templates/                          # `pz init`'s five built-in starting points; real,
│                                        #   in-place-runnable projects, embedded into Pz.Cli
│                                        #   and bound to TemplateCatalog by set-equality tests
├── samples/                            # golden-file projects; double as docs
└── scripts/                            # build, packaging, and verification scripts
```

Dependency direction is strictly downward, with `Pz.Connectors.Abstractions` at the bottom
carrying near-zero dependencies: it references `Apache.Arrow` and the BCL only, and nothing
else in the repository depends on that restriction being loosened. `Pz.DuckDb` isolates the
riskiest code (native interop) behind an interface the engine consumes. Target: current LTS
(`net10.0`), C# latest, `Nullable` enabled, `TreatWarningsAsErrors` on every project
(`Directory.Build.props`).

## Build and test

Requires the .NET 10 SDK. Docker is optional: suites that need Postgres or MinIO
(Testcontainers) use `Xunit.SkippableFact` and skip cleanly without it
(`tests/Pz.TestSupport/DockerFacts.cs`).

```bash
dotnet build Pz.slnx -c Release            # zero warnings required (TreatWarningsAsErrors)
dotnet test Pz.slnx -c Release --no-build  # zero failures required (skips OK without docker)

# Single project / single test
dotnet test tests/Pz.Core.Tests -c Release
dotnet test tests/Pz.Engine.Tests -c Release --filter "FullyQualifiedName~Watermark"
```

`PZ_TESTS_OFFLINE=1` skips network-dependent tests. Benchmarks live in `tests/Pz.Benchmarks`
(BenchmarkDotNet) plus `scripts/macro-bench.sh` and its per-connector variants
(`macro-bench-s3.sh`, `macro-bench-postgres.sh`, `macro-bench-mssql.sh`,
`macro-bench-azureblob.sh`).

No direct pushes to `main`; land changes through a PR, and CI must be green.

## Native AOT

`Pz.Cli` publishes as **Native AOT**: hybrid RID-specific tool packaging, with a `pz.<rid>` AOT
sub-package per platform (`linux-x64`, `linux-arm64`, `win-x64`, `osx-arm64`) plus a CoreCLR
`pz.any` fallback, with a pointer package `pz` that resolves to the right one. Set
`<PublishAot>true</PublishAot>` in `Pz.Cli.csproj`, guarded per RID.

First-party code stays at zero trim/AOT warnings: the analyzers error on any. Third-party
assemblies whose internals do warn (NuGet client libraries, Newtonsoft.Json,
`Microsoft.Data.SqlClient`, DuckDB.NET, the Google Cloud Storage stack) are rooted via
`TrimmerRootAssembly` and proven safe at runtime instead of at compile time, since the trim
analyzer can only prove what it can see statically:

```bash
scripts/verify-aot.sh   # publish the native image, then drive init/run/restore/PZ0360/PCP-spawn/mcp against it
```

`verify-aot.sh` publishes the Linux native binary and exercises every path that crosses a
rooted assembly: `pz init` and `pz run` (Scriban, YamlDotNet, DuckDB.NET Arrow interop, CSV
and Parquet I/O), `pz restore` against a local feed (NuGet client libraries), a `PZ0360`
refusal after that restore (a clean coded error, not an AOT crash), `pz connectors` spawning a
PCP fixture (gRPC/protobuf over a Unix domain socket), a GCS sink attempt (the Google stack),
and `pz mcp`'s stdio handshake. It's Linux-only, since the PCP fixture serves Unix domain
sockets and AOT can't cross-compile between operating systems anyway. It's also a required PR
gate; see CI, below.

## Release bundle scripts

- `scripts/make-release-bundle.sh [output-dir]` builds and packs the whole solution in
  Release, then zips an offline install bundle for a machine with no `nuget.org` access: a
  local NuGet feed plus the VM-side install scripts, using the same pack-to-local-feed recipe
  `verify-tool-install.sh` proves.
- `scripts/verify-tool-install.sh` is the packaging end-to-end proof: pack, install as a
  local tool, `pz init`, `pz init --template sample`, `pz run`, fully offline. Run it after
  touching `src/Pz.Cli`, `templates/`, or any packable project's `.csproj`.
- `scripts/verify-release-bundle.sh` verifies an already-built bundle installs and runs
  correctly on its own, independent of the packing step.
- `scripts/rust-conformance.sh` builds the Rust SDK example connector and runs it through the
  PCP conformance checks against the .NET host, proving the boundary between the two.

## CI workflows

`.github/workflows/ci.yml` runs on every push to `main`/`feat/**` and every pull request, with
four jobs:

| Job | Runs on | Does |
|---|---|---|
| `build-test` | ubuntu + windows matrix | Both legs build (cross-platform compile safety); only the ubuntu leg runs `dotnet test`, with `PZ_TESTS_OFFLINE=1` and a 10-minute per-suite hang timeout that dumps thread stacks on a stall. Windows stays build-only because its Docker daemon can't pull the Linux images the Testcontainers suites need. |
| `pack-and-verify` | ubuntu | Runs `scripts/verify-tool-install.sh` and `scripts/make-release-bundle.sh`, so the install path a stranger's first five commands depend on can't silently rot. |
| `verify-aot` | ubuntu | Runs `scripts/verify-aot.sh`, the Native AOT runtime proof described above. |
| `rust` | ubuntu | `cargo fmt --check`, `cargo clippy -D warnings`, `cargo test` over `rust/`, then `scripts/rust-conformance.sh` against the .NET host. |

`.github/workflows/release.yml` is tag-triggered (`push: tags: ['v*']`). MinVer computes every
packable project's version from the tag. Because Native AOT can't cross-compile between
operating systems, one `pack-aot` job per platform builds that platform's RID sub-package, and
a `release` job builds, tests, and packs everything else, then pushes every package to
nuget.org via trusted publishing (OIDC), sub-packages before the `pz` pointer package, since
the .NET CLI resolves an install through the pointer and needs every referenced sub-package to
already exist.

## Doc link check

`scripts/check-doc-links.sh` walks every markdown file in this repository (the root `README`,
`docs/`, `connectors/`, `samples/`, `scripts/`, `.github/`) and confirms every relative link
target actually exists on disk, stripping anchors and skipping external URLs. It exits nonzero
and lists offenders on a break. This checks the `pz` repository's own markdown, not the
`pz-site` documentation you're reading now.

## Conventions worth stating

- **Fail loudly.** Every user-facing error carries a `PZ####` code and names the file or node,
  the cause, and a next step. Validation reports all errors it finds, never stopping at the
  first one. There are no silent failures.
- **"Dispatch", never "scheduler".** Within-run dependency-ordered dispatch is
  `RunOrchestrator` in `Pz.Engine.Dispatch`. "Scheduler" reads as cron or Airflow to a data
  engineer, which `pz` deliberately is not. Reserve it for genuinely external triggering.
  Two deliberate exceptions: the `RetryScheduled`/`retry_scheduled` event name, and "no
  orchestration/scheduling" in the v1 non-goals.
- **`Pz.Connectors.Abstractions` depends on `Apache.Arrow` only.** That allowlist is fixed.
  ABI growth is additive-only: no `ISourceConnector2`-style interfaces, only new optional
  capability interfaces and new `ConnectorCapabilities` flags.
- **Determinism.** Byte-stable writers (LF line endings, a final newline, explicit ordering)
  for every `.pz` artifact. Golden-file tests snapshot-compare compile output; a golden change
  must be sanctioned and explained line by line in review. No `DateTime.Now`-style
  nondeterminism; time goes through an injectable `TimeProvider`.
- **Comments state the constraint, not its provenance.** Write the rule a reader needs, in
  terms that stand on their own: why an ordering is load-bearing, who owns an Arrow batch,
  which quoting rule a dialect requires. Never cite a document outside this repository.
- **Tests**: plain `Assert.*` (xunit, no FluentAssertions). Docker suites skip, never fail,
  without Docker. No test sleeps on the wall clock.

## Related

- [Architecture](/internals/architecture/): the layering these projects follow.
- [Execution internals](/internals/execution-internals/): what `Pz.Core` and `Pz.Engine` actually do.
- [Connector architecture](/internals/connector-architecture/): the ABI `Pz.Connectors.Abstractions` defines.
- [Code tour](/internals/code-tour/): a walk through the codebase for a new contributor.
