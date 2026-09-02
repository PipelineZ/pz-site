---
title: "Versioning and breaking changes"
description: "What pz promises about compatibility during the v0.x preview, which surfaces v1.0 will freeze, and how breaking changes are announced."
sidebar:
  order: 12
---

This page is the compatibility promise behind pz version numbers: what you can rely on during
v0.x, and what `v1.0.0` will freeze. Read it before upgrading a project across minor versions.

`pz` and every first-party package share one version, computed from git tags (`v*`).

## What v0.x promises

v0.x is a public preview. It is installable, tested, and usable for real work. Its surfaces
may still change **between minor versions** (v0.1 to v0.2). Concretely:

- **Breaking changes land only at minor version bumps**, never at patches. A patch
  release (v0.1.x) only fixes bugs in already-shipped behavior.
- **Every breaking change is called out in the release notes** with a migration
  note: what changed, why, and the exact edit your project needs.
- **Your data is never silently reinterpreted.** A change that would alter what an
  existing project reads or writes (formats, delivery guarantees, type mapping)
  is a breaking change even when no API changed, and is treated as above.
- **Error codes (`PZ####`) are append-mostly**: a code's meaning does not change;
  retiring or renumbering one is a breaking change.

## What v1.0.0 freezes

`v1.0.0` is a promise, not a party. It ships when the surfaces below have each held
stable through a full public release cycle, and from then on they follow semver: no
breaking change without a major version.

| Frozen surface | Contract lives in |
|---|---|
| Connector ABI (the ecosystem's contract) | `Pz.Connectors.Abstractions` + [author-a-connector](/how-to/author-a-connector/) |
| Project YAML schema (`project.yml`, `connections.yml`) | [project.yml](/reference/project-yml/) and [connections.yml](/reference/connections-yml/) references |
| CLI verbs, flags, and exit codes | [CLI reference](/reference/cli/) |
| NDJSON run-event stream | [Run events](/reference/events/) (already append-only by policy) |
| Error-code registry (`PZ####`) | [Error codes](/reference/error-codes/) |
| MCP tool surface and `ToolEnvelope` | [MCP contract](/reference/mcp-contract/) (already append-only by policy) |

Two of these, the event stream and the MCP envelope, already follow append-only stability
contracts today. The event stream is checked by tests that diff the documentation against the
code. v1.0 extends that discipline to the rest.

## What is never covered

- Internal APIs of non-packable projects such as `Pz.Core` and `Pz.Engine`. Reference
  them at your own risk.
- The exact text of log lines, console rendering, and hints. Only the NDJSON
  stream is a machine contract.
- `.pz/` internals other than the documented artifacts (`run_results.json`,
  `plan.json`, `pz.lock.json`).

## How changes are announced

Every release gets release notes on the GitHub release for its tag, with breaking
changes listed first. Deprecations, when possible, warn for at least one minor
version before removal.

## Documentation versions

The pages at the root of this site describe the latest released minor. Each earlier minor keeps
its documentation at `/vX.Y/`, for example `/v0.4/reference/cli/`. Use the version dropdown in
the site header to switch; an archived page shows a notice with a link back to the latest one.
Patch releases update the current pages in place.

## Related

- [Install pz](/install/): how to upgrade the tool.
- [Error codes](/reference/error-codes/): the registry this page promises to keep stable.
- [Run events](/reference/events/): the append-only event contract.
