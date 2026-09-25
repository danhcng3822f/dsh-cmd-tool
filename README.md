# dsh-cmd-tool

A Windows `cmd` tool for DeepSeek Harness, sitting alongside the existing `pwsh`
tool.

The package registers two loader entries through `cordis.patch.yml`:

| Row id | Loader specifier | Role |
|---|---|---|
| `cmd-sandbox` | `dsh-cmd-tool/executor` | `ctx.shell` provider: `CmdSandboxExecutor` |
| `tool-cmd` | `dsh-cmd-tool` | the model-facing `cmd` tool |

The tool row's specifier is the **bare package name**, and that is load-bearing:
`dsh-client-modules` discovers a browser half by walking the host Loader's
entries and resolving each entry's `name` as a *package root*. A subpath entry
never resolves, and its package is then permanently treated as having no client
row — so `dsh-cmd-tool/tool` here would silently cost this package its `Cmd`
row in the Web UI. The package root (`src/index.ts`) re-exports the tool module
for exactly this reason, and the executor stays a subpath entry.

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

### The short way

```powershell
cd D:\dsh-cmd-plugin
.\install.ps1                 # Windows PowerShell
```

```sh
cd /d/dsh-cmd-plugin
./install.sh                  # Git Bash
```

Either wrapper does steps 1–3 below — build, register, link — and then tells you
to restart `dsh`. It is idempotent (re-running never duplicates the entry),
takes `--profile <name>` (default `web`) and `--home <path>` (default
`$DSH_HOME`, else `~/.dsh`), and `--uninstall` reverses it.

The logic lives in `scripts/install.mjs` and the two wrappers only forward to
it, for two reasons: the profile manifest is JSON, and editing JSON portably
needs either `jq` (not guaranteed) or Node (guaranteed — dsh runs on it); and
this plugin is **Windows-only** while bash is not installed there by default.
Under Git Bash the `.sh` wrapper works; under WSL it does not, because the
Windows paths this plugin needs do not exist there.

**No script restarts `dsh`.** The running server hosts the shell that invoked
the installer, so it cannot restart itself; the last step is always yours.

### The long way

The package's `exports` point into `lib/` (`.` → `lib/index.js`, `./executor` →
`lib/executor.js`) and `.gitignore` excludes `lib/`. A fresh clone therefore has
no loadable entry point at all, and registering the bundle before building it
produces a loader failure for a missing `dsh-cmd-tool`. Building is the **first**
install step, not an afterthought.

### 1. Build the package

```powershell
cd D:\dsh-cmd-plugin
npm run build
```

`tsc -p tsconfig.json` compiles the host half (`src/`) to `lib/` (NodeNext,
declarations to `lib/types/`), and `node build-client.mjs` bundles the browser
half (`src/client/`) into `lib/client.js`. The loader entries and the client
entry then resolve through the package's `exports` map.

The build needs `node_modules`, so `npm install` comes first — see **How
`@deepseek-ai` imports resolve** below for why that is safe and what those
dependencies are.

`npm run check` type-checks both halves. The host `tsconfig.json` deliberately
excludes `src/client/**` (that half needs JSX and DOM libs); the client config
`tsconfig.client.json` covers it.

Nothing watches `src/`. Rebuild and restart after every change there, or the
running server keeps loading the previous `lib/`.

### 2. Register the bundle in the profile

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

### 3. Restart `dsh web`

`dsh.profile.bundles` is read at boot and does **not** hot-reload. (The
profile's own `cordis.patch.yml` does hot-reload; the bundle list does not.)
Restart the server before expecting the `cmd` tool to appear.

The same restart covers the browser half: the shell composes its client-plugin
graph at boot from the installed `dsh.client` declarations. After the restart,
**reload the page** — the browser is running the previously served bundle.

### 4. Verify the composed tree

Before or after restarting, the composed configuration can be dumped without
booting the server:

```powershell
cd D:\deepseek-harness
node --import tsx/esm apps/cli/src/bin.ts --profile web --dump-config > $env:TEMP\web-composed.yml
Select-String -Path $env:TEMP\web-composed.yml -Pattern 'pwsh-sandbox|cmd-sandbox|tool-cmd' -Context 0,4
```

Expected: a `pwsh-sandbox` row carrying `disabled: true`, plus a `cmd-sandbox`
row named `dsh-cmd-tool/executor` and a `tool-cmd` row named `dsh-cmd-tool`.

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

### The `Cmd` row in the Web UI

Without the browser half this package ships, a `cmd` call renders as a generic
**"Tool call"** row. The Web client classifies a tool row through a table
private to `dsh-client-ui-tool` (`TOOL_VARIANTS` / `TOOL_TITLES`); an unlisted
tool name falls to the `others` variant, whose title is the literal "Tool
call". Worse, because the generic card prefers the terminal view's description
over the args-derived summary, the tool's own name never reaches the row at
all — `toolName` is only a `data-tool` attribute.

The designed remedy is the keyed `tool.call.toolview` seat: **a registered key
replaces the generic row**. `src/client/` registers the `cmd` key with a row
titled **"Cmd"**, carrying the call's terminal card, so it sits beside the
`Bash` and `Pwsh` rows as one of the shell tools rather than as an unclassified
one.

That half is a separate build and a separate lifecycle:

- `node build-client.mjs` bundles `src/client/index.tsx` into `lib/client.js`
  (esbuild, CommonJS closure factory, externals read live from the shell's own
  `PLATFORM_MODULES` list so module identities cannot drift). `npm run build`
  runs it after `tsc`.
- `package.json`'s `dsh.client` block declares the platform (`web`) and the
  client plugins that must mount first, which is how the shell's module scan
  discovers this half. **That scan runs at boot**, so adding or removing the
  block needs a server restart.
- It composes the row from platform modules only
  (`@deepseek-ai/dsh-client-ui-primitives` for `DisclosureRow`, `StateDot`,
  `TerminalBlock`, and the icons; `@deepseek-ai/dsh-client-ui-slots` for the
  locale seat). `dsh-client-ui-tool` is not a shared platform module, so its
  row components and card models are not importable from here — hence the
  reimplementation in `src/client/CmdRow.tsx`.
- The row carries its own locale namespace (`cmd-tool`) rather than borrowing
  the conversation one, whose dictionary is likewise not importable. Its
  terminal strings are copied from that dictionary on purpose:
  `TerminalBlock`'s built-in label defaults are Chinese, so omitting `labels`
  would silently mix languages into an English UI.
- Styling is inline, not a CSS module: a CSS import would make esbuild emit a
  sibling stylesheet that nothing loads. The row chrome comes from
  `DisclosureRow`, whose styles ship with the shell.

### How `@deepseek-ai` imports resolve

Every `@deepseek-ai/*` package this plugin imports is declared in
`dependencies` as a **`file:` link straight to its directory in the DSH
checkout** — for example `"@deepseek-ai/dsh-pwsh-sandbox":
"file:D:/deepseek-harness/packages/shell/pwsh-sandbox"`. npm symlinks those, so
the imports resolve to the exact modules the running dsh loads.

Installing the same packages from npm is what this avoids: a second copy of
`@deepseek-ai/cordis` in the tree breaks the plugin. Pin the checkout you are
actually running.

Those paths are absolute and machine-specific — `D:/deepseek-harness` is this
machine's checkout. On another machine, rewrite the `file:` paths (or re-run
the generator that produced them) before `npm install`.

