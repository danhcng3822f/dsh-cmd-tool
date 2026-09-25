/**
 * Integration tests: the REAL `CmdSandboxExecutor` plus the `cmd` tool,
 * exercised through `ctx.tools.execute()` against a real cmd.exe. These verify
 * the world — that quotes survive, `%VAR%` expands, batch blocks parse, exit
 * codes render, and background jobs settle through the generic job runtime.
 * The suite self-skips off Windows.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
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

function call(name: string, args: unknown, agentObj?: object) {
  return ctx.tools.execute({
    signal: testToolSignal,
    callId: CallId(`it-${++counter}`),
    name,
    arguments: args,
    ...agentObj ? { agent: agentObj as never } : {},
  })
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(b => b.type === 'text').map(b => b.text).join('')
}

describe.skipIf(process.platform !== 'win32')('cmd tool over the real cmd.exe', () => {
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-tool-cmd-'))
    await writeFile(join(dir, 'greeting.txt'), 'hello cmd\n')

    ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    // `dsh-jobs-local` refuses an OWNED job whose owner is not the exact live
    // instance `ctx.agents` holds, and the cmd tool always passes the calling
    // agent as the owner, so the registry is part of this composition rather
    // than an optional extra.
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(LocalJobRegistry)
    await ctx.plugin(ToolJobs)
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(LocalSandbox)
    // Full access keeps the suite fast: the confinement path is the core
    // executor's own, covered by the pwsh suites, and is not what this suite
    // exists to verify.
    await ctx.plugin(SandboxPolicy, { mode: 'danger-full-access', workspaceRoot: dir })
    await ctx.plugin(ShellEnv)
    await ctx.plugin(CmdSandboxExecutor, { timeoutMs: 20_000, graceMs: 200 })
    await ctx.plugin(ToolCmd)
    // Mounted alongside so the dual-dialect contract is exercised, not assumed.
    await ctx.plugin(ToolPwsh)
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
    const result = await call('cmd', { command: 'echo hi', description: 'say hi' }, agent())
    expect(result.isError).toBe(false)
    expect(lf(text(result))).toBe('hi\n')
  })

  it('never leaks the script marker into the model-facing text', async () => {
    // The spec's invariant: `dsh-cmd-script:` is an internal protocol between
    // the tool and the executor and must never reach the model. The unit suites
    // assert the marker is CONSTRUCTED; only a real call proves it is not
    // rendered back.
    const result = await call('cmd', { command: 'echo marker-check', description: 'check the marker stays internal' }, agent())
    expect(result.isError).toBe(false)
    expect(lf(text(result))).toBe('marker-check\n')
    expect(text(result)).not.toContain(CMD_SCRIPT_MARKER)
  })

  it('preserves quotes around a path containing spaces', async () => {
    await writeFile(join(dir, 'a b.txt'), 'spaced\n')
    const result = await call('cmd', { command: 'type "a b.txt"', description: 'read a spaced path' }, agent())
    expect(lf(text(result))).toBe('spaced\n')
  })

  it('expands environment variables', async () => {
    const result = await call('cmd', { command: 'echo [%CD%]', description: 'print the working directory' }, agent())
    expect(text(result)).toContain(dir)
  })

  it('runs a multi-line if block', async () => {
    const result = await call('cmd', {
      command: 'if exist "greeting.txt" (\r\n  echo FOUND\r\n  echo SECOND\r\n)',
      description: 'branch on a file',
    }, agent())
    expect(lf(text(result))).toBe('FOUND\nSECOND\n')
  })

  it('iterates with a doubled percent loop variable', async () => {
    const result = await call('cmd', { command: 'for %%i in (a b) do @echo item=%%i', description: 'loop' }, agent())
    expect(lf(text(result))).toBe('item=a\nitem=b\n')
  })

  it('reports a non-zero exit code', async () => {
    const result = await call('cmd', { command: 'exit /b 7', description: 'fail deliberately' }, agent())
    expect(result.isError).toBe(false)
    expect(text(result)).toContain('[exit code: 7]')
  })

  it('reports the status of the last command when the script does not exit explicitly', async () => {
    const result = await call('cmd', { command: 'cmd /c exit 9', description: 'propagate a status' }, agent())
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
    const result = await call('cmd', { command: 'echo written> out.txt & type out.txt', description: 'round-trip a file' }, agent())
    expect(lf(text(result))).toBe('written \n')
  })

  it('carries non-ASCII text through the script and the collector', async () => {
    const result = await call('cmd', { command: 'echo Xin chào Việt Nam', description: 'echo unicode' }, agent())
    expect(text(result)).toContain('Xin chào Việt Nam')
  })

  it('applies batch-file percent semantics end to end', async () => {
    // The file-based mechanism changes `%` handling: inside a batch file `%%`
    // is the escape for a literal `%`, whereas on a command line `%%` stays
    // `%%`. Nothing in the unit suites pins this, so it is pinned here against
    // the real interpreter.
    const result = await call('cmd', { command: 'echo 100%% done', description: 'echo a literal percent' }, agent())
    expect(lf(text(result))).toBe('100% done\n')
  })

  it('honors an explicit workdir', async () => {
    const result = await call('cmd', { command: 'echo [%CD%]', description: 'print cwd', workdir: dir }, agent())
    expect(text(result)).toContain(dir)
  })

  it('runs a background job and collects its output', async () => {
    const owner = agent()
    const started = await call('cmd', { command: 'echo bg-ok', description: 'background echo', run_in_background: true }, owner)
    expect(text(started)).toBe('started background job cmd-1')
    expect(text(started)).not.toContain(CMD_SCRIPT_MARKER)

    // The job's label is the user's raw command, never the marked script path
    // the tool handed the executor.
    const listed = await call('job_list', {}, owner)
    expect(text(listed)).toContain('echo bg-ok')
    expect(text(listed)).not.toContain(CMD_SCRIPT_MARKER)

    const id = (started.value as { jobId: string }).jobId
    let output = ''
    for (let attempt = 0; attempt < 100; attempt++) {
      const read = await call('job_output', { job_id: id, wait: true }, owner)
      output = text(read)
      if (output.includes('bg-ok')) break
    }
    expect(output).toContain('bg-ok')
  })

  it('stops a background job on request', async () => {
    const owner = agent()
    const started = await call('cmd', { command: 'ping -n 60 127.0.0.1 >nul', description: 'long ping', run_in_background: true }, owner)
    const id = (started.value as { jobId: string }).jobId
    const killed = await call('job_kill', { job_id: id }, owner)
    expect(text(killed)).toContain(id)
    const final = await call('job_output', { job_id: id, wait: true }, owner)
    expect(text(final)).toMatch(/status: (killed|completed)/)
  })

  it('serves the pwsh dialect through the same executor', async () => {
    // The dual-dialect contract: the pwsh tool shares ctx.shell with the cmd
    // tool, and its unmarked command must still run PowerShell.
    const result = await call('pwsh', { command: 'Write-Output still-pwsh', description: 'check the twin dialect' }, agent())
    expect(result.isError).toBe(false)
    expect(lf(text(result))).toBe('still-pwsh\n')
  })
})
