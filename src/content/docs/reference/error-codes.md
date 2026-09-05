---
title: "Error codes"
description: "The full PZ#### error registry, one table per family, generated from the pz source."
sidebar:
  order: 6
---

Every error `pz` raises carries a stable `PZ####` code, grouped below by the stage of the
system that raises it. A console error prints as `error PZ####: <message> (<file>:<line>) —
hint: <hint>`, though `file`, `line`, and `hint` are each omitted when the error carries none.

## 01xx: Loading

Raised while reading `project.yml`, `connections.yml`, and `pipelines/`, before compiling the DAG.

| Code | Name | Meaning | Where it surfaces |
|---|---|---|---|
| `PZ0101` | YamlShape | A project YAML file is malformed: not valid YAML, not a mapping where one is required, or an unrecognized key. | Loading any project file |
| `PZ0102` | VarsInvalid | `--vars` text failed to parse as JSON, or parsed to something other than a JSON object. | `pz` CLI startup |
| `PZ0103` | UndeclaredEnvVar | An `env()` call or a `${VAR}` reference names an environment variable that is not set. | Rendering pipeline SQL, loading connections.yml |
| `PZ0104` | TemplateError | A pipeline's template failed to parse or render, for a reason other than an unset environment variable. | Rendering pipeline SQL |
| `PZ0110` | DuplicateName | Two `.sql` files define the same pipeline name. | Loading pipelines |
| `PZ0111` | SidecarUnknownPipeline | A sidecar's `pipeline:` key names a pipeline no `.sql` file defines. | Loading `pipelines/configs/*.yml` |
| `PZ0112` | RemovedInputField | A sink declares the removed `input:` field; a pipeline's own `INSERT INTO {{ sink(...) }}` is the load binding. | Loading connections.yml, rendering pipeline SQL |
| `PZ0113` | InvalidCheck | A sidecar check is invalid: unknown type, malformed per-type option, or unrecognized option key. | Loading `pipelines/configs/*.yml` |
| `PZ0120` | InvalidEngineConfig | project.yml's `engine:` block is malformed. | Loading project.yml |
| `PZ0121` | RetryConfigInvalid | A `retry:` block, in connections.yml or at a call site, is malformed, out of bounds, or has an unparseable duration. | Loading connections.yml, rendering pipeline SQL |
| `PZ0122` | ConcurrencyConfigInvalid | `max_concurrency:` is not an integer, or is less than 1. | Loading connections.yml |
| `PZ0123` | RetentionConfigInvalid | project.yml's `retention:` block is malformed, or sets `keep_last` below 1. | Loading project.yml |
| `PZ0124` | StateBackendConfigInvalid | project.yml's `state:` block is malformed, names an unknown backend, or sets backend-specific keys under `backend: local`. | Loading project.yml |
| `PZ0125` | StateConnectionInvalid | `state.connection` names a connection connections.yml does not declare, or one whose connector is not sqlserver. | Loading project.yml |
| `PZ0126` | DriftPolicyInvalid | project.yml's `on_source_drift:` is not `ignore`, `warn`, or `fail`. | Loading project.yml |
| `PZ0127` | SchemaAcceptTargetInvalid | `pz schema accept`'s `<connection>.<entity>` argument does not resolve to a dataset with a recorded observed schema. | `pz schema accept` |
| `PZ0130` | InitTargetNotEmpty | `pz init`'s target directory exists and is not empty. | `pz init` |
| `PZ0131` | InitTemplateUnknown | `pz init --template` names a template id that does not exist. | `pz init` |
| `PZ0132` | InitInvocationInvalid | `pz init` was given neither a name nor `--list-templates`, or both. | `pz init` |

## 02xx: Semantic

Raised while compiling the DAG: dependency edges, materialization rules, incremental
declarations, and node selection.

