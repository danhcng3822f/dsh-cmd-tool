import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import * as ToolJobs from '@deepseek-ai/dsh-tool-jobs'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ShellExecutor } from '@deepseek-ai/dsh-shell'
import type { ShellExecRequest, ShellExecSpec, ShellProcess, ShellRunResult } from '@deepseek-ai/dsh-shell'
import * as ShellEnv from '@deepseek-ai/dsh-shell-env'
import * as ToolCmd from '../src/tool.ts'
import { scriptPathOf } from '../src/protocol.ts'

const signal = new AbortController().signal
let counter = 0

/** A recording executor that satisfies the seam without spawning anything. */
class FakeShell extends ShellExecutor {
  static inject: string[] = []
  readonly specs: ShellExecSpec[] = []
  readonly requests: ShellExecRequest[] = []
  result: ShellRunResult = {
    exitCode: 0,
    signal: null,
    timedOut: false,
    aborted: false,
    timeoutMs: 1000,
    stdout: { text: 'hi\n', truncated: false },
    stderr: { text: '', truncated: false },
  }

  resolve(request: ShellExecRequest): ShellExecSpec {
    this.requests.push(request)
    return { command: request.command, workdir: request.workdir ?? 'C:\\work', timeoutMs: request.timeoutMs ?? 1000, stdoutMaxBytes: 1024, sandboxPolicy: request.sandboxPolicy }
  }

  async run(spec: ShellExecSpec): Promise<ShellRunResult> {
    this.specs.push(spec)
    return this.result
  }

  start(spec: ShellExecSpec): ShellProcess {
    this.specs.push(spec)
    return {
      status: 'completed',
      exitCode: 0,
      signal: null,
      done: Promise.resolve(),
      readOutput: () => ({ delta: '', lossy: false }),
      kill: () => false,
    }
  }
}

let ctx: Context
let shell: FakeShell
let scratchDir: string

async function boot(config: ToolCmd.Config = {}): Promise<void> {
  scratchDir = await mkdtemp(join(tmpdir(), 'dsh-cmd-tool-'))
  ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  // The job runtime refuses to start an OWNED job unless the owner is the live
  // instance `ctx.agents` holds, and the tool always passes the calling agent
  // as the owner, so the registry has to be mounted here.
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LocalJobRegistry)
  await ctx.plugin(ToolJobs)
  await ctx.plugin(ShellEnv)

  // ShellExecutor's constructor registers itself as ctx.shell, so the fake is
  // constructed directly rather than mounted as a plugin.
  shell = new FakeShell(ctx)
  // A scratch script directory per test keeps the temp root clean and makes the
  // dispose assertions independent of anything else on the machine.
  await ctx.plugin(ToolCmd, { scriptDir: scratchDir, ...config })
}

function call(name: string, args: unknown, agentObj?: object) {
  return ctx.tools.execute({
    signal,
    callId: CallId(`it-${++counter}`),
    name,
    arguments: args,
    ...agentObj ? { agent: agentObj as never } : {},
  })
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(b => b.type === 'text').map(b => b.text).join('')
}

/**
 * A REGISTERED fake agent. `dsh-jobs-local` rejects an owned job whose owner is
 * not the exact live instance `ctx.agents` holds, so a bare `{ session }` object
 * could only ever exercise the unowned path. The session header cwd is what the
 * workdir assertions read.
 */
let agentCounter = 0
const agent = () => {
  const id = SessionId(`session-cmd-${++agentCounter}`)
  const instance = {
    id,
    status: 'idle',
    ctx: ctx.plugin(() => {}).ctx,
    session: { id, header: { id, cwd: 'C:\\work' }, events: [] },
    followup: () => {},
    inject: () => {},
  }
  ctx.agents.register(instance as never)
  return instance
}

afterEach(async () => {
  await ctx?.fiber.dispose()
})

describe('cmd tool surface', () => {
  it('registers the cmd tool with a prompt section', async () => {
    await boot()
    const schema = ctx.tools.schemas().find(item => item.name === 'cmd')
    expect(schema).toBeDefined()
    expect(schema?.description).toContain('cmd.exe')
  })

  it('advertises the batch-semantics contract in the description', async () => {
    await boot()
    const description = ctx.tools.schemas().find(item => item.name === 'cmd')?.description ?? ''
    expect(description).toContain('%%i')
    expect(description).toContain('run_in_background')
  })

  it('rejects an empty command', async () => {
    await boot()
    expect(text(await call('cmd', { command: '   ', description: 'd' }))).toContain('expected a non-empty string')
  })

  it('rejects an empty description', async () => {
    await boot()
    expect(text(await call('cmd', { command: 'dir', description: ' ' }))).toContain('expected a non-empty string')
  })

  it('rejects a non-positive timeoutMs', async () => {
    await boot()
    expect(text(await call('cmd', { command: 'dir', description: 'd', timeoutMs: -1 }))).toContain('expected a positive number')
  })
})

