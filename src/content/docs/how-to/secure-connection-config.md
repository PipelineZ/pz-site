---
title: "Secure connection config"
description: "How to keep credentials out of your pz project files using identity-based auth and ${VAR} environment interpolation, in order of preference."
sidebar:
  order: 10
---

How to keep credentials out of your project files. Two mechanisms, in order of preference:
identity-based auth (no secret exists at all), then `${VAR}` env interpolation (the secret
lives in the process environment, never in git).

## Prefer identity over secrets

On Azure, use managed identity so there is no password to protect:

```yaml
# connections.yml
warehouse:
  connector: sqlserver
  host: myserver.database.windows.net
  database: sales
  authentication: Active Directory Managed Identity
```

See the [sqlserver connector reference](/connectors/sqlserver/) for the user-assigned
variant, and the [azureblob connector reference](/connectors/azureblob/) for its
`auth: managed_identity` / `auth: credential_chain` modes for object storage.

## `${VAR}` environment interpolation

Every string in a connection block (and in `project.yml`'s `vars:`) may reference
environment variables:

```yaml
# connections.yml
warehouse:
  connector: sqlserver
  host: ${DB_HOST}
  database: sales
  user: ${DB_USER}
  password: ${DB_PASSWORD}
```

Rules:

- Syntax is exactly `${NAME}` (`A-Z a-z 0-9 _`, not starting with a digit).
- A referenced variable that is **not set fails validation** (UndeclaredEnvVar) before
  anything runs. A missing secret can never silently connect as the wrong thing. The
  error names the variable, never a value.
- Values are substituted in memory at load time; they are never written to `.pz/target`
  artifacts, plans, or events (secret-hygiene rules apply to interpolated values the same
  as to literal config).

## Getting secrets into the environment on a schedule

For a scheduled run on a VM, fetch secrets from Azure Key Vault into the process
environment just before launching pz. The VM's managed identity authorizes the fetch, so
no bootstrap secret exists either. In a wrapper (or a customized `run-pz.ps1`):

```powershell
$secret = Get-AzKeyVaultSecret -VaultName "my-vault" -Name "db-password" -AsPlainText
$env:DB_PASSWORD = $secret
& C:\pz\tool\pz.exe run --all --project D:\pz\projects\mart --log-format json
```

The variable exists only in that process tree and dies with it. Avoid machine-level
environment variables for secrets (`[Environment]::SetEnvironmentVariable(..., 'Machine')`)
— they are readable by every process and persist in the registry.

## What not to do

- Don't commit real hostnames-with-passwords "temporarily".
- Don't echo interpolated config in custom scripts. pz itself never logs connection
  config; keep your wrappers to the same standard.

## Related

- [connections.yml reference](/reference/connections-yml/): every reserved key and how `${VAR}` interpolation is parsed.
- [sqlserver connector reference](/connectors/sqlserver/): the full connection key table, including `authentication`.
- [azureblob connector reference](/connectors/azureblob/): the `managed_identity` and `credential_chain` auth modes.
- [Environment variables](/reference/environment-variables/): every variable `pz` itself reads, separate from your own `${VAR}` references.
- [Run on a schedule on Windows](/how-to/run-scheduled-on-windows/): fetching a secret from Key Vault into the process environment before launching pz.
