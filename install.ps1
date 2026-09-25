# Installer wrapper for dsh-cmd-tool.
#
# All logic lives in scripts/install.mjs and this file only forwards to it, so
# the PowerShell and bash entry points cannot drift apart. See the module's own
# doc block for why the installer is Node rather than shell.
#
# Usage:
#   .\install.ps1
#   .\install.ps1 -Profile web
#   .\install.ps1 -Uninstall

[CmdletBinding()]
param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]] $Rest
)

$ErrorActionPreference = 'Stop'

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$installer = Join-Path $here 'scripts\install.mjs'

if (-not (Test-Path $installer)) {
    Write-Error "install: $installer not found - run this from the package root"
    exit 1
}

# Forward every argument verbatim, so the Node core stays the single parser of
# its own flags (`--profile`, `--home`, `--uninstall`, `-h`).
& node $installer @Rest
exit $LASTEXITCODE
