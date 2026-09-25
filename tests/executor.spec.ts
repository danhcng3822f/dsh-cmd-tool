import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SandboxPwshExecutor } from '@deepseek-ai/dsh-pwsh-sandbox'
import type { ShellExecSpec } from '@deepseek-ai/dsh-shell'
import { CmdSandboxExecutor } from '../src/executor.ts'
import type { Config } from '../src/executor.ts'
import { markScriptCommand } from '../src/protocol.ts'

/**
 * A pinned pwsh path keeps the unmarked-branch assertions deterministic.
 * `resolvePwshPath` returns whichever PowerShell exists on the host —
 * `pwsh.exe` where PowerShell 7 is installed, else Windows PowerShell 5.1's
 * `powershell.exe` — so asserting `argv[0]` any other way encodes a host fact
 * rather than the behavior under test. A configured path is trusted as-is, so
 * pinning it removes that dependency.
 */
const PWSH_PATH = 'C:\\fake\\pwsh.exe'

/**
 * A complete config: the inherited constructor validates the numeric budgets
 * directly (schemastery's defaults are applied by the loader, not by the
 * constructor), so a partial object would throw before reaching argv().
 */
function config(cmdPath: string): Config {
  return {
    timeoutMs: 5_000,
    maxTimeoutMs: 10_000,
    maxOutputBytes: 64_000,
    maxSpillBytes: 1_000_000,
    graceMs: 200,
    pwshPath: PWSH_PATH,
    cmdPath,
  }
}

/**
 * The inherited constructor reads ctx.sandboxPolicy for its default mode. A
 * stub is enough: argv() is the only behavior under test and it touches
 * neither the sandbox nor the subprocess seam.
 */
function makeCtx(): Context {
  const ctx = new Context()
  ctx.provide('sandboxPolicy' as never, {
    defaultMode: 'danger-full-access',
    resolve: () => ({ mode: 'danger-full-access' }),
  } as never)
  return ctx
}

/** A spec stub with only the fields argv() reads. */
function spec(command: string): ShellExecSpec {
  return {
    command,
    workdir: 'C:\\work',
    timeoutMs: 1000,
    stdoutMaxBytes: 1024,
    sandboxPolicy: undefined,
  }
}

/** Reach the protected seam the way the inherited run()/start()/confine() paths do. */
function argvOf(executor: CmdSandboxExecutor, value: ShellExecSpec): string[] {
  return (executor as unknown as { argv(spec: ShellExecSpec): string[] }).argv(value)
}

describe('CmdSandboxExecutor.argv', () => {
  it('keeps the inherited PowerShell argv for an unmarked command', () => {
    const executor = new CmdSandboxExecutor(makeCtx(), config('D:\\alt\\cmd.exe'))
    const argv = argvOf(executor, spec('Write-Output hi'))
    expect(argv).toHaveLength(6)
    expect(argv[0]).toBe(PWSH_PATH)
    expect(argv.slice(1, 5)).toEqual(['-NoLogo', '-NoProfile', '-NonInteractive', '-Command'])
    expect(argv[5]).toContain('Write-Output hi')
  })

  it('switches to cmd.exe /d /c for a marked command, stripping the marker', () => {
    const executor = new CmdSandboxExecutor(makeCtx(), config('D:\\alt\\cmd.exe'))
    const argv = argvOf(executor, spec(markScriptCommand('C:\\Temp\\dsh-cmd\\1\\a.cmd')))
    expect(argv).toEqual(['D:\\alt\\cmd.exe', '/d', '/c', 'C:\\Temp\\dsh-cmd\\1\\a.cmd'])
  })

  it('never leaks the marker into the spawned argv', () => {
    const executor = new CmdSandboxExecutor(makeCtx(), config('cmd.exe'))
    const argv = argvOf(executor, spec(markScriptCommand('C:\\a.cmd')))
    expect(argv.some(part => part.includes('dsh-cmd-script:'))).toBe(false)
  })

  it('keeps the inherited dialect when the marker carries no usable script path', () => {
    const executor = new CmdSandboxExecutor(makeCtx(), config('D:\\alt\\cmd.exe'))
    // The bare marker: `scriptPathOf` returns '' here, and an empty path must
    // not become `cmd.exe /d /c ""`.
    expect(argvOf(executor, spec('dsh-cmd-script:'))[0]).toBe(PWSH_PATH)
    // A path that is not a .cmd file: the marker appeared in a command this
    // package's tool never wrote, so the command keeps its own dialect.
    expect(argvOf(executor, spec('dsh-cmd-script:C:\\a.txt'))[0]).toBe(PWSH_PATH)
  })

  it('exposes the resolved cmd path', () => {
    const executor = new CmdSandboxExecutor(makeCtx(), config('D:\\alt\\cmd.exe'))
    expect(executor.cmdPath).toBe('D:\\alt\\cmd.exe')
  })
})

describe('CmdSandboxExecutor.Config', () => {
  it('declares its own composed schema, so the loader validates cmdPath', () => {
    // The loader reads `plugin.Config` off the class — it unwraps a module to
    // its default export — so this static IS the schema a composition row is
    // validated against.
    expect(CmdSandboxExecutor.Config).not.toBe(SandboxPwshExecutor.Config)
    const validate = CmdSandboxExecutor.Config as unknown as (value: unknown) => Record<string, unknown>
    const resolved = validate({ cmdPath: 'D:\\alt\\cmd.exe' })
    expect(resolved.cmdPath).toBe('D:\\alt\\cmd.exe')
    // The parent's defaults arrive by reference rather than by copy.
    expect(resolved.timeoutMs).toBe(120_000)
    expect(resolved.maxTimeoutMs).toBe(600_000)
  })
})
