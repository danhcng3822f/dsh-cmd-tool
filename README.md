# dsh-cmd-tool

A Windows `cmd` tool for DeepSeek Harness, sitting alongside the existing `pwsh`
tool.

The package registers two loader entries through `cordis.patch.yml`:

| Row id | Loader specifier | Role |
|---|---|---|
| `cmd-sandbox` | `dsh-cmd-tool/executor` | `ctx.shell` provider: `CmdSandboxExecutor` |
| `tool-cmd` | `dsh-cmd-tool/tool` | the model-facing `cmd` tool |

`ctx.shell` admits exactly one provider, so the executor **replaces** the
PowerShell-only `pwsh-sandbox` row rather than joining it. The patch disables
that row and inserts its own. `CmdSandboxExecutor` subclasses
`SandboxPwshExecutor` and overrides only the `argv()` seam, so it keeps every
inherited mechanic — ACL confinement, denial and runner-failure classification,
deadlines, spill files, background process handles — and still serves the
PowerShell dialect for every command that does not carry this package's
internal marker. The untouched `pwsh` tool therefore behaves exactly as before.

## Why the command goes through a temporary script

`cmd.exe` re-parses its own command line with rules that are incompatible with
the CRT/`CommandLineToArgvW` quoting that Node and the Windows ACL runner both
apply. Handing the model's command text to `cmd.exe` as an argv element is
therefore not viable. This was measured on the target machine, not assumed:

| Strategy | `echo "hello world"` | `dir "C:\Program Files"` | `if exist "C:\Windows"` | `%USERNAME%` |
|---|---|---|---|---|
| `cmd /d /s /c <text>` (Node default quoting) | `\"hello world\"` ✗ | syntax error ✗ | `NO` ✗ | ok |
| `cmd /d /c <text>` with `windowsVerbatimArguments` | ok | ok | ok | ok |
| `cmd /c %DSH_CMD%` (env var) | ok | ok | ok | `%USERNAME%` ✗ |
| `cmd /c call %DSH_CMD%` (env var, second expansion) | ok | ok | ok | `'if' is not recognized` ✗ |
| `cmd /d` with the text piped to stdin | noisy banner + command echo ✗ | — | — | — |
| **`cmd /d /c <temp .cmd file>`** | **ok** | **ok** | **ok** | **ok** |

Two further findings rule out the surviving alternatives:

- `windowsVerbatimArguments` is not reachable. `SubprocessSpawnSpec` exposes
  `argv` only, and `subprocess-local` calls `spawn(program, args, …)` with no
  such option. Even if it were reachable, `sandbox-windows-acl`'s runner
  rebuilds the child command line with its own CRT `buildCommandLine()`, so the
  text would be re-mangled on the way to `cmd.exe` under every confined mode.
- Env-var indirection either loses `%VAR%` expansion or breaks command
  keywords, both of which the model relies on.

**So:** the tool writes the command text to a temporary `.cmd` file and the
executor runs `cmd.exe /d /c <path>`. The path carries no quote characters, so
CRT quoting round-trips it exactly and `cmd.exe` reads the command text verbatim
from disk. The file is UTF-8 **without** a BOM — a BOM would corrupt the first
line — with CRLF line endings, and opens with `@echo off` so the interpreter
does not echo each command into the model's output. `/d` skips AutoRun; `/c` is
used **without** `/s`, because `/s` would strip the outer quotes of a script
path containing spaces while cmd's own default rule strips them correctly.

The tool and the executor share one fact — the marker prefix
`dsh-cmd-script:` — through `src/protocol.ts`. That marker is an internal
protocol between this package's two entries and **must never reach the model**:
the tool supplies its own job label, call card, and rendered output from the
user's real command text.

## Batch semantics

The accepted consequence of the design is that the command executes with
**batch-file semantics**, not interactive-prompt semantics. Two differences
matter in practice:

- **`for` loop variables need a doubled percent: `%%i`, not `%i`.** A doubled
  percent is also the escape for a literal `%`. Write
  `for %%i in (a b) do @echo item=%%i`.
- **`%0` and `%~dp0` name the harness's own temporary script file**, not the
  workspace or the caller. Use `%CD%` for the working directory.

`%VAR%` expands environment variables normally; `!VAR!` requires
`setlocal enabledelayedexpansion` first. Both of these differences are stated in
the tool description the model sees, so the model is not left to discover them.

## Install

### 1. Register the bundle in the profile

Edit `$DSH_HOME/profiles/web/package.json` (on this machine,
`C:\Users\Admin\.dsh\profiles\web\package.json`):

