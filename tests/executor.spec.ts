import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { ShellExecSpec } from '@deepseek-ai/dsh-shell'
import { CmdSandboxExecutor } from '../src/executor.ts'
import type { Config } from '../src/executor.ts'
import { markScriptCommand } from '../src/protocol.ts'

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
    // argv[0] is the resolved PowerShell executable, which is a real path on a
    // host that has PowerShell installed — never the bare name. Both names are
    // accepted because the parent's own resolution falls back to Windows
    // PowerShell 5.1 on a host without PowerShell 7, as this one is.
    expect(argv[0]).toMatch(/(?:pwsh|powershell)(?:\.exe)?$/iu)
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
    expect(argvOf(executor, spec('dsh-cmd-script:'))[0]).toMatch(/(?:pwsh|powershell)(?:\.exe)?$/iu)
    // A path that is not a .cmd file: the marker appeared in a command this
    // package's tool never wrote, so the command keeps its own dialect.
    expect(argvOf(executor, spec('dsh-cmd-script:C:\\a.txt'))[0]).toMatch(/(?:pwsh|powershell)(?:\.exe)?$/iu)
  })

  it('exposes the resolved cmd path', () => {
    const executor = new CmdSandboxExecutor(makeCtx(), config('D:\\alt\\cmd.exe'))
    expect(executor.cmdPath).toBe('D:\\alt\\cmd.exe')
  })
})