| Code | Name | Meaning | Where it surfaces |
|---|---|---|---|
| `PZ0201` | UnresolvedRef | A `source()`/`ref()` call is malformed: missing arguments, or extra positional arguments where only keyword options belong. | Rendering pipeline SQL |
| `PZ0202` | Cycle | The pipeline DAG has a dependency cycle. | Compiling the DAG |
| `PZ0204` | EphemeralChain | An ephemeral pipeline `ref()`s another ephemeral pipeline. | Compiling the DAG |
| `PZ0205` | ChecksOnEphemeral | An ephemeral pipeline declares checks, but produces no node for a check to depend on. | Compiling the DAG |
| `PZ0206` | SinkBindingConflict | More than one pipeline's `sink()` call claims the same connection and entity. | Compiling the DAG |
| `PZ0208` | InvalidSinkCall | A `sink()` call is malformed: missing arguments, extra positional arguments, or a duplicated keyword. | Rendering pipeline SQL |
| `PZ0209` | MergeRequiresKeys | A `strategy: merge` write declares no `keys:`. | Compiling the DAG |
| `PZ0210` | SelectorNoMatch | A `--select` atom matched zero nodes. | `pz run`/`pz plan` node selection |
| `PZ0211` | KeysWithoutMerge | A write declares `keys:` with a strategy other than `merge`. | Compiling the DAG |
| `PZ0212` | CursorInvalid | An incremental cursor column is missing from, or mistyped in, a declared `columns:` contract. | Compiling the DAG |
| `PZ0213` | WindowConfigInvalid | A bounded-window config (`max_window`/`initial`/`until`) violates a semantic rule, such as `until` not exceeding `initial`. | Compiling the DAG |
| `PZ0214` | IncrementalAppendUnacknowledged | An incremental read feeds a `strategy: append` write without `duplicates: accept`. | Compiling the DAG |
| `PZ0215` | MultiFlowNeedsSelection | A bare `pz run` on a project with two or more independent flows must name a flow, or pass `--select`/`--all`. | `pz run`/`pz plan` |
| `PZ0216` | SelectionConflict | Positional flow names, `--select`, and `--all` were combined; they are mutually exclusive. | `pz run`/`pz plan` |
| `PZ0217` | TemplatedPathCursorInvalid | A dataset's `path` uses date tokens, but the dataset has no incremental cursor of a date/timestamp type. | Compiling the DAG |
| `PZ0218` | TemplatedPathTokensInvalid | A `path`'s date-token sequence is malformed: an unknown token, or tokens that are not a contiguous coarse-to-fine run. | Compiling the DAG |
| `PZ0219` | PartitionedOutputConfigInvalid | A partitioned write's `partition_by:` does not name a column or list of columns, or disagrees with `path:`. | Compiling the DAG |
| `PZ0221` | TemplatedPathWindowRequired | A date-templated `path` needs a bounded window (`initial:` and `max_window:`) so every run carries watermark bounds. | Compiling the DAG |
| `PZ0222` | FilesPerPartitionInvalid | `files_per_partition` is not a positive integer. | Compiling the DAG |
| `PZ0223` | DeadLeafPipeline | A non-ephemeral pipeline neither loads to a sink nor is consumed by any `ref()`. A warning, not an error. | Compiling the DAG |
| `PZ0224` | UnrecognizedWatermarkExpression | A `watermark()` comparison does not match the one recognized pattern, or resolves to a table that doesn't trace to the claimed dataset. | Compiling the DAG |
| `PZ0225` | ConflictingIncrementalDeclaration | A dataset declares both a YAML `sync:` (or retired `incremental:`) block and a SQL `watermark()` call. | Compiling the DAG |
| `PZ0227` | WatermarkCursorUndeclared | A `watermark()` call's cursor column is absent from the dataset's declared `columns:` contract, or its type is unsupported. | Compiling the DAG |
| `PZ0229` | DescendingCursorTruncatable | An incremental dataset combines a descending cursor order with a page limit, which could advance the watermark past unfetched rows. | Compiling the DAG |

## 030x: Connector host

Raised resolving, installing, and running connector packages, including process-hosted ones.

