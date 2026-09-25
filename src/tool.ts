/**
 * Model-facing Windows Command Prompt Consumer of the `ctx.shell` capability
 * seam, for Windows compositions where the cmd-capable executor
 * (`dsh-cmd-tool/executor`) backs `ctx.shell` alongside the PowerShell dialect
 * it keeps for the `pwsh` tool.
 *
 * Behavior mirrors `dsh-tool-pwsh` call-for-call: foreground and
 * `run_in_background` execution (background handles register with the generic
 * `ctx.jobs` runtime under the `cmd` kind), the managed `DSH_*` environment
 * through the shared `shell-env` registry, the per-call sandbox policy
 * resolution, the sandbox-denial rendering with the same-turn escalation
 * surface resolved through `ctx.approval`, and the same marker/truncation
 * rendering story.
 *
 * The one substantive difference is how the command reaches `cmd.exe`. Because
 * `cmd.exe` re-parses its command line with rules incompatible with the CRT
 * quoting Node and the Windows ACL runner apply, the command is written to a
 * temporary batch script and the executor is handed the marker plus that
 * path; see `./script.ts`.
 *
 * @module dsh-cmd-tool/tool
 */

import { rm } from 'node:fs/promises'
import { isAbsolute, join, resolve as resolvePath } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool, TOOL_ABORTED } from '@deepseek-ai/dsh-tools'
import type { GenericCallView, TerminalCallView, ToolExecution, ToolResult, ToolResultView } from '@deepseek-ai/dsh-tools'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-jobs'
import type {} from '@deepseek-ai/dsh-shell-env'
import type {} from '@deepseek-ai/dsh-user-approval'
import type { SandboxExecutionPolicy, SandboxMode } from '@deepseek-ai/dsh-sandbox'
import { ESCALATION_TARGETS, approveEscalation, validateEscalationArgs } from '@deepseek-ai/dsh-sandbox'
import type { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import type { ShellRunResult } from '@deepseek-ai/dsh-shell'
import { parseExitStatus } from '@deepseek-ai/dsh-shell'
import { markScriptCommand } from './protocol.ts'
import { DEFAULT_SCRIPT_DIR, pruneStaleScriptDirs, writeCommandScript } from './script.ts'
import { processOutcome } from './background.ts'
import { renderCmdProcessRead, renderCmdResult } from './render.ts'
import type { RenderableCmdResult } from './render.ts'

declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap {
    cmd: 'cmd'
  }
}

export const name = 'tool-cmd'
export const inject = ['tools', 'shell', 'systemPrompt', 'shellEnv']

/** Configuration for the cmd tool. */
export interface Config {
  /** Expose `run_in_background` (default true); disabled calls are also rejected. */
  enableRunInBackground?: boolean
  /** Emit the script's `chcp` line (default true). */
  setCodePage?: boolean
  /** Code page the script sets (default 65001, UTF-8). */
  codePage?: number
  /** Root directory for per-process temp script directories (default `<os.tmpdir()>/dsh-cmd`). */
  scriptDir?: string
}

/** Runtime configuration schema for the cmd tool plugin. */
export const Config: z<Config> = z.object({
  enableRunInBackground: z.boolean().default(true),
  setCodePage: z.boolean().default(true),
  codePage: z.number().default(65001),
  scriptDir: z.string(),
})

/** Parsed tool args; execute validates value constraints absent from ParameterSchemaSpec. */
interface CmdToolArgs {
  command: string
  description: string
  timeoutMs?: number
  workdir?: string
  run_in_background?: boolean
  sandbox_permissions?: string
  justification?: string
}

/** The canonical foreground result of one cmd call (the `output.schema` value shape). */
interface CmdForegroundResult {
  kind: 'foreground'
  exitCode: number | null
  signal: NodeJS.Signals | null
  timedOut: boolean
  aborted: boolean
  timeoutMs: number
  stdout: { text: string; truncated: boolean; spillPath?: string }
  stderr: { text: string; truncated: boolean; spillPath?: string }
  sandbox?: { mode: string; denied: boolean; enforcement?: string; runnerFailed?: boolean }
}

function validateCmdArgs(args: CmdToolArgs): void {
  if (args.command.trim().length === 0) {
    throw new Error('invalid command: expected a non-empty string')
  }
  if (args.description.trim().length === 0) {
    throw new Error('invalid description: expected a non-empty string')
  }
  if (args.timeoutMs !== undefined && (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0)) {
    throw new Error(`invalid timeoutMs: expected a positive number, got ${JSON.stringify(args.timeoutMs)}`)
  }
  validateEscalationArgs(args.sandbox_permissions, args.justification)
}

