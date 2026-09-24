# dsh-cmd-tool — a `cmd` tool for DeepSeek Harness on Windows

Date: 2026-09-24
Status: approved design, implementation not started

## Goal

Give the model a first-class `cmd` tool that runs Windows Command Prompt
(`cmd.exe`) commands, **alongside** the existing `pwsh` tool. Today a Windows
DSH composition mounts exactly one shell: `@deepseek-ai/dsh-pwsh-sandbox`
backing `ctx.shell` and `@deepseek-ai/dsh-tool-pwsh` exposing `pwsh`. A model
that wants `dir`, `findstr`, `robocopy`, a `.bat` script, or any of the
Windows-native tooling that assumes a Command Prompt has no way to ask for it.

## Non-goals

- Replacing or degrading the `pwsh` tool. Both tools stay available.
- A persistent `cmd` session. Each call is a fresh `cmd.exe`, matching the
  `pwsh`/`bash` contract (no cwd, variable, or function state between calls).
- POSIX support. The tool is Windows-only and refuses to register elsewhere.
- Wrapping PowerShell semantics in the `cmd` tool, or cmd semantics in `pwsh`.

## Context: how the shell seam is composed

Facts established by reading the checkout at `D:\deepseek-harness`.

1. `ctx.shell` is a single-provider capability seam
   (`packages/shell/shell/src/index.ts`). Loading a second provider throws on
   duplicate service registration.
2. `packages/bundle/base/cordis.patch.yml` selects the shell stack by platform:

   ```yaml
   - id: bash-sandbox
     name: '@deepseek-ai/dsh-bash-sandbox'
     disabled: !!js process.platform === 'win32'
   - id: pwsh-sandbox
     name: '@deepseek-ai/dsh-pwsh-sandbox'
     disabled: !!js process.platform !== 'win32'
   - id: tool-bash
     name: '@deepseek-ai/dsh-tool-bash'
     disabled: !!js process.platform === 'win32'
   - id: tool-pwsh
     name: '@deepseek-ai/dsh-tool-pwsh'
     disabled: !!js process.platform !== 'win32'
   ```

   Swapping the shell row by platform is therefore the composition's own
   established pattern, not a workaround.
3. `PwshLocalExecutor.argv(spec)` is a documented extension seam: its JSDoc
   calls it "the argv-level seam a confining subclass wraps through
   `ctx.sandbox.confine`", and `SandboxPwshExecutor` reaches it from `run()`,
   `start()`, and `confine()`. A subclass that overrides `argv()` therefore
   keeps every inherited mechanic — sandbox confinement, denial
   classification, spill files, deadlines, background process handles.
4. `PatchOptions` (`vendor/include/src/index.ts`) supports
   `disabled?: boolean | null`, and a non-insert patch sets individual keys on
   the row it names. A bundle layer can therefore disable `pwsh-sandbox` and
   insert its own rows.
5. Out-of-tree bundles are installed by listing the package in the profile's
   `dsh.profile.bundles` and adding it to the profile's dependencies.
   `$DSH_HOME/profiles/node_modules` is a flat symlink fallback holding the
   dsh app's whole dependency closure, so an out-of-tree plugin's
   `@deepseek-ai/*` imports resolve to the running installation.

## The constraint that shapes the design

`cmd.exe` re-parses its own command line with rules that are incompatible with
the CRT/`CommandLineToArgvW` quoting Node and the Windows ACL runner both use.
Passing the model's command text as an argv element is therefore not viable.
This was verified empirically on the target machine, not assumed:

| Strategy | `echo "hello world"` | `dir "C:\Program Files"` | `if exist "C:\Windows"` | `%USERNAME%` |
|---|---|---|---|---|
| `cmd /d /s /c <text>` (Node default quoting) | `\"hello world\"` ✗ | syntax error ✗ | `NO` ✗ | ok |
| `cmd /d /c <text>` with `windowsVerbatimArguments` | ok | ok | ok | ok |
| `cmd /c %DSH_CMD%` (env var) | ok | ok | ok | `%USERNAME%` ✗ |
| `cmd /c call %DSH_CMD%` (env var, second expansion) | ok | ok | `'if' is not recognized` ✗ | ok |
| `cmd /d` with the text piped to stdin | noisy banner + command echo ✗ | — | — | — |
| **`cmd /d /c <temp .cmd file>`** | **ok** | **ok** | **ok** | **ok** |

Two further findings rule out the surviving alternatives:

- `windowsVerbatimArguments` is not reachable. `SubprocessSpawnSpec`
  (`packages/subprocess/subprocess/src/types.ts`) exposes `argv` only, and
  `subprocess-local` calls `spawn(program, args, …)` with no such option. Even
  if it were, `sandbox-windows-acl`'s runner rebuilds the child command line
  with its own CRT `buildCommandLine()` (`sandbox-windows-acl/src/spawn.ts`),
  so the text would be re-mangled on the way to `cmd.exe` under every confined
  mode.