| Code | Name | Meaning | Where it surfaces |
|---|---|---|---|
| `PZ0301` | ConnectorConfigInvalid | A connection or entity config value fails the connector's own published schema: a missing required key, or an unrecognized option. | Loading connections.yml, validating connector config |
| `PZ0304` | ConnectorPackageMissing | A project declares a non-builtin connector package not present in the resolved package set. | Resolving connectors |
| `PZ0305` | ConnectorNotInstalled | A declared connector's package is not installed under `.pz/packages`. | Building the connector registry, running a node |
| `PZ0306` | ProtocolMismatch | A process-hosted connector's manifest declares a `runtime` the host does not recognize. | Loading a connector manifest |
| `PZ0307` | NoConnectorEntryPoint | A process-hosted connector's manifest has no entrypoint for the current runtime identifier. | Loading a connector manifest |
| `PZ0345` | ReservedConnectionKey | A connector's own config schema declares a key pz reserves at the connection level. | Validating connector config |
| `PZ0354` | ProcessEntrypointMissing | A process-hosted connector's manifest leaves the host no usable entrypoint to spawn. | Starting a process-hosted connector |
| `PZ0355` | ConnectorSpawnFailed | Launching a process-hosted connector's executable failed, or its control-socket path is too deep. | Starting a process-hosted connector |
| `PZ0356` | ConnectorHandshakeFailed | A process-hosted connector's startup handshake failed: a timeout, a malformed Hello message, or a manifest/capability mismatch. | Starting a process-hosted connector |
| `PZ0358` | ConnectorDiedMidOperation | A process-hosted connector's executable exited unexpectedly during an in-flight operation. | Reading or writing through a process-hosted connector |
| `PZ0360` | ExternalConnectorNotOutOfProcess | A non-builtin connector package declares runtime `"dotnet"`, or ships no manifest; external connectors must run out of process. | Building the connector registry |

## 031x: Native path

Raised planning a node's execution tier, including capability checks and DuckDB native scans.

| Code | Name | Meaning | Where it surfaces |
|---|---|---|---|
| `PZ0311` | NativeSetupFailed | A DuckDB native setup statement failed: an extension load, a secret, a session setting, or an attach. The message never includes a credential. | Running a node on the native tier |
| `PZ0312` | NativePathRequired | A dataset option needs the universal read path, but its connector supports only the native path. | Compiling the DAG, planning execution |
| `PZ0313` | WindowCapabilityMissing | A dataset declares `max_window`, but its connector does not declare bounded-window support. | Planning execution |
| `PZ0314` | TemplatingCapabilityMissing | A date-templated `path`, or a write's `partition_by`, needs a capability its connector does not declare. | Planning execution |
| `PZ0315` | SyncStateConflict | Two resume mechanisms are declared for one dataset: a SQL `watermark()` alongside `sync: {mode: auto}`, or an ordered cursor on a connector managing its own change feed. | Compiling the DAG, planning execution |
| `PZ0316` | SyncPartitionedReadConflict | A `sync:` dataset's connector reads in parallel partitions, but one opaque continuation token cannot reconcile across them. | Planning execution |
| `PZ0317` | PacingUnsupported | An instance declares `rate_limit:`, but its connector does not support pacing. | Planning execution |
| `PZ0318` | RateLimitConfigInvalid | A `rate_limit:` block is malformed, out of bounds, or declared under `read:`/`write:` instead of the connection. | Loading connections.yml, rendering pipeline SQL |
| `PZ0319` | PartitionIdentityInvalid | A connector declared stable partition ids but a planned partition lacks one, or declared checkpointable reads without stable partition ids. | Planning execution, running a node |
| `PZ0353` | NativePathContractMismatch | A native-path connector refused the read or write at plan time: a declared `columns:` contract disagrees with what it reads, its file does not exist yet, or its options conflict. Raised only for a node the run executes; on a node outside the run's selection the refusal is recorded in `plan.json` instead. | Planning execution |
| `PZ0359` | UnsignedExtensionRefused | A native scan needs an unsigned DuckDB extension, and the connection does not set `allow_unsigned_extensions: true`. | Planning execution |
| `PZ0361` | FileFormatUnsupported | A file-place connector (localfiles, s3, gcs, azureblob, sftp) was asked for a `format:` it does not support in that direction or on that tier: an unknown name, or (reserved for a later release) a read-only or native-only format. s3, gcs, and azureblob sinks have no default and raise this when `format` is missing outright. | Planning execution |
| `PZ0362` | FileFormatOptionInvalid | A format-scoped option is declared on a format that does not admit it, or carries an invalid value. Reserved: no shipped format admits an option yet. | Planning execution |