> **Do not replace these with a `node_modules/@deepseek-ai` junction to
> `$DSH_HOME/profiles/node_modules/@deepseek-ai`.** That was this package's
> first design and it is destructive: `npm install` treats the junction target
> as its own tree, prunes the symlinks inside it, and **empties the DSH module
> fallback for every package that resolves through it** — not just this one. If
> that ever happens, the fallback is rebuilt at the next dsh boot by
> `healProfilesModuleFallback`; to repair it without a restart, run that export
> from the checkout's built `@deepseek-ai/dsh-app-boot` with the app manifest
> path (`apps/cli/package.json`) as its argument.

Confirm resolution points at the harness packages rather than a copy:

```powershell
node -e "console.log(require.resolve('@deepseek-ai/dsh-pwsh-sandbox/package.json',{paths:['D:/dsh-cmd-plugin']}))"
```

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
- **The browser half is coupled to the client's private row table.** It exists
  precisely because `TOOL_VARIANTS` / `TOOL_TITLES` live inside
  `dsh-client-ui-tool` and cannot be extended from outside; if a future release
  makes them extensible — or simply lists `cmd` — this row becomes redundant and
  should be deleted rather than maintained. It also reimplements
  `terminalCardModel`'s derivation, because `dsh-client-ui-tool` is not a shared
  platform module; an upstream change to the `callView` / `resultView` wire
  shape would have to be ported here by hand.
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
npx vitest run       # 80 tests across 7 files
npm run check        # type-checks both halves (host + client)
```

If `node_modules` is missing, run `npm install`: the `@deepseek-ai/*`
dependencies are `file:` links, so npm restores them instead of pruning a
shared directory (see **How `@deepseek-ai` imports resolve**).

`tests/integration.spec.ts` exercises a **real `cmd.exe`** through the real
`CmdSandboxExecutor` and `ctx.tools.execute()`: quoted paths containing spaces,
`%VAR%` expansion, `if exist … else`, a multi-line `if` block, `for %%i` over a
set, output redirection, `exit /b N`, a command whose last status is non-zero,
Unicode echo, `workdir` honored, and a background job collected with
`job_output` and stopped with `job_kill`. It also proves the PowerShell dialect
still runs through the same executor. The suite self-skips off Windows, so a
green run on Windows is the only run that proves anything.

Its second block composes the same stack at **`workspace-write`** — the mode
this package ships as its default — so a marked command really does go through
the Windows ACL runner: a confined command runs and returns its output, a write
inside the workspace succeeds, and a write outside it is refused and renders
`[sandbox: file access denied under workspace-write mode]`. That block installs
`ctx.sandbox.internals.windowsAclRunnerEntry`, the core provider's own test
hook, and **only** for one reason: `dsh-sandbox-local` locates the runner with
`import.meta.resolve`, and vitest's SSR transform — which `@deepseek-ai/*`
reaches because those `file:` links resolve outside this project — rewrites
`import.meta` to a shim with no `resolve`. Without that substitution
every confined call here dies with `__vite_ssr_import_meta__.resolve is not a
function` before any runner spawns, so no suite in this package can exercise
confinement at all. The hook short-circuits that single call and substitutes the
real runner path; the runner, the restricted token, the ACL grants, and the
denial classification are all the production ones.

The remaining six suites are platform-independent and use a fake executor or
pure functions: `protocol.spec.ts` (marker round-trip), `resolve.spec.ts`
(`cmd.exe` resolution branches), `script.spec.ts` (script body, encoding, CRLF
normalization, disposal, prune), `render.spec.ts` (result rendering),
`executor.spec.ts` (the `argv` override and the composed `Config` schema), and
`tool.spec.ts` (the consumer surface — registration, validation, escalation
gating, disposal on every path, `presentResult`).

## License

MIT — see [LICENSE](LICENSE).

Copyright (c) 2026 danhcng3822f.