function cmdDescription(backgroundEnabled: boolean, escalationModes: readonly SandboxMode[]): string {
  const background = backgroundEnabled
    ? 'Set `run_in_background: true` for long-running commands: the call returns a job id immediately; read its output with `job_output` and stop it with `job_kill`.'
    : 'Background execution is not available; long-running commands must finish within the timeout.'
  const base = 'Execute a Windows Command Prompt command (`cmd.exe`) and return its stdout/stderr. '
    + 'The command runs as a BATCH SCRIPT, so it uses batch syntax: write `for %%i in (...) do ...` with a DOUBLED percent, not the `%i` you would type at a prompt, and a doubled percent is the escape for a literal `%`. '
    + '`%VAR%` expands environment variables; `!VAR!` requires `setlocal enabledelayedexpansion` first. '
    + 'Each call runs a fresh cmd.exe: no state (cwd, variables, functions) persists between calls — pass `workdir` instead of using `cd`. '
    + '`%CD%` is the working directory; `%0` and `%~dp0` name the harness\'s own temporary script file, so do not rely on them. '
    + 'Paths use native Windows form (`C:\\...`). Non-zero exits are reported as `[exit code: N]`. '
    + 'Current harness environment facts are exposed through managed `%DSH_*%` variables; inspect them when needed. '
    + 'For PowerShell syntax use the `pwsh` tool instead. '
    + 'Commands may run under a file sandbox; a blocked file operation is reported as `[sandbox: file access denied under <mode> mode]` — a policy denial, not a bug in the command; do not retry another way. '
    + 'Long output is truncated to its tail; the full output is saved to a file whose path is reported when available. '
    + 'On Windows a force-killed command settles as `[exit code: 1]` without a signal marker — treat it as an interruption, not a command failure. '
    + background
  if (escalationModes.length === 0) return base
  // Only the dialect-independent half of the pwsh tool's sandbox paragraph is
  // carried here. Its language-mode advice (ConstrainedLanguage, cmdlets,
  // Add-Type, `-f` formatting) describes PowerShell, and a `cmd` tool that
  // teaches PowerShell syntax invites the model to write it inside a batch
  // script.
  return base + ' Under the Windows sandbox, programs cannot open named pipes, so a command that captures another '
    + 'program\'s output through piped stdio (Node.js `child_process.spawn`/`exec` with the default '
    + '`stdio: \'pipe\'`) fails with EPERM, while `stdio: \'inherit\'` and `stdio: \'ignore\'` spawns '
    + 'work and cmd\'s own pipelines are unaffected. That EPERM is the documented boundary: '
    + 'do not retry the command another way — escalate the exact command once or restructure it to '
    + 'avoid capturing output. '
    + 'Attempting a command the sandbox may deny is safe and expected: run it and read the '
    + 'marker rather than assuming the denial. When a command is denied and a wider mode would let it '
    + 'succeed, escalate immediately in the same turn — the one sanctioned exception to a denial: retry '
    + 'the exact same command once with `sandbox_permissions` (the narrowest wider mode that suffices) '
    + 'plus a one-sentence `justification`. Do not detour through chat to ask permission first — the '
    + 'approval prompt raised by that retry is how the user consents. If the session states approval '
    + 'prompts are disabled, there is no exception: a denial is final — do not set `sandbox_permissions`. '
    + 'Never escalate speculatively: ground the request in a real denial — normally the one this command '
    + 'just hit; escalating up front is fine only when this session already denied the same access. '
    + 'A rejected escalation is final for that command — stop and explain, never work around '
    + 'it — but it does not forbid attempting or escalating other commands later.'
}

/**
 * Resolve an explicit workdir first, making a relative one session-workspace-relative;
 * otherwise use the session header cwd and leave executor defaulting as the fallback.
 */
function resolveWorkdir(modelWorkdir: string | undefined, exec: { agent?: Agent }): string | undefined {
  const headerCwd = exec.agent?.session.header.cwd
  if (modelWorkdir === undefined) return headerCwd
  if (headerCwd !== undefined && !isAbsolute(modelWorkdir)) {
    return resolvePath(headerCwd, modelWorkdir)
  }
  return modelWorkdir
}