## 032x: Restore and lock

Raised installing connector packages and checking them against `pz.lock.json`.

| Code | Name | Meaning | Where it surfaces |
|---|---|---|---|
| `PZ0320` | RestoreFailed | `pz restore` could not resolve or download a declared connector package. | `pz restore` |
| `PZ0321` | LockDrift | Installed connector packages under `.pz/packages` do not match `pz.lock.json`. | Building the connector registry |
| `PZ0322` | LockMissing | `pz.lock.json` is missing but the project declares non-builtin connectors. | Building the connector registry |
| `PZ0323` | FloatingVersionRejected | A connector package requirement names a floating version range, which `pz restore` does not accept. | `pz restore` |
| `PZ0324` | WriteModeUnsupported | A write's strategy is not supported by its target connector: `merge` without merge support, or `replace` without replace support. | Planning execution |
| `PZ0325` | PackageAssetCollision | Two resolved connector packages provide a library or native file with the same name. | Restoring packages |

## 033x: Connectivity

Raised connecting to declared connections, and validating the connections.yml read/write
surface. See also the [connections.yml reference](/reference/connections-yml/) for the same
codes from the YAML author's side.

| Code | Name | Meaning | Where it surfaces |
|---|---|---|---|
| `PZ0330` | ConnectionCheckFailed | Could not connect to a declared connection. | `pz connector test`, connectivity validation |
| `PZ0331` | SchemaDrift | A live-fetched schema disagrees with a dataset's declared `columns:` contract or its last observed schema. | Connectivity validation, `pz run` |
| `PZ0332` | RetiredReadSurface | A dataset declares the retired top-level `incremental:` block. | Loading connections.yml |
| `PZ0333` | RetiredWriteSurface | A write declares the retired `mode:`/`keys:`/`accept_duplicates:` surface, or a `sink()` call passes a retired keyword. | Loading connections.yml, rendering pipeline SQL |
| `PZ0334` | SyncModeInvalid | A `sync:` block, or a write's `strategy`/`duplicates`/`on_delete`/`schema_policy`, is malformed or invalid. | Loading connections.yml, rendering pipeline SQL |
| `PZ0335` | IncompatiblePair | A resolved read shape is paired with a write strategy the compiler refuses, such as an incremental read feeding `strategy: replace`. | Compiling the DAG |
| `PZ0336` | CdcConsentMissing | A CDC-fed `strategy: merge` write has not declared `on_delete`. | Compiling the DAG |
| `PZ0337` | CdcDeleteRouteInvalid | `on_delete` is declared on a write that is not CDC-fed, or its delete keys cannot be routed. | Compiling the DAG |
| `PZ0338` | ChangeCaptureUnsupported | A `sync: {mode: cdc}` dataset's connector does not declare change-capture support, or its landed change rows violate the CDC contract. | Planning execution, running a node |
| `PZ0339` | DeleteApplyUnsupported | An `on_delete: delete`/`soft` write's connector does not support applying deletes. | Planning execution |
| `PZ0340` | CdcDeleteKeysUnavailable | At drain time, a CDC-fed merge write's declared merge keys are missing from, or null in, a deletes row. | Running a node |
| `PZ0341` | WriteSurfaceSplit | A read or write option is declared both in connections.yml and at the `source()`/`sink()` call site. | Loading connections.yml, rendering pipeline SQL |
| `PZ0344` | EntityNameInvalid | An entity name is empty, has an empty dotted segment, or contains whitespace. | Loading connections.yml, rendering pipeline SQL |
| `PZ0346` | RetiredConnectionDirectory | A `sources/` or `sinks/` directory is present. | Loading a project |
| `PZ0347` | RetiredOutputsBlock | A top-level `outputs:` block is present. | Loading connections.yml |
| `PZ0348` | RetiredEntityQualifier | `schema:`/`table:` is used under `read:`/`write:`, or as a `source()`/`sink()` keyword, instead of a qualified entity name. | Loading connections.yml, rendering pipeline SQL |
| `PZ0349` | SourceReadByMultiplePipelines | A source entity is read by more than one pipeline. | Compiling the DAG |
| `PZ0351` | WatermarkCeilingWithoutFloor | A `watermark()` comparison declares an upper bound on the cursor with no lower bound anywhere for that dataset. | Compiling the DAG |
| `PZ0352` | FeedsRemoved | project.yml declares the removed `feeds:` block. | Loading project.yml |

