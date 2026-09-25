/**
 * Integration tests: the REAL `CmdSandboxExecutor` plus the `cmd` tool,
 * exercised through `ctx.tools.execute()` against a real cmd.exe. These verify
 * the world — that quotes survive, `%VAR%` expands, batch blocks parse, exit
 * codes render, and background jobs settle through the generic job runtime.
 * The suite self-skips off Windows.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import * as ToolJobs from '@deepseek-ai/dsh-tool-jobs'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import LocalSandbox from '@deepseek-ai/dsh-sandbox-local'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import * as ShellEnv from '@deepseek-ai/dsh-shell-env'
import * as ToolPwsh from '@deepseek-ai/dsh-tool-pwsh'
import { CMD_SCRIPT_MARKER } from '../src/protocol.ts'
import { CmdSandboxExecutor } from '../src/executor.ts'
import * as ToolCmd from '../src/tool.ts'

const testToolSignal = new AbortController().signal
const lf = (text: string): string => text.replace(/\r\n/g, '\n')

let dir: string
let ctx: Context
let counter = 0

function call(target: Context, name: string, args: unknown, agentObj?: object) {
  return target.tools.execute({
    signal: testToolSignal,
    callId: CallId(`it-${++counter}`),
    name,
    arguments: args,
    ...agentObj ? { agent: agentObj as never } : {},
  })
}

/**
 * Flatten a result's text blocks. Deliberately NOT parameterized by a
 * `Context`: unlike {@link call}, this reads nothing but its argument, so a
 * target parameter would be an unused one.
 */
function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(b => b.type === 'text').map(b => b.text).join('')
}

/**
 * Compose the real stack — the cmd-capable executor plus the `cmd` and `pwsh`
 * tools — over `root`, at `mode`. Two suites share it: the fast
 * `danger-full-access` one, and the confined one that pins the shipped default.
 * @param mode - the sandbox policy mode every call in the suite resolves to.
 * @param root - the workspace root and the session cwd.
 * @returns the mounted context.
 */
async function composeCmdStack(mode: SandboxMode, root: string): Promise<Context> {
  const mounted = new Context()
  await mounted.plugin(SystemPrompt)
  await mounted.plugin(ToolRuntime)
  // `dsh-jobs-local` refuses an OWNED job whose owner is not the exact live
  // instance `ctx.agents` holds, and the cmd tool always passes the calling
  // agent as the owner, so the registry is part of this composition rather
  // than an optional extra.
  await mounted.plugin(AgentRegistry)
  await mounted.plugin(LocalJobRegistry)
  await mounted.plugin(ToolJobs)
  await mounted.plugin(LocalSubprocessRuntime)
  await mounted.plugin(LocalSandbox)
  await mounted.plugin(SandboxPolicy, { mode, workspaceRoot: root })
  await mounted.plugin(ShellEnv)
  await mounted.plugin(CmdSandboxExecutor, { timeoutMs: 20_000, graceMs: 200 })
  await mounted.plugin(ToolCmd)
  // Mounted alongside so the dual-dialect contract is exercised, not assumed.
  await mounted.plugin(ToolPwsh)
  return mounted
}

/**
 * Supply the ONE value vitest cannot compute.
 *
 * `dsh-sandbox-local` locates the Windows ACL runner with
 * `import.meta.resolve('@deepseek-ai/dsh-sandbox-windows-acl/runner')` (in
 * `windowsAclRunnerInvocation`). This package's `@deepseek-ai/*` imports resolve
 * through the `node_modules/@deepseek-ai` junction to the real harness install,
 * so vitest does not classify them as external dependencies and runs them
 * through its SSR transform — and that transform rewrites `import.meta` to a
 * shim with no `resolve`. Every confined call made from this package therefore
 * dies with `__vite_ssr_import_meta__.resolve is not a function` before any
 * runner spawns: without this, no suite here can exercise confinement at all, at
 * any mode.
 *
 * `internals.windowsAclRunnerEntry` is the core provider's own documented test
 * hook, and it short-circuits exactly that one call, so this value is the ONLY
 * thing substituted — with the real path `import.meta.resolve` would have
 * returned. The production branch then runs unchanged: the real `lib/runner.js`,
 * the real restricted token, the real capability-SID grants, and the real
 * denial classification.
 * @param target - the mounted composition.
 */
