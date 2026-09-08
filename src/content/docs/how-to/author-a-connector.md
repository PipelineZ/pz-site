---
title: "Author a connector"
description: "How to build, test, and package a pz connector: implement the ABI, declare its capabilities, run the conformance suite, and declare it in a project."
sidebar:
  order: 17
---

This guide walks through building, testing, and packaging a `pz` [connector](/concepts/connectors/):
a source and/or sink implementation, plus the manifest handshake that lets `pz` reject an
incompatible package before running any of its code. Read it if you need `pz` to read from or
write to a system none of the fifteen builtin connectors cover.

:::note
`pz`'s fifteen builtin connectors (`localfiles`, `postgres`, `s3`, `sqlserver`, `azureblob`,
`gcs`, `http`, `mysql`, `sqlite`, `duckdb`, `ducklake`, `motherduck`, `quack`, `iceberg`, `sftp`)
are compiled directly into the CLI from the `pz` repository:
there is no plugin-loading step, and no isolation boundary, for them. Every other, genuinely
external connector must instead run out of process, speaking the PCP wire protocol, because pz
refuses to load external connector code in-process. The ABI this guide walks through, and the
conformance suite that enforces it, are exactly what an out-of-process connector's implementation
is checked against under the hood. Two SDKs serve the out-of-process side: `Pz.Connectors.Sdk`
for C# (see [C# SDK](#c-sdk) below) and the `pz-connector` crate for Rust
([Rust SDK](#rust-sdk)). The full protocol, hosting model, and capability semantics are in
[Connector architecture](/internals/connector-architecture/).
:::

## Prerequisites

- The .NET 10 SDK.
- Familiarity with pz's [connector](/concepts/connectors/) vocabulary: connection, entity,
  builtin versus third-party, native versus universal tier.
- Know which side you're building. A **source** reads into the [staging database](/concepts/key-concepts/);
  a **sink** writes out of it. A connector may implement one or both.

## Steps

1. **Set up the project.** A connector is an ordinary .NET class library that references
   `Pz.Connectors.Abstractions`:

   ```xml title="MyCompany.Pz.Connector.MySource.csproj"
   <Project Sdk="Microsoft.NET.Sdk">
     <PropertyGroup>
       <TargetFramework>net10.0</TargetFramework>
     </PropertyGroup>
     <ItemGroup>
       <PackageReference Include="Pz.Connectors.Abstractions" Version="x.y.z" />
     </ItemGroup>
   </Project>
   ```

   Pin `x.y.z` to the version published alongside the `pz` build you're targeting: the manifest
   step below is what catches a mismatch before any of your code runs.

   Every connector implements the shared `IConnector` surface both `ISourceConnector` and
   `ISinkConnector` extend: `Info` (a name, version, and the protocol major it speaks),
   `Capabilities`, two JSON Schema strings (`ConnectionConfigSchema` and `DatasetConfigSchema`)
   that let the CLI validate a project's YAML against your connector offline, `ValidateAsync` for
   offline cross-field checks, and `CheckConnectionAsync` for a live connectivity probe.

2. **Implement a minimal source.** Implement `ISourceConnector` and mark your entry point with
   the assembly attribute the host looks for:

   ```csharp title="SourceConnector.cs"
   [assembly: PzConnector("mysource", typeof(MySourceConnector))]

   public sealed class MySourceConnector : ISourceConnector
   {
       public ConnectorInfo Info => new("mysource", "1.0.0", ProtocolVersion.Major);
       public ConnectorCapabilities Capabilities => ConnectorCapabilities.None;
       public string ConnectionConfigSchema => "{}";
       public string DatasetConfigSchema => "{}";

       public ValueTask<ValidationResult> ValidateAsync(ConnectorConfig config, CancellationToken ct)
           => ValueTask.FromResult(ValidationResult.Success);

       public ValueTask<ConnectionCheck> CheckConnectionAsync(ConnectorConfig config, CancellationToken ct)
           => ValueTask.FromResult(new ConnectionCheck(true));

       public ValueTask<ISource> OpenAsync(ConnectorConfig config, CancellationToken ct)
           => ValueTask.FromResult<ISource>(new Source());
       // Source implements ISource: GetSchemaAsync, TryGetNativeScan, PlanReadAsync.
   }
   ```

   `ISource.PlanReadAsync` returns one or more `IDatasetPartition`s, each yielding Arrow
   `RecordBatch`es from `ReadAsync`. The full `ISource`/`IDatasetPartition` surface is in
   [Connector architecture](/internals/connector-architecture/#the-abi-surface).

3. **Implement a minimal sink**, the same way, against `ISinkConnector`:

   ```csharp title="SinkConnector.cs"
   [assembly: PzConnector("mysink", typeof(MySinkConnector))]

   public sealed class MySinkConnector : ISinkConnector
   {
       public ConnectorInfo Info => new("mysink", "1.0.0", ProtocolVersion.Major);
       public ConnectorCapabilities Capabilities => ConnectorCapabilities.None;
       public string ConnectionConfigSchema => "{}";
       public string DatasetConfigSchema => "{}";

       public ValueTask<ValidationResult> ValidateAsync(ConnectorConfig config, CancellationToken ct)
           => ValueTask.FromResult(ValidationResult.Success);

       public ValueTask<ConnectionCheck> CheckConnectionAsync(ConnectorConfig config, CancellationToken ct)
           => ValueTask.FromResult(new ConnectionCheck(true));

       public ValueTask<ISink> OpenAsync(ConnectorConfig config, CancellationToken ct)
           => ValueTask.FromResult<ISink>(new Sink());
       // Sink implements ISink: TryGetNativeCopy, BeginWriteAsync.
   }
   ```

   `ISink.BeginWriteAsync` returns an `ISinkWriteSession`, which receives batches through
   `WriteBatchAsync` and finishes with exactly one of `CommitAsync` or `AbortAsync`.

4. **Declare what your connector can do.** The planner reads `Capabilities`, not your code, to
   decide whether an entity's declared options are legal before any node runs:

   ```csharp
   public ConnectorCapabilities Capabilities =>
       ConnectorCapabilities.Merge | ConnectorCapabilities.ReplaceWrites | ConnectorCapabilities.Transactional;
   ```

   Declare only what's true. A connector that claims `Merge` without actually handling
   `mode: merge` in `BeginWriteAsync` is a defect the conformance suite (next step) exists to
   catch. The full capability list and what each flag means for a run's delivery guarantees is in
   [Connector architecture](/internals/connector-architecture/#connectorcapabilities).

5. **Write the connector manifest.** A connector package ships a `pz.connector.json` file at its
   root, read before pz spawns or loads anything:

   ```json title="pz.connector.json"
   { "name": "mysource", "protocolMajorMin": 1, "protocolMajorMax": 1,
     "capabilities": ["source"], "runtime": "process",
     "entrypoints": { "linux-x64": "native/pz-mysource" } }
   ```

   `protocolMajorMin`/`protocolMajorMax` declare the inclusive range of
   `Pz.Connectors.Abstractions` protocol majors your connector supports. `runtime: "process"`
   plus `entrypoints` is what makes an external package loadable at all: an external connector
   with no `runtime: "process"` manifest, or none at all, is refused with `PZ0360` when pz
   builds its connector registry, before spawning anything.

   Pack it at the root of the nupkg:

   ```xml
   <ItemGroup>
     <None Include="pz.connector.json" Pack="true" PackagePath="" CopyToOutputDirectory="PreserveNewest" />
   </ItemGroup>
   ```

   A manifest that's present but malformed, such as `protocolMajorMin` greater than
   `protocolMajorMax`, also fails with `PZ0306`: a broken manifest fails loud rather than
   silently falling back to the no-manifest path. An optional `projectDirectoryAnchor: true`
   key asks pz to resolve the connector's own relative paths, such as a local cache directory,
   against the project directory rather than leaving them unanchored.

6. **Run the conformance tests.** `Pz.Connectors.TestKit` ships an acceptance suite that
   exercises your `ISourceConnector`/`ISinkConnector` implementation directly, in-process, as a
   fast unit test:

   ```console
   $ dotnet test
   ```

   Once you have a spawnable, process-hosted binary, `pz connector test` runs the same contract
   black-box, over the wire, against the real package:

   ```console
   $ pz connector test ./dist/my-connector --config probe.yml
   ```

   `--config` names a YAML file with the connection to configure and the `read:`/`write:`
   entity to probe. This is the one `pz` verb with no `--project`: it targets a connector package
   directly, not a project.

7. **Package it as a NuGet package.** A connector is an ordinary NuGet package. Tag it
   `pipelinez-connector` in `<PackageTags>`, the ecosystem's discovery tag, and name it under your
   own prefix (`MyCompany.Pz.Connector.MySource` is idiomatic); the bare `Pz.*` prefix is reserved
   for first-party packages.

   ```console
   $ dotnet pack -c Release
   ```

8. **Declare it in a project, and restore it.** A project references your package the same way
   it references any non-builtin connector:

   ```yaml title="project.yml"
   connectors:
     - package: MyCompany.Pz.Connector.MySource
       version: 1.0.0
   ```

   ```console
   $ pz restore
   ```

   `pz restore` resolves the package against the host feeds (`--feeds`, else `PZ_FEEDS`, else
   nuget.org), materializes it under `.pz/packages`, and writes `pz.lock.json`. `pz run` and
   `pz validate` load from the lock file after that. Commit `pz.lock.json`; never commit `.pz/`.

   Confirm it registered, with its declared capabilities, before wiring up a real
   `connections.yml` entry against it:

   ```console
   $ pz connectors
   ```

## C# SDK

`Pz.Connectors.Sdk` serves any `Pz.Connectors.Abstractions` connector over PCP and packs it as a
`pz`-installable package. Write the connector exactly as steps 1–4 above describe, then:

```xml title="MyConnector.csproj"
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <PackageId>Pz.Connector.MySystem</PackageId>
    <AssemblyName>pz-mysystem</AssemblyName>
    <!-- Restore reads this line, not the SDK's packaging files: it is what pulls the Native AOT
         compiler pack. PzPackaging=self-contained turns it back off. -->
    <PublishAot>true</PublishAot>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Pz.Connectors.Sdk" Version="x.y.z" />
  </ItemGroup>
</Project>
```

```csharp title="Program.cs"
using Pz.Connectors.Sdk;

return await PzConnectorHost.RunAsync(args, new MySystemConnector());
// To log to the pz host: RunAsync(args, ctx => new MySystemConnector(ctx.LoggerFactory))
```

Rules the SDK enforces so a connector cannot lie to the host:

- **Declare only what you implement.** Every optional RPC is answered from the interfaces your
  objects implement: a source that is not `INaturalReadShapeSource` answers UNIMPLEMENTED; a
  partition that is not `ISyncStatePartition` answers FAILED_PRECONDITION. A `SyncState` declaration
  nothing backs fails `pz connector test`'s `sync-state-roundtrip` vector.
- **Sync-state tokens are captured by the SDK** the moment a partition's enumeration completes,
  before end-of-stream is written. Set the candidate anywhere before your iterator returns.
- **Argv is not configuration.** `--pz-socket <path>` serves; `--pz-manifest --out <file>
  [--entrypoint <rid>=<path>]...` writes `pz.connector.json` from the connector object itself (the
  packaging targets run this for you). Anything else exits 2. Configuration only ever arrives
  through the `Configure` RPC.
- **Logging** goes to the host as connector log events, rendered verbatim: never log configuration
  values or payloads.

### Telemetry

An out-of-process connector exports its own traces and metrics to the same collector the engine uses,
in the same run trace. When `pz run` is given `--otel-endpoint` (or `PZ_OTEL_ENDPOINT`), the host hands
the endpoint and run id to your process at the handshake and puts a W3C `traceparent` on every RPC.
Only then does the SDK:

- export OTLP/gRPC with resource `service.name=pz-connector`, `service.version`, `pz.connector.name`,
  and `pz.run.id`;
- open a `pcp.<Rpc>` server span per RPC — every RPC but `HostChannel` — under the engine's
  `node.<Kind>` span, tagged `pz.instance` (the connection name for an open the engine drives, else
  `<connector>#<n>`), plus a `pcp.read_stream`/`pcp.write_stream` span around each data-plane transfer;
- flush on shutdown, bounded to three seconds.

Your own instrumentation joins that trace with no extra wiring — start spans from `ctx.ActivitySource`
and record on `ctx.Meter`:

```csharp
return await PzConnectorHost.RunAsync(args, ctx => new MyConnector(ctx.ActivitySource, ctx.Meter));
```

To also export a client library's own `ActivitySource`/`Meter` (Npgsql, the AWS SDK), name them in
`PzConnectorHostOptions`. With no endpoint nothing is built and every span is a BCL no-op. Never put a
configuration value in a span name, a tag, or a metric label — what is emitted is what the operator
sees.

### Packaging

Native AOT per platform is the default; `<PzPackaging>self-contained</PzPackaging>` opts a connector
whose dependencies cannot be AOT-compiled into a single-file CoreCLR publish instead. The host sees
no difference. `<PublishAot>true</PublishAot>` belongs in the project file itself (or on the command
line as `-p:PublishAot=true`): NuGet restore evaluates a project with every package's build files
excluded, so the compiler pack Native AOT needs is only restored when the project asks for it, never
because the SDK's targets derived it from `PzPackaging`. A publish that would silently fall back to a
CoreCLR layout fails with `PZSDK005` instead. `self-contained` turns `PublishAot` off again, so the
line costs a connector that opts out nothing but a download; switching such a connector to Native
AOT from the command line takes both flags (`-p:PzPackaging=aot -p:PublishAot=true`). Native AOT cannot cross-compile between operating systems, so a release publishes
once per platform and packs once:

```console
$ dotnet publish -c Release -r linux-x64    # on Linux
$ dotnet publish -c Release -r osx-arm64    # on macOS
$ dotnet publish -c Release -r win-x64      # on Windows
$ dotnet pack -c Release -p:PzNativeStaging=./stage   # once, from a directory holding every RID
```

`pack` collects each `<staging>/<rid>/` as `runtimes/<rid>/native/`, runs the packer's own binary
with `--pz-manifest` to write the manifest (one `--entrypoint <rid>=<path>` per staged RID), and
packs it at the nupkg root. Missing RIDs warn (`PZSDK002`); no RID at all is an error (`PZSDK001`);
the packing machine must have published its own RID (`PZSDK003`). Set `PzRuntimeIdentifiers` to the
RID set you ship.

A connector that resolves relative paths from its own configuration (a local file root, a
certificate path) sets `<PzProjectDirectoryAnchor>true</PzProjectDirectoryAnchor>`; the manifest
then carries `projectDirectoryAnchor`, and `pz` passes the project directory to the connector as
the `base_dir` connection option so those paths resolve against the project rather than the
process working directory.

A complete GitHub Actions release workflow:

```yaml title=".github/workflows/release.yml"
name: release
on:
  push:
    tags: ['v*']
jobs:
  publish:
    strategy:
      matrix:
        include:
          - { os: ubuntu-latest,   rid: linux-x64 }
          - { os: ubuntu-24.04-arm, rid: linux-arm64 }
          - { os: macos-latest,    rid: osx-arm64 }
          - { os: windows-latest,  rid: win-x64 }
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: actions/setup-dotnet@v4
        with: { dotnet-version: '10.0.x' }
      - run: dotnet publish src/MyConnector -c Release -r ${{ matrix.rid }} -p:PzNativeStaging=${{ github.workspace }}/stage/
      - uses: actions/upload-artifact@v4
        with:
          name: pz-native-${{ matrix.rid }}
          path: stage/${{ matrix.rid }}
  pack:
    needs: publish
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: actions/setup-dotnet@v4
        with: { dotnet-version: '10.0.x' }
      - uses: actions/download-artifact@v4
        with:
          pattern: pz-native-*
          path: stage
      # download-artifact nests each artifact under its name; rename to the RID directories pack expects.
      - run: for d in stage/pz-native-*; do mv "$d" "stage/${d#stage/pz-native-}"; done
      - run: dotnet publish src/MyConnector -c Release -r linux-x64 -p:PzNativeStaging=${{ github.workspace }}/stage/
      - run: dotnet pack src/MyConnector -c Release -p:PzNativeStaging=${{ github.workspace }}/stage/ -o packages
      - run: dotnet nuget push packages/*.nupkg --source https://api.nuget.org/v3/index.json --api-key ${{ secrets.NUGET_API_KEY }}
```

(The pack job republishes `linux-x64` because the manifest is produced by running the packer's own
RID; the artifact download covers the others.)

Verify with `pz connector test <package-dir> --config probe.yml` against the restored package.

## Rust SDK

The `pz-connector` crate is an SDK for writing pz's out-of-process (PCP) connectors in Rust. Its
`serve_sink` entry point parses a `--pz-socket` argument, serves the connector's control-plane
gRPC service on that Unix socket, and serves the raw Arrow IPC data plane on a paired socket,
dispatching every call to a `SinkConnector`/`Sink`/`WriteSession` you implement. Add the crate as
a dependency and implement those three traits; the crate's own `examples/memory_sink.rs` is a
complete, minimal sink.

Source support is deferred in this SDK. Its trait surface covers sinks only; the wire protocol
already covers sources, but no Rust trait exists yet to implement one against.

A minimal Rust sink implements three traits: `SinkConnector` (`validate`, `check`, `open`, and
`try_native_copy`), `Sink` (`begin_write`), and `WriteSession` (`write_batch` and the commit/abort
pair). It is the same shape as the C# `ISinkConnector`/`ISink`/`ISinkWriteSession` triad above, just in
Rust. The crate still produces the same `pz.connector.json` package shape described in step 5:
`runtime: "process"` with a per-RID entrypoint pointing at the compiled binary.

### Telemetry

The Rust SDK exports the same way, with the same resource attributes, span names, and three-second
shutdown flush as the C# SDK, on the same instrumentation scope (`Pz.Connector`). Ordinary `tracing`
spans and events inside your handlers reach the collector; `pz_connector::meter()` returns the meter
to record instruments on. At the handshake the SDK installs its own `tracing` subscriber. A connector
that installs its own subscriber composes `pz_connector::layer()` into it before `serve_sink`, so its
spans still export:

```rust
use tracing_subscriber::layer::SubscriberExt;

tracing::subscriber::set_global_default(
    tracing_subscriber::registry()
        .with(tracing_subscriber::fmt::layer().with_writer(std::io::stderr))
        .with(pz_connector::layer()),
)?;
```

Without that layer an author-installed subscriber wins and no span is exported (the handshake says so
on stderr); meters are unaffected either way.

## Verify

Two independent checks confirm your connector is ready to ship: `dotnet test` against the
`Pz.Connectors.TestKit` acceptance suite passes with no skipped mode-honesty facts for the
capabilities you declared, and, once packaged, `pz connector test <path> --config probe.yml`
exits `0` against your real binary.

## Troubleshooting

| If you see | Do |
|---|---|
| `PZ0360` when pz builds its connector registry | Your package's manifest declares no `runtime: "process"`, or ships no manifest at all. An external connector must be process-hosted; add `runtime`/`entrypoints` to `pz.connector.json`. |
| `PZ0306` | The manifest's `protocolMajorMin`/`protocolMajorMax` range doesn't include the host's protocol major. Upgrade `pz`, or pin an older connector version. |
| `PZ0312` at plan time | An entity needs the universal tier, but your connector's `TryGetNativeScan`/`TryGetNativeCopy` are the only path it offers. Implement the universal path, or mark the connector native-only with `INativeOnlySource`/`INativeOnlySink`. |
| `PZ0304` | `project.yml` declares the package under `connectors:`, but it isn't in `.pz/packages`. Run `pz restore`. |
| `PZ0307` | pz loaded your assembly but found no `[assembly: PzConnector(...)]` attribute. Check it's present and names the right implementing type. |
| `PZSDK001`/`PZSDK003` at pack time | No staged binary (or none for the packing machine's RID). Run `dotnet publish -r <rid>` before `dotnet pack`. |
| `PZSDK005` at publish time | `PzPackaging` is `aot` but the Native AOT compiler pack was never restored, so the publish would have staged a CoreCLR layout under a native binary's name. Add `<PublishAot>true</PublishAot>` to the project file and restore again, or opt out with `<PzPackaging>self-contained</PzPackaging>`. |
| A `PzConnectorException.Message` leaks a credential | Messages are published verbatim to `run_results.json` and the event stream. Redact anything sensitive before throwing; see [Connector architecture](/internals/connector-architecture/) for the full redaction contract. |
| A capability you declared isn't honored | The conformance suite's mode-honesty facts exist to catch exactly this. Re-run `dotnet test` and check which fact failed. |

## Related

- [Connectors](/concepts/connectors/): what a connector is, builtin versus third-party, and the two data-movement tiers.
- [Connector architecture](/internals/connector-architecture/): the full ABI surface, PCP protocol, and capability semantics.
- [CLI reference](/reference/cli/#pz-connector-test): every `pz connector test` and `pz restore` flag.
- [project.yml reference](/reference/project-yml/#top-level-keys): the `connectors:` key in full.
- [connections.yml reference](/reference/connections-yml/): the connection and entity shape your connector's config schemas validate against.