## 04xx: SQL

| Code | Name | Meaning | Where it surfaces |
|---|---|---|---|
| `PZ0401` | SqlDryCompile | A pipeline's rendered SQL fails a dry compile against DuckDB before any run starts. | `pz run`/`pz validate` pre-flight |

## 05xx: Runtime

Raised while a run executes, outside the checks family.

| Code | Name | Meaning | Where it surfaces |
|---|---|---|---|
| `PZ0500` | UnexpectedEngineFailure | An unhandled exception reached the top of the engine. | Running a command |
| `PZ0501` | NodeFailed | A node failed during a run for a reason not covered by a more specific code. | Running a node |
| `PZ0502` | NoPriorRun | `pz retry` found no readable prior run to resume from. | `pz retry` |
| `PZ0503` | PriorRunIncomplete | `pz retry`'s prior run snapshot is still marked "running": the process crashed mid-run. | `pz retry` |
| `PZ0504` | PriorRunFatal | `pz retry`'s prior run ended in an orchestrator-level fatal state. | `pz retry` |
| `PZ0505` | UnsupportedCursorType | A source's incremental cursor column landed with a DuckDB type outside int/bigint/decimal/date/timestamp. | Running a node (extraction) |
| `PZ0506` | BreakerOpen | A node's connection circuit breaker is open, so the connector was never invoked for this attempt. | Running a node |
| `PZ0507` | CdcTargetInvalid | `pz cdc drop` was not given exactly one `<connection>.<entity>` target argument. | `pz cdc drop` |
| `PZ0508` | CdcTargetNotFound | `pz cdc drop`'s target does not resolve to a declared `sync: {mode: cdc}` dataset. | `pz cdc drop` |

## 051x: Checks

Raised by `pz test`/`pz run` checks, and by `pz state`/`pz clean` state and retention
maintenance.

| Code | Name | Meaning | Where it surfaces |
|---|---|---|---|
| `PZ0510` | CheckFailed | A data-quality check found violating rows. | `pz test`, `pz run` |
| `PZ0511` | CleanSelectorConflict | `pz clean` was given both `--keep-last` and `--older-than`. | `pz clean` |
| `PZ0512` | CleanSelectorInvalid | `pz clean`'s selector argument is unusable: an unparseable or non-positive `--older-than`, or a negative `--keep-last`. | `pz clean` |
| `PZ0513` | StateKeyNotFound | `pz state`'s key names no stored watermark. | `pz state` |
| `PZ0514` | StateRollbackTargetInvalid | `pz state rollback --to-run` names a run that recorded no usable watermark for this key. | `pz state rollback` |
| `PZ0515` | StateValueInvalid | A requested state value cannot be used for this operation: unparseable for the stored cursor type, or a rollback that would move the watermark forward. | `pz state` |
| `PZ0516` | StateArgumentInvalid | A `pz state` subcommand's required argument is missing, or `--yes` was not passed on a non-interactive terminal. | `pz state` |
| `PZ0517` | StateRunInFlight | A run holds the run-directory lock, so a `pz state` edit would be overwritten by its watermark advancement. | `pz state` |
| `PZ0518` | StateStoreUnavailable | The configured state backend could not be reached, or authentication failed. | Reading or writing state |
| `PZ0519` | StateSchemaVersionMismatch | The state store's schema version is newer than this build understands, or a forward migration failed partway. | Reading or writing state |
| `PZ0520` | StateConcurrencyConflict | A keyed-state write lost its optimistic-concurrency check because another run advanced the same dataset concurrently. | Writing state |
| `PZ0521` | MergeKeyNull | A `strategy: merge` write's staged input has NULL values in a declared merge key column. | Running a node (write) |
| `PZ0522` | MergeKeyDuplicates | A `strategy: merge` write's staged input holds duplicate merge-key groups, which collapse to one survivor. A warning, not a failure. | Running a node (write) |
| `PZ0523` | LossyIntegerInference | A contract-less csv/json read's auto-detected DOUBLE column holds only whole numbers beyond 2^53, where digits may already be lost. A warning. | Running a node (extraction) |
| `PZ0524` | AmbiguousDateInference | A contract-less csv read's sniffed date format is day-first/month-first and every value was ambiguous. A warning. | Running a node (extraction) |