/** Detach the executor DTO from readonly Service Definition types into plain JSON data. */
function canonicalCmdResult(result: ShellRunResult): CmdForegroundResult {
  const output = (stream: ShellRunResult['stdout']) => ({
    text: stream.text,
    truncated: stream.truncated,
    ...stream.spillPath !== undefined ? { spillPath: stream.spillPath } : {},
  })
  return {
    kind: 'foreground',
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    aborted: result.aborted,
    timeoutMs: result.timeoutMs,
    stdout: output(result.stdout),
    stderr: output(result.stderr),
    ...result.sandbox !== undefined ? {
      sandbox: {
        mode: result.sandbox.mode,
        denied: result.sandbox.denied,
        ...result.sandbox.enforcement !== undefined ? { enforcement: result.sandbox.enforcement } : {},
        ...result.sandbox.runnerFailed !== undefined ? { runnerFailed: result.sandbox.runnerFailed } : {},
      },
    } : {},
  }
}

/** Canonical background-handle properties shared by the cmd output union. */
const BACKGROUND_OUTPUT_PROPERTIES = {
  kind: { type: 'string', required: true, const: 'background' },
  jobId: { type: 'string', required: true },
} as const

export function apply(ctx: Context, config: Config = {}): void {
  if (process.platform !== 'win32') {
    throw new Error('tool-cmd: the cmd tool requires Windows (cmd.exe is not available on this platform)')
  }
  const backgroundEnabled = config.enableRunInBackground ?? true
  const scriptOptions = {
    ...config.scriptDir !== undefined ? { scriptDir: config.scriptDir } : {},
    setCodePage: config.setCodePage ?? true,
    codePage: config.codePage ?? 65001,
  }
  const defaultMode = ctx.shell.sandboxMode
  const escalationModes: readonly SandboxMode[] = defaultMode === undefined ? [] : ESCALATION_TARGETS
  const sandboxPolicy: SandboxPolicyService | undefined = defaultMode === undefined ? undefined : ctx.get('sandboxPolicy')
  if (defaultMode !== undefined && sandboxPolicy === undefined) {
    throw new Error('tool-cmd: the mounted executor confines but ctx.sandboxPolicy is missing')
  }

  // Stale script directories from a crashed process would otherwise accumulate
  // in the temp root forever. Age is the criterion because a dead pid cannot be
  // told apart from a reused one.
  const scriptRoot = config.scriptDir ?? DEFAULT_SCRIPT_DIR
  // `pruneStaleScriptDirs` is expected to swallow its own errors, but this call
  // must not depend on that from a distance: an unhandled rejection is fatal in
  // dsh, so the safety is attached here rather than assumed there.
  void pruneStaleScriptDirs(scriptRoot, 24 * 60 * 60 * 1000).catch(() => {})
  // Best-effort: `force` suppresses only a missing path, and a background job
  // still holding its script open at teardown would otherwise reject. An
  // unhandled rejection is fatal in dsh — the host installs a fail-loud handler
  // that exits the process — so a locked temp file must not turn a clean
  // shutdown into a crash.
  ctx.effect(() => () => {
    rm(join(scriptRoot, String(process.pid)), { recursive: true, force: true }).catch(() => {})
  })

  /** Resolve the complete standing policy for this call when a confining executor is mounted. */
  const resolveSandboxPolicy = (exec: ToolExecution): SandboxExecutionPolicy | undefined =>
    sandboxPolicy?.resolve(exec.agent === undefined ? {} : { session: exec.agent.session })

  /**
   * Resolve a sandbox-escalation request through `ctx.approval` BEFORE
   * anything executes, delegating the shared fail-closed sequence (strict
   * widening, channel resolution, outcome mapping) to
   * {@link approveEscalation}. This tool contributes only the composition
   * guard (the fields are unadvertised without a sandboxing executor, yet
   * schema validation checks advertised keys only, so an unadvertised
   * `sandbox_permissions` still reaches execute) and the approval
   * ingredients. The shared policy resolver is required whenever the
   * executor advertises confinement, so a split composition fails at
   * tool-plugin load.
   */
  const approveCmdEscalation = (
    mode: string,
    justification: string,
    exec: ToolExecution,
    standingPolicy: SandboxExecutionPolicy | undefined,
  ): Promise<SandboxMode> => {
    if (escalationModes.length === 0) {
      throw new Error('sandbox_permissions is not available in this composition (no sandboxing executor to escalate)')
    }
    const effectiveMode = (standingPolicy as SandboxExecutionPolicy).mode
    return approveEscalation(
      { requestedMode: mode, justification, effectiveMode, subject: 'command' },
      {
        approver: ctx.get('approval'),
        agent: exec.agent,
        callId: exec.callId,
        toolName: 'cmd',
        signal: exec.signal,
      },
    )
  }

  ctx.systemPrompt.section({
    name: 'tool:cmd',
    order: 106,
    text: 'Non-zero exits are reported as `[exit code: N]` markers; investigate failures before moving on. '
      + 'The `cmd` tool runs batch scripts, so loop variables use `%%i`. '
      + 'On Windows a killed process settles as `[exit code: 1]` without a signal marker; treat a bare exit 1 after an interruption as a termination, not a command failure.',
  })

  ctx.tools.register(defineTool({
    name: 'cmd',
    description: cmdDescription(backgroundEnabled, escalationModes),
    parameters: {
      command: { type: 'string', required: true, description: 'The Windows Command Prompt command to execute (batch syntax; use `%%i` in `for` loops).' },
      description: {
        type: 'string',
        required: true,
        description: 'Clear, concise description of what this command does in active voice, '
          + '5-10 words (shown in the UI). Examples: "dir" → "List files in current directory"; '
          + '"git status" → "Show working tree status"; "tasklist" → "List running processes".',
      },
      timeoutMs: { type: 'number', description: 'Timeout in milliseconds. The executor applies its configured default and cap, and kills the command on expiry.' },
      workdir: { type: 'string', description: 'Working directory for this command. Defaults to the session workspace; a relative path is resolved against it.' },
      ...backgroundEnabled ? {
        run_in_background: { type: 'boolean' as const, description: 'Run in the background and return a job id immediately (collect with job_output, stop with job_kill). No timeout applies.' },
      } : {},
      ...escalationModes.length > 0 ? {
        sandbox_permissions: {
          type: 'string' as const,
          enum: [...escalationModes],
          description: 'The wider sandbox mode this command needs. Only valid as a one-shot retry of a command the sandbox just denied; requires justification and user approval.',
        },
        justification: {
          type: 'string' as const,
          description: 'Required with sandbox_permissions: one sentence for the user explaining why this exact command needs the wider access.',
        },
      } : {},
    },
    output: {
      // The foreground result wire shape mirrors dsh-tool-bash's by contract —
      // consumers of one must accept the other (see the pwsh-tool-and-executor
      // Agent Note).
      schema: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            properties: BACKGROUND_OUTPUT_PROPERTIES,
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', required: true, const: 'foreground' },
              exitCode: { required: true, oneOf: [{ type: 'integer' }, { type: 'null' }] },
              signal: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
              timedOut: { type: 'boolean', required: true },
              aborted: { type: 'boolean', required: true },
              timeoutMs: { type: 'number', required: true },
              stdout: {
                type: 'object',
                additionalProperties: false,
                required: true,
                properties: {
                  text: { type: 'string', required: true },
                  truncated: { type: 'boolean', required: true },
                  spillPath: { type: 'string' },
                },
              },
              stderr: {
                type: 'object',
                additionalProperties: false,
                required: true,
                properties: {
                  text: { type: 'string', required: true },
                  truncated: { type: 'boolean', required: true },
                  spillPath: { type: 'string' },
                },
              },
              sandbox: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  mode: { type: 'string', required: true },
                  denied: { type: 'boolean', required: true },
                  enforcement: { type: 'string' },
                  runnerFailed: { type: 'boolean' },
                },
              },
            },
          },
        ],
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.kind === 'background'
          ? `started background job ${value.jobId}`
          : renderCmdResult(value as RenderableCmdResult, escalationModes),
      }],
    },
    async execute(args: CmdToolArgs, exec) {
      validateCmdArgs(args)
      // Description is display metadata; workdir defaults to the caller's session.
      const standingPolicy = resolveSandboxPolicy(exec)
      const approvedMode = args.sandbox_permissions !== undefined && args.justification !== undefined
        ? await approveCmdEscalation(args.sandbox_permissions, args.justification, exec, standingPolicy)
        : undefined
      const policy = approvedMode === undefined
        ? standingPolicy
        : { ...(standingPolicy as SandboxExecutionPolicy), mode: approvedMode }
      const workdir = resolveWorkdir(args.workdir, exec)
      // The command text goes to disk, never onto a command line: see ./script.ts.
      const script = await writeCommandScript(args.command, scriptOptions)
      let handedOff = false
      try {
        const request = {
          command: markScriptCommand(script.path),
          ...workdir !== undefined ? { workdir } : {},
          ...args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {},
          dshEnv: ctx.shellEnv.collect(exec),
          ...policy !== undefined ? { sandboxPolicy: policy } : {},
        }
        if (args.run_in_background === true) {
          // Undeclared keys are allowed, so schema omission also needs enforcement.
          if (!backgroundEnabled) {
            throw new Error('run_in_background is disabled for this deployment (enableRunInBackground: false)')
          }
          const jobs = ctx.get('jobs')
          if (jobs === undefined) {
            throw new Error('background jobs unavailable: load @deepseek-ai/dsh-jobs and @deepseek-ai/dsh-tool-jobs')
          }
          // The caller owns cancellation until ctx.jobs commits detached ownership.
          if (exec.signal.aborted) {
            const error = new HarnessError('tool call aborted', TOOL_ABORTED)
            error.name = 'AbortError'
            throw error
          }
          // Task preflight finishes before the starter can spawn a process.
          const id = jobs.start({
            kind: 'cmd',
            label: args.command,
            ...exec.agent ? { owner: exec.agent } : {},
            run: () => {
              const proc = ctx.shell.start(ctx.shell.resolve(request))
              return {
                cancel: () => void proc.kill(),
                // The script must outlive the process, so it is disposed with
                // the job rather than with this call.
                done: proc.done.then(async () => {
                  // Best-effort for the same reason as the foreground path, and
                  // more sharply: a rejection here makes the job runtime settle
                  // this job as `failed`, discarding a command that ran to
                  // completion along with its exit code and output.
                  await script.dispose().catch(() => {})
                  return processOutcome(proc)
                }),
                readOutput: () => renderCmdProcessRead(proc.readOutput(), proc.sandbox, escalationModes),
              }
            },
          })
          handedOff = true
          return { kind: 'background' as const, jobId: id }
        }
        const result = await ctx.shell.run(ctx.shell.resolve({
          ...request,
          signal: exec.signal,
        }))
        if (result.aborted) {
          const error = new HarnessError('tool call aborted', TOOL_ABORTED)
          error.name = 'AbortError'
          throw error
        }
        return canonicalCmdResult(result)
      } finally {
        // A background job owns the script from here; every other path — success,
        // non-zero exit, timeout, abort, or a throw — removes it now. Removal is
        // best-effort: a just-exited cmd.exe or a scanner can still hold the file
        // (EPERM/EBUSY), and a throw from this finally would replace the call's
        // real result, reporting a command that ran and produced output as a
        // tool error. Anything left behind is covered by the pid-directory
        // teardown and pruneStaleScriptDirs.
        if (!handedOff) await script.dispose().catch(() => {})
      }
    },
    presentCall: (args: CmdToolArgs): TerminalCallView | GenericCallView => {
      // Background acknowledgements carry no terminal exit status; the generic
      // card mirrors the bash tool's background presentation.
      if (args.run_in_background === true) {
        return {
          card: 'generic',
          title: args.command,
          kind: 'execute',
          rawInput: args.command,
          content: [{ type: 'text', text: args.description }],
        }
      }
      return {
        card: 'terminal',
        title: args.command,
        description: args.description,
        ...args.workdir !== undefined ? { cwd: args.workdir } : {},
      }
    },
    presentResult: (args: unknown, result: ToolResult): ToolResultView | undefined => {
      const block = result.content.length === 1 ? result.content[0] : undefined
      if (block === undefined || block.type !== 'text') return undefined
      const raw = block.text
      const isBackground = typeof args === 'object' && args !== null && (args as { run_in_background?: unknown }).run_in_background === true
      // Background acknowledgements and errors have no terminal exit status.
      if (isBackground || result.isError) {
        return { card: 'generic', content: [{ type: 'text', text: `\`\`\`console\n${raw.replace(/\n+$/, '')}\n\`\`\`` }] }
      }
      // The exit marker becomes the card's exit pill, so it leaves the output body.
      const { body, ...exit } = parseExitStatus(raw)
      return { card: 'terminal', output: body, ...exit }
    },
  }))
}