- add to `dependencies`: `"dsh-cmd-tool": "link:D:/dsh-cmd-plugin"`
- append `"dsh-cmd-tool"` to the **end** of the `dsh.profile.bundles` array

The position matters: the bundle must come **after** `@deepseek-ai/dsh-base`,
because the patch layer it contributes disables a row that the base bundle
inserts. Then install the link:

```powershell
cd C:\Users\Admin\.dsh\profiles\web
pnpm install
```

### 2. Restart `dsh web`

`dsh.profile.bundles` is read at boot and does **not** hot-reload. (The
profile's own `cordis.patch.yml` does hot-reload; the bundle list does not.)
Restart the server before expecting the `cmd` tool to appear.

### 3. Verify the composed tree

Before or after restarting, the composed configuration can be dumped without
booting the server:

```powershell
cd D:\deepseek-harness
node --import tsx/esm apps/cli/src/bin.ts --profile web --dump-config > $env:TEMP\web-composed.yml
Select-String -Path $env:TEMP\web-composed.yml -Pattern 'pwsh-sandbox|cmd-sandbox|tool-cmd' -Context 0,4
```

Expected: a `pwsh-sandbox` row carrying `disabled: true`, plus a `cmd-sandbox`
row named `dsh-cmd-tool/executor` and a `tool-cmd` row named
`dsh-cmd-tool/tool`.

If the `pwsh-sandbox` patch reports **"entry not found"**, stop: the executor
row would then collide with the base bundle's registration on `ctx.shell`, and
the next boot would fail. Report the drift rather than working around it.

### Why `cmd` appears even though `tool-pwsh` is disabled

Both rows this bundle inserts land on the **host plane**, so the `cmd` tool is
registered in the host `tools` registry and is visible to every session.

The `pwsh` tool is not: `@deepseek-ai/dsh-web-app` disables the host-plane
`tool-pwsh`, `tool-bash`, and `tool-jobs` rows, and the Web surface mounts them
per-session through an **agent preset** instead — for the default `standard`
preset, `apps/cli/config/agent-presets/standard/agent.cordis.yml` in the DSH
checkout. That preset's `tool-pwsh` consumes the host-plane `ctx.shell` this
bundle provides, which is why replacing `pwsh-sandbox` keeps `pwsh` working
rather than breaking it. A `--dump-config` dump shows only the host composition,
so a disabled `tool-pwsh` row there is expected and does not mean the `pwsh`
tool is gone.

### The `node_modules/@deepseek-ai` junction

`node_modules/@deepseek-ai` in this package is a **junction** to
`C:\Users\Admin\.dsh\profiles\node_modules\@deepseek-ai`. That is how
`@deepseek-ai/*` imports resolve to the exact modules the running dsh loads.
There is deliberately **no** `@deepseek-ai/*` entry in `dependencies`: installing
those from npm risks a second `cordis` instance, which breaks the plugin tree.

**`npm ci` deletes `node_modules/` and therefore destroys this junction.** If
the junction is missing after any dependency operation, recreate it:

```powershell
New-Item -ItemType Junction -Path D:\dsh-cmd-plugin\node_modules\@deepseek-ai -Target C:\Users\Admin\.dsh\profiles\node_modules\@deepseek-ai
```

Confirm it resolves to the harness packages rather than to a copy:

```powershell
node -e "console.log(require.resolve('@deepseek-ai/dsh-pwsh-sandbox/package.json',{paths:['D:/dsh-cmd-plugin']}))"
```

Order matters when setting up from scratch: run `npm install` **first**, then
create the junction, because `npm install` may prune unknown entries under
`node_modules`.

## Configuration

The tool (`tool-cmd`) row:

| Knob | Default | Effect |
|---|---|---|
| `enableRunInBackground` | `true` | Advertise and accept `run_in_background`. When `false` the parameter is omitted from the schema *and* rejected at execute time. |
| `setCodePage` | `true` | Emit the script's `chcp` line. |
| `codePage` | `65001` | The code page that line sets (UTF-8, which is what the subprocess collector decodes). |
| `scriptDir` | `<os.tmpdir()>/dsh-cmd` | Root directory for per-process temp script directories. |

The executor (`cmd-sandbox`) row:

| Knob | Default | Effect |
|---|---|---|
| `cmdPath` | resolved | Explicit `cmd.exe`. When omitted, `%ComSpec%` is probed first and then `<SystemRoot>\System32\cmd.exe`; failing both, the bare name `cmd.exe` is left to PATH resolution. |

The executor also inherits every `dsh-pwsh-local` knob through
`SandboxPwshExecutor.Config`: `cwd`, `timeoutMs`, `maxTimeoutMs`,
`maxOutputBytes`, `maxSpillBytes`, `graceMs`, and `pwshPath`.

**`cmdPath` and `codePage` are composition-entry knobs only, not `settings.yaml`
knobs.** `codePage` belongs to the tool, and `dsh-tool-pwsh`'s shape — which
this tool mirrors — installs no settings section at all, so the tool's
configuration comes from the composition entry. `cmdPath` belongs to the
executor, whose inherited constructor registers the `shell` settings namespace
with `dsh-pwsh-local`'s schema, and that schema does not declare this field.

Override either by editing the row in a profile's own `cordis.patch.yml`,
restating the whole `config` value — a patch replaces a row's config rather than
merging it.

## Known limitations

- **The renderers are frozen copies.** `src/render.ts` and `src/background.ts`
  are deliberate twins of `@deepseek-ai/dsh-tool-pwsh`'s files, because
  `dsh-tool-pwsh` exports no `./render` subpath and its `./src/*` is TypeScript
  source a built install cannot load. An upstream rendering fix will therefore
  **not** reach this package; it has to be ported by hand.
- **Upstream coupling.** The package subclasses `SandboxPwshExecutor` and
  disables the `pwsh-sandbox` row. A DSH release that renames that row or
  changes `SandboxPwshExecutor.argv` requires revisiting this package. The
  failure mode is a **loud boot failure on duplicate `ctx.shell`** (the `shell`
  service admits exactly one provider, and mounting both fails on duplicate
  service registration) — never a silent one.
- **`engines.node` declares `>=22.0.0`, but the committed vitest pulls a vite
  that wants `>=22.12.0`** (vite 7.3.6 declares
  `^20.19.0 || >=22.12.0`). This is dev-only: the published package's runtime
  requirement is the declared `>=22.0.0`. Relatedly, `npm run check` does not
  typecheck `tests/` — `tsconfig.json` includes only `src/**/*.ts`.
- **Temp-script lifetime.** Scripts live under
  `<os.tmpdir()>/dsh-cmd/<pid>/` and are removed when the call settles
  (background calls dispose theirs with the job). Removal is best-effort: a
  just-exited `cmd.exe` or a scanner can still hold the file, and a removal
  failure leaves a file behind until the 24-hour prune
  (`pruneStaleScriptDirs`, which uses directory age because a dead pid cannot be
  told apart from a reused one). Scripts also live outside the workspace; reads
  are unrestricted in both confined modes, so the confined child can always read
  its own script, while the write happens in the unconfined host process.
- **`chcp` changes the code page of the console shared with the host terminal** —
  the same side effect `pwsh-local`'s encoding preamble already has. Set
  `setCodePage: false` to suppress it.
- **The integration suite self-skips off Windows** (`describe.skipIf(process.platform !== 'win32')`).
  That skip path is **unverified on this host**, which is Windows-only: the
  suite has never actually been observed taking the skip branch here.
- **Cost.** One extra file write per call, and one unlink. A foreground call
  does both inside the call; a background call holds the file until its process
  settles.

## Tests

```powershell
cd D:\dsh-cmd-plugin
npx vitest run       # 76 tests across 7 files
npm run check        # tsc --noEmit over src/ only
```

If `node_modules` is missing, run `npm install` **first** and then recreate the
`@deepseek-ai` junction (see above) — `npm install` can prune it.

`tests/integration.spec.ts` exercises a **real `cmd.exe`** through the real
`CmdSandboxExecutor` and `ctx.tools.execute()`: quoted paths containing spaces,
`%VAR%` expansion, `if exist … else`, a multi-line `if` block, `for %%i` over a
set, output redirection, `exit /b N`, a command whose last status is non-zero,
Unicode echo, `workdir` honored, and a background job collected with
`job_output` and stopped with `job_kill`. It also proves the PowerShell dialect
still runs through the same executor. The suite self-skips off Windows, so a
green run on Windows is the only run that proves anything.

The remaining six suites are platform-independent and use a fake executor or
pure functions: `protocol.spec.ts` (marker round-trip), `resolve.spec.ts`
(`cmd.exe` resolution branches), `script.spec.ts` (script body, encoding, CRLF
normalization, disposal, prune), `render.spec.ts` (result rendering),
`executor.spec.ts` (the `argv` override), and `tool.spec.ts` (the consumer
surface — registration, validation, escalation gating, disposal on every path,
`presentResult`).

## Build

```powershell
npm run build
```

`tsc -p tsconfig.json` compiles `src/` to `lib/` (NodeNext, declarations to
`lib/types/`). The two loader entries resolve to `lib/executor.js` and
`lib/tool.js` through the package's `exports` map.

## License

MIT