## 06xx: MCP

The `pz mcp` authoring and verification surface. Every other error an MCP tool returns is one of
the codes above, unchanged. See the [MCP contract](/reference/mcp-contract/) for the full tool
table.

| Code | Name | Meaning | Where it surfaces |
|---|---|---|---|
| `PZ0601` | McpLiteralCredential | A connection mutation's proposed value looks like a literal credential typed into YAML instead of a `${VAR}` reference. | `pz mcp` Author tools |
| `PZ0602` | McpMutationTarget | An MCP mutation's target is inconsistent with the operation: the name already exists, or it doesn't. | `pz mcp` Author tools |
| `PZ0603` | McpInitDirNotEmpty | `pz_init_project`'s target directory exists and is not empty. | `pz mcp` Author tools |
| `PZ0604` | McpRunLockHeld | A gated execution tool was called while another run already holds the run-directory lock. | `pz mcp` Execute tools |
| `PZ0605` | McpClientConfigInvalid | `pz mcp init`'s client-setup surface is invalid: an unparseable client config file, or an invocation naming no client and no `--all`. | `pz mcp init` |
| `PZ0606` | McpPathEscapesProject | A localfiles path resolves outside the project directory. | `pz mcp` tools |
| `PZ0607` | McpDocsUnavailable | The documentation tools could not reach the documentation site. | `pz mcp` documentation tools |
| `PZ0608` | McpDocsRequestInvalid | A documentation request the catalog cannot answer: an unknown slug, or an empty search query. | `pz mcp` documentation tools |
| `PZ0609` | McpToolFailed | A tool handler failed with an exception no handler-level catch classified. | Any `pz mcp` tool |

## Retired codes

These numbers are never reallocated. Each was superseded by a broader rule that makes the old
condition unreachable.

| Code | Old name | Superseded by |
|---|---|---|
| `PZ0203` | SinkInputMissing | The YAML `input:` binding was removed; `INSERT INTO {{ sink(...) }}` is the sole load path. |
| `PZ0207` | SinkOutputUnbound | An output now exists only because a `sink()` call declared it, so it cannot be declared unbound. |
| `PZ0226` | InconsistentIncrementalConsumers | `PZ0349` now refuses a dataset read by more than one pipeline outright. |
| `PZ0228` | WriteModeUnknown | Write strategy is a `sink()` keyword now, refused at the call site by `PZ0334`. |
| `PZ0343` | (unnamed) | `PZ0206` already refuses two pipelines claiming one output, whatever write options each passes. |

## Related

- [connections.yml reference](/reference/connections-yml/): the connections.yml keys behind the 01xx and 033x codes above.
- [Pipeline config](/reference/pipeline-config/): the sidecar checks behind the 051x `CheckFailed` codes.
- [Template functions](/reference/template-functions/): the call-site errors in the 02xx and 033x families.
- [Validation and errors](/concepts/validation-and-errors/): when each validation tier runs and how to read a reported error.
- [MCP contract](/reference/mcp-contract/): the 06xx family's tool table.