describe('cmd tool execution', () => {
  it('sends the executor a marked script path, never the raw command', async () => {
    await boot()
    await call('cmd', { command: 'echo "hi there"', description: 'say hi' }, agent())
    // resolve() records the request; run() records the spec. Both carry the
    // command, but only resolve() runs on every path, including a throwing run.
    const scriptPath = scriptPathOf(shell.requests[0]!.command)
    expect(scriptPath).toBeDefined()
    expect(scriptPath!.endsWith('.cmd')).toBe(true)
  })

  it('removes the script file after a successful call', async () => {
    await boot()
    await call('cmd', { command: 'echo hi', description: 'say hi' }, agent())
    const scriptPath = scriptPathOf(shell.requests[0]!.command)!
    expect(existsSync(scriptPath)).toBe(false)
  })

  it('removes the script file when the run throws', async () => {
    await boot()
    shell.run = vi.fn(async () => { throw new Error('spawn failed') })
    await call('cmd', { command: 'echo hi', description: 'say hi' }, agent())
    const scriptPath = scriptPathOf(shell.requests[0]!.command)!
    expect(existsSync(scriptPath)).toBe(false)
  })

  it('removes the script file when the command is rejected before running', async () => {
    await boot()
    const result = await call('cmd', { command: 'echo hi', description: 'd', timeoutMs: -1 }, agent())
    expect(text(result)).toContain('expected a positive number')
    // Nothing was written, so nothing can leak: resolve() never ran.
    expect(shell.requests).toHaveLength(0)
  })

  it('defaults workdir to the session cwd', async () => {
    await boot()
    await call('cmd', { command: 'dir', description: 'list' }, agent())
    expect(shell.requests[0]!.workdir).toBe('C:\\work')
  })

  it('resolves a relative workdir against the session cwd', async () => {
    await boot()
    await call('cmd', { command: 'dir', description: 'list', workdir: 'sub' }, agent())
    expect(shell.requests[0]!.workdir).toBe('C:\\work\\sub')
  })

  it('renders the exit marker for a failing command', async () => {
    await boot()
    shell.result = { ...shell.result, exitCode: 7 }
    const result = await call('cmd', { command: 'cmd /c exit 7', description: 'fail' }, agent())
    expect(text(result)).toContain('[exit code: 7]')
  })

  it('starts a background job when asked', async () => {
    await boot()
    const result = await call('cmd', { command: 'ping -t 127.0.0.1', description: 'ping', run_in_background: true }, agent())
    expect(text(result)).toBe('started background job cmd-1')
  })

  it('rejects run_in_background when disabled', async () => {
    await boot({ enableRunInBackground: false })
    const result = await call('cmd', { command: 'ping -t 127.0.0.1', description: 'ping', run_in_background: true }, agent())
    expect(text(result)).toContain('run_in_background is disabled')
  })
})

describe('cmd tool presentation', () => {
  it('presents a terminal card for a foreground call', async () => {
    await boot()
    const view = ctx.tools.get('cmd')?.presentCall?.({ command: 'dir', description: 'list files' })
    expect(view).toMatchObject({ card: 'terminal', title: 'dir', description: 'list files' })
  })

  it('presents a generic card for a background call', async () => {
    await boot()
    const view = ctx.tools.get('cmd')?.presentCall?.({ command: 'ping', description: 'ping', run_in_background: true })
    expect(view).toMatchObject({ card: 'generic' })
  })

  it('turns the exit marker into the terminal card pill', async () => {
    await boot()
    const view = ctx.tools.get('cmd')?.presentResult?.(
      { command: 'dir', description: 'list' },
      { content: [{ type: 'text', text: 'body\n[exit code: 3]' }], isError: false },
    )
    // `parseExitStatus` consumes the newline that separated the body from the
    // marker, so the pill's output is the body WITHOUT its trailing newline —
    // the same value dsh-tool-pwsh's own suite asserts for this exact input.
    expect(view).toMatchObject({ card: 'terminal', output: 'body' })
  })
})
