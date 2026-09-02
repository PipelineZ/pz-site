---
title: "Install pz"
description: "How to install the pz command-line tool with the .NET SDK, verify it works, upgrade it, and install it on a machine without internet access."
sidebar:
  order: 2
---

This page installs the `pz` command on your machine. It takes about two minutes. If you want to
try pz before installing anything, read [Key concepts](/concepts/key-concepts/) first.

## Prerequisites

- The **.NET 10 SDK**. Installing a .NET tool needs the SDK, not only the runtime. Get it from
  [dotnet.microsoft.com](https://dotnet.microsoft.com/download/dotnet/10.0).
- Linux x64 or arm64, Windows x64, or macOS arm64. pz ships as a native binary for each and a
  framework-dependent build for everything else. The installer picks the right one.

Check the SDK is available:

```console
$ dotnet --version
10.0.100
```

## Install

```console
$ dotnet tool install --global pz
```

To install a pre-release build instead, add `--prerelease`.

Verify:

```console
$ pz --version
0.3.0
```

If the shell cannot find `pz`, the global tools folder is not on your `PATH`. On Linux and macOS
it is `~/.dotnet/tools`; on Windows it is `%USERPROFILE%\.dotnet\tools`. Add it and open a new
shell.

All ten builtin connectors are inside the binary. You install nothing else to read local files,
PostgreSQL, SQL Server, MySQL, SQLite, S3, Azure Blob Storage, Google Cloud Storage, HTTP
endpoints, or SFTP. Third-party connectors are NuGet packages that `pz restore` downloads per
project. See [Connectors](/connectors/).

## Upgrade

```console
$ dotnet tool update --global pz
```

Every release note lists what changed and whether a project needs edits. See
[Versioning](/versioning/) for the compatibility promise.

## Uninstall

```console
$ dotnet tool uninstall --global pz
```

Projects keep working with the next install. Watermarks and run history live in each project's
`.pz/` directory, not in the tool.

## Install without internet access

pz can be installed from an offline bundle: a zip that holds a local NuGet feed, a
`nuget.config` pointing at it, and an installer script. The bundle is produced from a pz checkout
with `scripts/make-release-bundle.sh` and copied to the target machine.

On Windows, extract the zip and run:

```powershell
PS> .\install.ps1
```

The script installs pz into `C:\pz\tool` by default, upgrades an existing install in place, and
prints `pz --version` at the end. Pass `-ToolPath` to choose another folder.

On any platform you can install from the bundle by hand:

```console
$ dotnet tool install pz --tool-path ./pz-tool --configfile ./nuget.config --prerelease
```

## Next steps

- [Quickstart](/quickstart/): create a project and run it in ten minutes.
- [Tutorial](/tutorial/): build a pipeline with a check and an incremental read.
- [CLI reference](/reference/cli/): every verb and flag.