function supplyAclRunnerEntry(target: Context): void {
  const sandbox = (target as unknown as { sandbox: { internals: { windowsAclRunnerEntry?: string } } }).sandbox
  sandbox.internals.windowsAclRunnerEntry = createRequire(import.meta.url)
    .resolve('@deepseek-ai/dsh-sandbox-windows-acl/runner')
}

describe.skipIf(process.platform !== 'win32')('cmd tool over the real cmd.exe', () => {
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-tool-cmd-'))
    await writeFile(join(dir, 'greeting.txt'), 'hello cmd\n')

    // Full access keeps the suite fast: the confinement path is the core
    // executor's own, and is pinned separately below by the workspace-write
    // suite — which is the mode this package actually ships as its default.
    ctx = await composeCmdStack('danger-full-access', dir)
  })

  afterEach(async () => {
    await ctx?.fiber.dispose()
    await rm(dir, { recursive: true, force: true })
  })

  let agentCounter = 0

  /**
   * A REGISTERED live agent. A bare `{ session: { header: … } }` object would
   * satisfy `resolveWorkdir`, but `dsh-jobs-local` rejects an owned job whose
   * owner is not the exact instance `ctx.agents` holds — and every job-tool
   * read is fenced on the owner's session id — so the background cases could
   * only ever exercise the unowned path with one. The session header cwd is
   * what the workdir assertions read.
   */
  const agent = () => {
    const id = SessionId(`session-cmd-int-${++agentCounter}`)
    const instance = {
      id,
      status: 'idle',
      ctx: ctx.plugin(() => {}).ctx,
      session: { id, header: { id, cwd: dir }, events: [] },
      followup: () => {},
      inject: () => {},
    }
    ctx.agents.register(instance as never)
    return instance
  }

  it('runs a command and returns stdout with no marker on a clean exit', async () => {
    const result = await call(ctx, 'cmd', { command: 'echo hi', description: 'say hi' }, agent())
    expect(result.isError).toBe(false)
    expect(lf(text(result))).toBe('hi\n')
  })

  it('never leaks the script marker into the model-facing text', async () => {
    // The spec's invariant: `dsh-cmd-script:` is an internal protocol between
    // the tool and the executor and must never reach the model. The unit suites
    // assert the marker is CONSTRUCTED; only a real call proves it is not
    // rendered back.
    const result = await call(ctx, 'cmd', { command: 'echo marker-check', description: 'check the marker stays internal' }, agent())
    expect(result.isError).toBe(false)
    expect(lf(text(result))).toBe('marker-check\n')
    expect(text(result)).not.toContain(CMD_SCRIPT_MARKER)
  })

  it('preserves quotes around a path containing spaces', async () => {
    await writeFile(join(dir, 'a b.txt'), 'spaced\n')
    const result = await call(ctx, 'cmd', { command: 'type "a b.txt"', description: 'read a spaced path' }, agent())
    expect(lf(text(result))).toBe('spaced\n')
  })

  it('expands environment variables', async () => {
    const result = await call(ctx, 'cmd', { command: 'echo [%CD%]', description: 'print the working directory' }, agent())
    // Exact, not `toContain`: a subdirectory path contains `dir` as a prefix, so
    // a containment check would also pass for the wrong directory.
    expect(lf(text(result))).toBe(`[${dir}]\n`)
  })

  it('runs a multi-line if block', async () => {
    const result = await call(ctx, 'cmd', {
      command: 'if exist "greeting.txt" (\r\n  echo FOUND\r\n  echo SECOND\r\n)',
      description: 'branch on a file',
    }, agent())
    expect(lf(text(result))).toBe('FOUND\nSECOND\n')
  })

  it('iterates with a doubled percent loop variable', async () => {
    const result = await call(ctx, 'cmd', { command: 'for %%i in (a b) do @echo item=%%i', description: 'loop' }, agent())
    expect(lf(text(result))).toBe('item=a\nitem=b\n')
  })

  it('reports a non-zero exit code', async () => {
    const result = await call(ctx, 'cmd', { command: 'exit /b 7', description: 'fail deliberately' }, agent())
    expect(result.isError).toBe(false)
    expect(text(result)).toContain('[exit code: 7]')
  })

  it('reports the status of the last command when the script does not exit explicitly', async () => {
    const result = await call(ctx, 'cmd', { command: 'cmd /c exit 9', description: 'propagate a status' }, agent())
    expect(text(result)).toContain('[exit code: 9]')
  })

  it('writes into the session workspace and reads it back', async () => {
    // The trailing space is cmd.exe's OWN `&`-separation behavior, not anything
    // this package adds: cmd splits the line at `&` and keeps the space that
    // preceded it in the first command's text, so `echo` writes `written `
    // (bytes 119…110 32 13 10). `cmd /d /c "echo written> out.txt & type
    // out.txt"` typed straight at a prompt produces the identical line, and
    // `echo written>out.txt& type out.txt` — with no space before the `&` —
    // produces `written` with none. Asserting the exact bytes therefore pins
    // that the command text reached the interpreter verbatim; expecting
    // `written\n` would assert something cmd.exe does not do.
    const result = await call(ctx, 'cmd', { command: 'echo written> out.txt & type out.txt', description: 'round-trip a file' }, agent())
    expect(lf(text(result))).toBe('written \n')
  })

  it('carries non-ASCII text through the script and the collector', async () => {
    const result = await call(ctx, 'cmd', { command: 'echo Xin chào Việt Nam', description: 'echo unicode' }, agent())
    expect(text(result)).toContain('Xin chào Việt Nam')
  })

  it('applies batch-file percent semantics end to end', async () => {
    // The file-based mechanism changes `%` handling: inside a batch file `%%`
    // is the escape for a literal `%`, whereas on a command line `%%` stays
    // `%%`. Nothing in the unit suites pins this, so it is pinned here against
    // the real interpreter.
    const result = await call(ctx, 'cmd', { command: 'echo 100%% done', description: 'echo a literal percent' }, agent())
    expect(lf(text(result))).toBe('100% done\n')
  })

  it('honors an explicit workdir', async () => {
    // A workdir DISTINCT from the session header cwd. `resolveWorkdir` returns
    // the session cwd when the argument is absent and the argument unchanged
    // when it is absolute, so passing `dir` here would pass identically for a
    // tool that ignored `args.workdir` entirely.
    const sub = join(dir, 'sub')
    await mkdir(sub, { recursive: true })
    const result = await call(ctx, 'cmd', { command: 'echo [%CD%]', description: 'print cwd', workdir: sub }, agent())
    expect(lf(text(result))).toBe(`[${sub}]\n`)
  })

  it('runs a background job and collects its output', async () => {
    const owner = agent()
    const started = await call(ctx, 'cmd', { command: 'echo bg-ok', description: 'background echo', run_in_background: true }, owner)
    expect(text(started)).toBe('started background job cmd-1')
    expect(text(started)).not.toContain(CMD_SCRIPT_MARKER)

    // The job's label is the user's raw command, never the marked script path
    // the tool handed the executor.
    const listed = await call(ctx, 'job_list', {}, owner)
    expect(text(listed)).toContain('echo bg-ok')
    expect(text(listed)).not.toContain(CMD_SCRIPT_MARKER)

    const id = (started.value as { jobId: string }).jobId
    let output = ''
    for (let attempt = 0; attempt < 100; attempt++) {
      const read = await call(ctx, 'job_output', { job_id: id, wait: true }, owner)
      output = text(read)
      if (output.includes('bg-ok')) break
    }
    expect(output).toContain('bg-ok')
  })

  it('stops a background job on request', async () => {
    const owner = agent()
    const started = await call(ctx, 'cmd', { command: 'ping -n 60 127.0.0.1 >nul', description: 'long ping', run_in_background: true }, owner)
    const id = (started.value as { jobId: string }).jobId
    const killed = await call(ctx, 'job_kill', { job_id: id }, owner)
    expect(text(killed)).toContain(id)
    const final = await call(ctx, 'job_output', { job_id: id, wait: true }, owner)
    expect(text(final)).toMatch(/status: (killed|completed)/)
  })

  it('serves the pwsh dialect through the same executor', async () => {
    // The dual-dialect contract: the pwsh tool shares ctx.shell with the cmd
    // tool, and its unmarked command must still run PowerShell.
    const result = await call(ctx, 'pwsh', { command: 'Write-Output still-pwsh', description: 'check the twin dialect' }, agent())
    expect(result.isError).toBe(false)
    expect(lf(text(result))).toBe('still-pwsh\n')
  })
})