- Env-var indirection loses `%VAR%` expansion or breaks command keywords,
  both of which the model relies on.

**Decision: the tool writes the command to a temporary `.cmd` file and the
executor runs `cmd.exe /d /c <path>`.** The path carries no quote characters,
so CRT quoting round-trips it exactly, and `cmd.exe` sees the command text
verbatim from disk.

Accepted consequence: the command executes with **batch-file semantics**. In
particular `for` loop variables must be written `%%i`, not the interactive
`%i`. This is a genuine, unavoidable semantic difference and must be stated in
the tool description rather than papered over.

## Architecture

One package, `dsh-cmd-tool`, providing two loader entries — mirroring the
core's own `pwsh-sandbox` + `tool-pwsh` split.

```
D:\dsh-cmd-plugin\
  package.json            dsh.bundle.patch, exports ./executor and ./tool
  cordis.patch.yml        disable pwsh-sandbox; insert cmd-sandbox + tool-cmd
  tsconfig.json           src/ -> lib/ (NodeNext, declaration)
  vitest.config.ts
  README.md
  src/
    protocol.ts           the internal marker shared by tool and executor
    resolve.ts            cmd.exe resolution (ComSpec / SystemRoot)
    script.ts             temp .cmd writer: content, encoding, lifetime
    executor.ts           CmdSandboxExecutor extends SandboxPwshExecutor
    tool.ts               the `cmd` tool
    render.ts             model-facing result rendering
    background.ts         ShellProcess -> ctx.jobs adaptation
  tests/
    script.spec.ts
    executor.spec.ts
    tool.spec.ts
    integration.spec.ts
```

### `cordis.patch.yml`

```yaml
- id: pwsh-sandbox
  disabled: true
- insert:
    - id: cmd-sandbox
      name: dsh-cmd-tool/executor
    - id: tool-cmd
      name: dsh-cmd-tool/tool
```

Applied after `@deepseek-ai/dsh-base` (the profile lists bundles in order, so
this bundle must be listed after the base bundle). `pwsh-sandbox` is disabled
rather than duplicated because `ctx.shell` admits one provider.

### `src/protocol.ts`

```ts
export const CMD_SCRIPT_MARKER = 'dsh-cmd-script:'
```

The tool sends `command = CMD_SCRIPT_MARKER + scriptPath`; the executor strips
it. This is the only coupling between the two entries and it never reaches the
model: the tool supplies its own job label, call-card title, and rendered
output from the user's real command text.

### `src/executor.ts`

```ts
export class CmdSandboxExecutor extends SandboxPwshExecutor {
  protected override argv(spec: ShellExecSpec): string[] {
    if (!spec.command.startsWith(CMD_SCRIPT_MARKER)) return super.argv(spec)
    return [this.cmdPath, '/d', '/c', spec.command.slice(CMD_SCRIPT_MARKER.length)]
  }
}
```

- Unmarked commands keep the inherited PowerShell argv, so the untouched
  `pwsh` tool behaves exactly as before.
- `run()`, `start()`, and `confine()` are all inherited unchanged and all route
  through the override, so sandbox confinement, `sandbox` result facts,
  `runnerFailed` classification, spill files, deadlines, and background
  handles come for free.
- `sandboxMode` still reports the policy default, so the tool advertises the
  same escalation surface as `pwsh`.
- `static override inject` stays `['subprocess', 'sandbox', 'sandboxPolicy']`,
  inherited from `SandboxPwshExecutor` — the executor needs no new service.
- Config is `dsh-pwsh-local`'s `Config` plus `cmdPath?: string`. Because the
  inherited constructor installs the settings section under the parent's
  schema, `cmdPath` is a composition-entry knob only; this is documented in
  the README.
- `resolveCmdPath(configured?, env?, platform?)` lives in `resolve.ts` and is
  dependency-free, mirroring `pwsh-local/src/resolve.ts`: explicit config,
  else `%ComSpec%`, else `<SystemRoot>\System32\cmd.exe`, else bare `cmd.exe`.

### `src/script.ts`

```ts
export interface WrittenScript { path: string; dispose(): Promise<void> }
export function writeCommandScript(command: string, options: ScriptOptions): Promise<WrittenScript>
```

- Directory: `join(scriptDir, String(process.pid))`, `scriptDir` defaulting to
  `join(os.tmpdir(), 'dsh-cmd')`. Created lazily with `mkdir -p` semantics.
