---
title: "Use pz with an AI agent"
description: "From your project directory, wire up one or more clients in one step:"
---

`pz mcp` serves the current project to any [Model Context Protocol](https://modelcontextprotocol.io)
client — Claude Code, VS Code, GitHub Copilot CLI, opencode, or a custom agent — as a
set of typed tools: introspect the project, run `pz validate`/`pz compile`/`pz plan`
as a fix loop, author `connections.yml`/`pipelines/*.sql` with self-verifying edits,
and — only if you opt in — actually run the project. pz never calls an LLM itself;
the agent lives entirely on the other side of the protocol. Full contract:
[MCP contract reference](/reference/mcp-contract/).

## Quickstart: `pz mcp init`

From your project directory, wire up one or more clients in one step:

```bash
pz mcp init claude-code
pz mcp init vscode claude-code copilot-cli opencode   # several at once
pz mcp init --all                                      # all four
```

This does two things per client, merge-preservingly (existing config files keep
every other key and every other server entry — only the `pz` entry is written or
updated):

1. Writes (or updates) that client's MCP config file with a `pz` server entry
   pointing at `pz mcp` (see [Manual setup](#manual-setup) below for the exact
   shape each client gets).
2. Installs the embedded `pz-pipelines` skill — a `SKILL.md` plus the
   `authoring-for-agents.md` guide — into the locations that client's ecosystem
   looks for skills in, so an agent that supports skills gets pz-specific
   authoring guidance without you writing any of it by hand.

Re-running is idempotent: the same inputs produce the same files, with any prior
`pz` entry replaced in place.

Pass `--allow-run` to bake the flag into the generated server entry for every
selected client (see below for what it unlocks). `--skill-locations` overrides
which skill directories get installed — see [Skill install locations](#skill-install-locations).
Add `--project <dir>` to target a project other than the current directory.

No client named and no `--all` is a `PZ0605` error listing the four client names —
explicit over implicit, the same posture as a bare `pz run` on a multi-flow
project.

## `--allow-run`: off by default, on purpose

Without `--allow-run`, the server exposes only introspection, verification, and
authoring tools — nothing that moves real data or advances a watermark. The three
execution tools (`pz_run`, `pz_retry`, `pz_run_results`) are **absent from the tool
listing entirely** when the flag is off, not present-but-refusing: the connected
agent never even sees them, so it can't plan around a capability it doesn't have.

This makes the server safe to point an agent at by default: it can read your
project, validate its own edits, and iterate on `connections.yml`/pipeline SQL —
but it cannot move data, hit a real database, or advance state — until an operator
(a human, deliberately) starts the server with `--allow-run`. That's a server-start
flag, not something a model can toggle from inside a conversation.

```bash
pz mcp --allow-run          # direct invocation
pz mcp init claude-code --allow-run   # baked into the generated client config
```

A gated run reports **once, when it finishes** — the run's events do not stream to
the client as MCP progress notifications in this version (deliberately deferred; the
final result carries the full node-by-node summary either way). Watch a long run
live with the CLI's own output or the NDJSON event stream instead.

## What `pz mcp init` writes

| Client | Config file | Top-level key |
|---|---|---|
| `vscode` | `<project>/.vscode/mcp.json` | `servers.pz` |
| `claude-code` | `<project>/.mcp.json` | `mcpServers.pz` |
| `copilot-cli` | `~/.copilot/mcp-config.json` (the one user-global target — every other client's file is project-local) | `mcpServers.pz` |
| `opencode` | `<project>/opencode.json` | `mcp.pz` |

An existing config file that fails to parse as JSON is refused outright (`PZ0605`)
— left byte-untouched, never overwritten with a fresh empty file.

### Skill install locations

| `--skill-locations` token | Directory | Installed by default for |
|---|---|---|
| `standard` | `.agents/skills/pz-pipelines/` | always |
| `claudecode` | `.claude/skills/pz-pipelines/` | `claude-code` |
| `github` | `.github/skills/pz-pipelines/` | `vscode`, `copilot-cli` |
| `opencode` | `.opencode/skill/pz-pipelines/` (singular `skill`, matching that ecosystem's own convention) | `opencode` |

The default install set is `standard` plus whatever the clients you named imply;
pass `--skill-locations all`, `--skill-locations none`, or an explicit
comma-separated list to override. An unrecognized token is `PZ0605`, checked
before any file is written — a typo never partially installs.

## Manual setup

If your client isn't one of the four `pz mcp init` covers, or you'd rather wire it
up by hand, every client needs the same two things: a command to launch (`pz mcp`,
optionally with `--allow-run`) and a working directory at the project root. The
four shapes `pz mcp init` itself generates, for reference:

**VS Code** (`.vscode/mcp.json`, `servers.pz`):

```json
{ "type": "stdio", "command": "pz", "args": ["mcp"] }
```

**Claude Code** (`.mcp.json`, `mcpServers.pz`) — equivalent to
`claude mcp add pz -- pz mcp`:

```json
{ "command": "pz", "args": ["mcp"] }
```

**GitHub Copilot CLI** (`~/.copilot/mcp-config.json`, `mcpServers.pz`):

```json
{ "type": "local", "command": "pz", "args": ["mcp"], "tools": ["*"] }
```

**opencode** (`opencode.json`, `mcp.pz`):

```json
{ "type": "local", "command": ["pz", "mcp"], "enabled": true }
```

For a generic client that isn't any of these four: `command: pz`, `args: [mcp]`
(add `--allow-run` to the args if the client supports execution tools), and
`cwd` set to the project root — `pz mcp` serves the project in its current working
directory by default. A client that cannot set `cwd` can pass the directory
explicitly instead: `args: [mcp, --project, /path/to/project]` (`--project` works on
both `pz mcp` and `pz mcp init`).

## Concurrency: two humans, two terminals

The server takes no long-lived project lock. Mutations (`pz_add_connection`,
`pz_write_pipeline`, ...) are atomic per call — write to a temp file, rename over
the original — but there is no cross-call transaction, and gated runs take the
same `RunDirLock` a CLI-invoked `pz run` does. Practically: **two agents (or an
agent and a human) pointed at one project behave exactly like two humans with two
terminals.** Last write wins on files; a run and a concurrent run — from either
side, CLI or MCP — exclude each other (`PZ0604` on the side that loses the race)
rather than corrupting shared state. This is good enough for a single project with
a single active author, which is the intended v1 shape; running two agents against
the same project concurrently and expecting them to merge cleanly is not
supported.

## Secrets

The MCP surface extends the project's existing secret-hygiene rule to authoring:
connection config values never leave the server, and a mutation tool refuses to
write one in as plaintext.

- `pz_project_overview` returns connection **names and connector types only** —
  never a config value. `pz_plan`'s `reason` strings and `pz_state`'s values are
  the same way; neither can carry a credential.
- `pz_add_connection`/`pz_update_connection` require any option whose **key name**
  contains `password`, `secret`, `token`, `key`, or `connection_string` to be a
  `${VAR}` environment-variable reference — the whole
  value, nothing else, e.g. `"${DB_PASSWORD}"`. (That key-name heuristic is the
  whole check in v1: a connector schema marking a property `writeOnly`/
  `format: password` is not consulted, so a credential-shaped option under an
  unusual name is your responsibility.) A literal value in that shape is
  refused with **`PZ0601`** before any file is written or any connector is even
  resolved — the secret itself never transits the tool result, only the offending
  key name does. See [Secure connection config](/how-to/secure-connection-config/) for
  how to get the variable into the process environment in the first place.

## Paths stay inside the project

Under `pz mcp`, a localfiles `path:`/`root:`/`base_dir:` that resolves outside the
project directory — `../` traversal or an absolute path elsewhere — is refused with
**`PZ0606`**, whether it sits in the existing config or in a block an authoring tool
proposes to write. This matches the posture the mutation tools already take for
`../` in names (`PZ0602`): the agent surface operates only on files inside the
project. The plain `pz` CLI is unchanged — your config, your files — so a project
that legitimately reads outside its own directory still runs from the terminal;
it just isn't drivable through an agent. The containment check is lexical, a guard
for steering agents, not a symlink-proof security boundary.

## Learn more

- [MCP contract reference](/reference/mcp-contract/) — the full envelope
  shape, tool-by-tool inputs/results, and the PZ06xx error codes.
- Once connected, a resource-aware client can pull in the embedded authoring guide
  and every concepts/how-to doc directly (`pz://docs/...` resources) — ask it to
  read `pz://docs/reference/authoring-for-agents.md` first if it needs a primer.
