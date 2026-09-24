/**
 * Sandbox-consuming, dual-dialect shell executor: the Windows Command Prompt
 * twin of `@deepseek-ai/dsh-pwsh-sandbox`, sharing one `ctx.shell` provider
 * with it.
 *
 * `ctx.shell` admits exactly one provider, so this class REPLACES
 * `SandboxPwshExecutor` in a Windows composition rather than joining it. It
 * keeps every inherited mechanic — ACL confinement through `ctx.sandbox`,
 * denial and runner-failure classification, deadlines, spill files, background
 * process handles — and overrides only the documented `argv()` seam, which the
 * parent reaches from `run()`, `start()`, and `confine()` alike.
 *
 * A command carrying {@link CMD_SCRIPT_MARKER} becomes `cmd.exe /d /c <script>`;
 * every other command keeps the inherited PowerShell argv, so the untouched
 * `pwsh` tool behaves exactly as it does today. `/d` skips AutoRun; `/c` is
 * used WITHOUT `/s` because `/s` would strip the outer quotes of a script path
 * containing spaces, while cmd's own default rule strips them correctly.
 *
 * @module dsh-cmd-tool/executor
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ShellExecSpec } from '@deepseek-ai/dsh-shell'
import { SandboxPwshExecutor } from '@deepseek-ai/dsh-pwsh-sandbox'
import type { Config as PwshConfig } from '@deepseek-ai/dsh-pwsh-sandbox'
import z from '@deepseek-ai/schemastery'
import { scriptPathOf } from './protocol.ts'
import { resolveCmdPath } from './resolve.ts'

export const name = 'cmd-sandbox'

/** Configuration: the local pwsh executor's knobs plus the cmd executable. */
export interface Config extends PwshConfig {
  /**
   * Explicit `cmd.exe`. When omitted, `%ComSpec%` and then
   * `<SystemRoot>\System32\cmd.exe` are probed.
   *
   * Composition-entry only: the inherited constructor installs the settings
   * section under `dsh-pwsh-local`'s schema, which does not declare this field,
   * so it is not settable from `settings.yaml`.
   */
  cmdPath?: string
}

/**
 * Registers as `ctx.shell` in place of `SandboxPwshExecutor` and serves both
 * dialects: marked commands run under `cmd.exe`, everything else under pwsh.
 */
export class CmdSandboxExecutor extends SandboxPwshExecutor {
  /**
   * Runtime schema for this plugin: the parent's own schema extended with this
   * executor's one extra knob, COMPOSED rather than copied so the parent's
   * defaults and field set cannot drift out of sync here.
   *
   * It is a static on the class, not a module-level export. The loader unwraps
   * a module to its `default` export before reading `Config`
   * (`vendor/loader/src/index.ts`, `unwrapExports`), so a module-level schema
   * is never consulted. Without this static, `cmdPath` would still reach the
   * constructor — cordis leaves undeclared keys in place — but nothing would
   * declare it, and the knob would rest on that leniency instead of on a
   * contract.
   *
   * If `z.intersect` fights the types, fall back to an explicit `z.object`
   * that repeats the parent's fields, and say in this JSDoc that those
   * defaults are pinned copies of the parent's that must be updated with it.
   */
  static Config = z.intersect([
    SandboxPwshExecutor.Config,
    z.object({ cmdPath: z.string() }),
  ])

  private readonly resolvedCmdPath: string

  constructor(ctx: Context, config: Config) {
    super(ctx, config)
    // Read from the composition entry, not from the settings-derived source:
    // the parent installs its settings section asynchronously (inside
    // ctx.inject), so `config` is still the row's own object here.
    this.resolvedCmdPath = resolveCmdPath(config.cmdPath)
  }

  /** The `cmd.exe` every marked command runs through. */
  get cmdPath(): string {
    return this.resolvedCmdPath
  }

  /** The dialect seam: `cmd.exe` for a marked script command, else the inherited pwsh argv. */
  protected override argv(spec: ShellExecSpec): string[] {
    const scriptPath = scriptPathOf(spec.command)
    // Three guards keep the marker from switching dialects on a command this
    // package's tool never wrote. No marker at all is the ordinary case and
    // keeps the inherited dialect by design. An empty path is the bare marker,
    // which would become `cmd.exe /d /c ""`; a non-.cmd path means the marker
    // appeared inside some other caller's command. All three keep the inherited
    // dialect, so the failure surfaces as that caller's own error rather than
    // as a silently executed file.
    if (scriptPath === undefined || scriptPath.length === 0 || !scriptPath.toLowerCase().endsWith('.cmd')) {
      return super.argv(spec)
    }
    return [this.resolvedCmdPath, '/d', '/c', scriptPath]
  }
}

export default CmdSandboxExecutor