- File name: `<counter>-<random>.cmd`, so concurrent calls never collide.
- Contents, in order:
  1. `@echo off` — first line, so the batch interpreter does not echo the
     commands into the model's output.
  2. `chcp <codePage>>nul` — only when `codePage` is a number (default 65001).
     Written so `cmd.exe` decodes the rest of the file and encodes its output
     as UTF-8, which is what the subprocess collector assumes. Mirrors the
     intent of `pwsh-local`'s `ENCODING_PREAMBLE`.
  3. The model's command, newline-normalized to CRLF.
- Encoding: **UTF-8 without BOM** (a BOM would corrupt the first line).
- `dispose()` unlinks the file, ignoring `ENOENT`.
- The tool removes its process directory on plugin unload via `ctx.effect`, and
  best-effort prunes `dsh-cmd/<pid>` directories whose last-write time is
  older than a bounded age (a dead pid cannot be told apart from a reused one,
  so age — not liveness — is the criterion).

### `src/tool.ts`

A `cmd` tool that mirrors `dsh-tool-pwsh` call-for-call, differing only in
what it does with the command text.

- `inject`: `['tools', 'shell', 'systemPrompt', 'shellEnv']`.
- Config:

  | Key | Default | Meaning |
  |---|---:|---|
  | `enableRunInBackground` | `true` | Expose `run_in_background`; disabled calls are also rejected. |
  | `codePage` | `65001` | Code page set by the script's `chcp` line; `false` omits the line entirely. |
  | `scriptDir` | `<os.tmpdir()>/dsh-cmd` | Root under which per-process script directories are created. |

- Registers `declare module '@deepseek-ai/dsh-jobs' { interface JobKindMap { cmd: 'cmd' } }`,
  so job ids read `cmd-1`, `cmd-2`, …
- Parameters: `command`, `description`, `timeoutMs`, `workdir`,
  `run_in_background` (when enabled), and `sandbox_permissions` +
  `justification` (when the mounted executor confines) — identical shape and
  validation to `pwsh`, including `validateEscalationArgs` and the
  `approveEscalation` flow through `ctx.approval`.
- `output.schema` is the same union as `pwsh`'s (background handle |
  foreground result), so the existing terminal/generic cards and the
  exit-status pill work without client changes.
- Execute path: validate → resolve sandbox policy → write the script →
  `ctx.shell.resolve({ command: MARKER + path, workdir, timeoutMs, dshEnv,
  sandboxPolicy })` → `ctx.shell.run(...)` or `ctx.jobs.start(...)` →
  dispose the script.
  - Foreground: dispose in a `finally`, so a timeout, abort, or throw still
    removes the file.
  - Background: hand the `ShellProcess` to `ctx.jobs` as the `pwsh` tool does,
    and dispose the script once `proc.done` settles.
- `presentCall` / `presentResult` mirror `pwsh`: terminal card with the
  exit-status pill for completed foreground calls, generic console card for
  background acknowledgements and errors.
- A `tool:cmd` system-prompt section is registered (order 106) covering the
  exit-marker and force-kill conventions.

The tool's description states, explicitly:

- It runs a **batch script** through `cmd.exe /d /c`; `for` variables use
  `%%i`.
- `%VAR%` expands normally; `!VAR!` requires
  `setlocal enabledelayedexpansion`.
- Paths are native Windows form (`C:\...`); the managed environment is
  `%DSH_*%`.
- Each call is a fresh `cmd.exe`; pass `workdir` instead of `cd`.
- `%0` / `%~dp0` point at the harness's temporary script, not the workspace;
  `%CD%` is the working directory.
- Non-zero exits are reported as `[exit code: N]`.
- The sandbox, output-truncation, and escalation paragraphs are carried over
  from the `pwsh` description, since the confinement machinery is the same.
- For PowerShell syntax, use the `pwsh` tool.

## Data flow

```
model
  └─ cmd(command="dir \"C:\Program Files\" | findstr /i windows", workdir=…)
       ├─ tool: write %TEMP%\dsh-cmd\<pid>\<n>.cmd  ( @echo off / chcp / command )
       ├─ tool: ctx.shell.resolve({ command: "dsh-cmd-script:<path>", … })
       ├─ executor.argv → [cmd.exe, /d, /c, <path>]
       ├─ executor.confine(argv) → ACL runner argv          (confining modes only)
       ├─ ctx.subprocess.spawn → collected stdout/stderr + exit facts
       └─ tool: dispose script, render [exit code: N]
```

## Error handling

- **Non-Windows host**: `apply()` throws at load with a message naming the
  platform requirement, rather than registering a tool that cannot work.
- **`cmd.exe` unresolvable**: `resolveCmdPath` falls back to bare `cmd.exe`,
  so a PATH-resolvable command still works; a spawn failure surfaces through
  the existing subprocess error path.