/**
 * The confined path, at the mode this package actually ships as its default
 * (`DSH_PERMISSION_MODE ?? 'workspace-write'`). The suite above runs
 * `danger-full-access` on purpose, so without this block nothing in the package
 * runs a marked command through the Windows ACL runner — which REBUILDS the
 * child's command line and spawns it under a restricted token, and whose child
 * must then still be able to read the temp script this package wrote outside
 * the workspace. That composition is what these cases pin — with the single
 * substitution {@link supplyAclRunnerEntry} documents.
 */
describe.skipIf(process.platform !== 'win32')('cmd tool under workspace-write confinement', () => {
  /**
   * A directory OUTSIDE the workspace that the HOST process can write to — it is
   * created here, unconfined — so a denial inside it is attributable to
   * confinement rather than to the directory's own ACL. Deliberately not a
   * sibling under `tmpdir()`: the confined child's `TMP`/`TEMP` are rewritten to
   * the runner's granted private directory, and the confinement contract is
   * about ACL grants, not about which temp root a path happens to sit under.
   */
  let outside: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-tool-cmd-confined-'))
    ctx = await composeCmdStack('workspace-write', dir)
    supplyAclRunnerEntry(ctx)
    outside = await mkdtemp(join(homedir(), 'dsh-cmd-confined-'))
  })

  afterEach(async () => {
    await ctx?.fiber.dispose()
    await rm(dir, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  })

  it('runs a command under confinement and returns its output', async () => {
    const result = await call(ctx, 'cmd', { command: 'echo confined-ok', description: 'echo under confinement', workdir: dir })
    expect(result.isError).toBe(false)
    expect(lf(text(result))).toBe('confined-ok\n')
  })

  it('allows a write inside the workspace', async () => {
    const result = await call(ctx, 'cmd', { command: 'echo in> ok.txt & type ok.txt', description: 'write inside the workspace', workdir: dir })
    expect(result.isError).toBe(false)
    expect(lf(text(result))).toContain('in')
    // The containment check alone would also pass for a command that merely
    // echoed something, so the file is read back from the host as well.
    expect(await readFile(join(dir, 'ok.txt'), 'utf8')).toContain('in')
  })

  it('denies a write outside the workspace and renders the denial marker', async () => {
    const target = join(outside, 'probe.txt')
    const result = await call(ctx, 'cmd', { command: `echo denied> "${target}"`, description: 'write outside the workspace', workdir: dir })
    expect(text(result)).toContain('[sandbox: file access denied under workspace-write mode]')
    // The marker could in principle come from some other denied effect, so the
    // file's absence pins that it was this write that was refused.
    expect(existsSync(target)).toBe(false)
  })
})
