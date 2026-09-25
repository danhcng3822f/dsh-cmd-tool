#!/usr/bin/env sh
# Installer wrapper for dsh-cmd-tool.
#
# All logic lives in scripts/install.mjs and this file only forwards to it.
# Two reasons it is not written in shell: the profile manifest is JSON, and
# editing JSON portably needs either jq (not guaranteed) or Node (guaranteed —
# dsh runs on it); and this plugin is Windows-only while bash is not installed
# by default there, so the PowerShell wrapper beside this one is the native
# path. Under Git Bash this works; under WSL it does not, because the Windows
# paths this plugin needs do not exist there.
set -eu

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec node "$here/scripts/install.mjs" "$@"