- **Script write failure** (temp dir unwritable): the tool throws before
  executing; the message names the path and the underlying error.
- **Sandbox denial**: unchanged from `pwsh` — `[sandbox: file access denied
  under <mode> mode]`, with the same-turn `sandbox_permissions` escalation.
- **Row-id drift**: if a future DSH release renames `pwsh-sandbox`, the patch
  warns "entry not found" and our executor is inserted alongside the original,
  which fails loud on duplicate `ctx.shell` registration. A silent fallback
  would be worse; the README documents the symptom and the fix.

## Testing

- **`script.spec.ts`** (pure): first line is exactly `@echo off`; no BOM;
  CRLF normalization of `\n` and lone `\r`; `chcp` line present only when
  configured and always `>nul`; unique file names; `dispose()` is idempotent;
  a command containing `%`, `"`, `&`, `|`, and Unicode survives byte-for-byte.
- **`executor.spec.ts`** (fake executor): an unmarked command produces the
  inherited PowerShell argv; a marked command produces
  `[cmd.exe, /d, /c, <path>]` with the marker stripped; the override is
  reached from both `run()` and `start()`.
- **`tool.spec.ts`** (consumer surface): the tool registers with its schema
  and prompt section; argument validation rejects empty `command` /
  `description` and non-positive `timeoutMs`; escalation arguments are
  validated and unadvertised without a confining executor; the script is
  disposed on success, on failure, and on timeout; `presentResult` parses the
  exit pill and falls back to the generic card.
- **`integration.spec.ts`** (real `cmd.exe`, `describe.skipIf` off-Windows):
  through the real executor and `ctx.tools.execute()`, assert — quoted paths
  with spaces, `%VAR%` expansion, `if exist … else`, a multi-line `if` block,
  `for %%i` over a set, output redirect, `exit /b N`, a command whose last
  status is non-zero, Unicode echo, `workdir` honored, and a background job
  collected with `job_output` and stopped with `job_kill`.

## Installation

1. `node_modules/@deepseek-ai` in this package is a junction to
   `$DSH_HOME/profiles/node_modules/@deepseek-ai`, so `@deepseek-ai/*` imports
   resolve to the exact packages the running dsh loads. Installing them from
   npm instead risks a second `cordis` instance.
2. Add to `$DSH_HOME/profiles/web/package.json`:
   - `dependencies`: `"dsh-cmd-tool": "link:D:/dsh-cmd-plugin"`
   - `dsh.profile.bundles`: append `"dsh-cmd-tool"` **after**
     `@deepseek-ai/dsh-base`
3. `pnpm install` in the profile directory (or `dsh plugin --profile web install`).
4. **Restart** `dsh web`. `dsh.profile.bundles` is read at boot; the profile's
   own `cordis.patch.yml` hot-reloads, the bundle list does not.
5. Verify with `dsh --profile web --dump-config`: expect a disabled
   `pwsh-sandbox` row, a `cmd-sandbox` row, and a `tool-cmd` row.

## Known limitations

- Batch-file semantics: `for %%i`, not `%i`; `%0`/`%~dp0` name the temp script.
- One extra file write per call (and one unlink). Foreground calls pay it
  twice; background calls hold the file until the process settles.
- Temp scripts live outside the workspace. Reads are unrestricted in both
  confined modes (the Windows sandbox uses a WRITE_RESTRICTED token), so the
  confined child can always read the script; the write happens in the
  unconfined host process.
- `chcp` changes the code page of the console shared with the host terminal —
  the same side effect `pwsh-local`'s encoding preamble already has.
- `cmdPath` and `codePage` are composition-level knobs, not settings.yaml
  knobs.
- The package subclasses a core class and disables a core row, so it must be
  revisited on a DSH release that changes `SandboxPwshExecutor.argv` or the
  `pwsh-sandbox` row id.

## Alternatives considered

- **Tool-only, delegating to `ctx.shell` with a PowerShell wrapper** that
  execs `cmd.exe` on the script. Non-invasive, but silently assumes
  `ctx.shell` speaks PowerShell, and pays a `pwsh` process per call.
- **Tool-only with its own runner** over `ctx.subprocess` + `ctx.sandbox`.
  No core coupling at all, but duplicates roughly 400 lines of executor
  mechanics (collection, spill, deadlines, background handles, denial
  classification) that would then drift from the core.
- **`ctx.isolate('shell')` with a second executor in an isolated context.**
  Would keep the `pwsh-sandbox` row, but collides on the shared
  `shell` settings namespace and depends on isolation semantics that no
  shipped composition exercises.
- **Monkey-patching the mounted `ctx.shell` instance's `argv`.** Avoids the
  row patch but mutates another plugin's service at runtime, which the
  composition's explicit-row model exists to avoid.
