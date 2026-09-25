import { describe, expect, it } from 'vitest'
import type { ShellProcess } from '@deepseek-ai/dsh-shell'
import { renderCmdProcessRead, renderCmdResult } from '../src/render.ts'
import { processOutcome } from '../src/background.ts'

const out = (text: string) => ({ text, truncated: false })
const truncated = (text: string, spillPath: string) => ({ text, truncated: true, spillPath })

describe('renderCmdResult', () => {
  it('reports a clean exit as bare stdout', () => {
    expect(renderCmdResult({ exitCode: 0, signal: null, timedOut: false, timeoutMs: 1000, stdout: out('hi\n'), stderr: out('') }))
      .toBe('hi\n')
  })

  it('says (no output) when both streams are empty', () => {
    expect(renderCmdResult({ exitCode: 0, signal: null, timedOut: false, timeoutMs: 1000, stdout: out(''), stderr: out('') }))
      .toBe('(no output)')
  })

  it('marks a non-zero exit, keeping the marker last', () => {
    const text = renderCmdResult({ exitCode: 3, signal: null, timedOut: false, timeoutMs: 1000, stdout: out('x\n'), stderr: out('') })
    expect(text.endsWith('[exit code: 3]')).toBe(true)
  })

  it('appends a marked stderr section', () => {
    const text = renderCmdResult({ exitCode: 1, signal: null, timedOut: false, timeoutMs: 1000, stdout: out('x\n'), stderr: out('boom\n') })
    expect(text).toContain('[stderr]\nboom\n')
  })

  it('reports a signal kill instead of an exit code', () => {
    const text = renderCmdResult({ exitCode: null, signal: 'SIGTERM', timedOut: false, timeoutMs: 1000, stdout: out(''), stderr: out('') })
    expect(text).toContain('[killed by signal: SIGTERM]')
    expect(text).not.toContain('[exit code:')
  })

  it('reports a timeout', () => {
    const text = renderCmdResult({ exitCode: null, signal: null, timedOut: true, timeoutMs: 250, stdout: out(''), stderr: out('') })
    expect(text).toContain('[timed out after 250ms]')
  })

  it('reports truncation with the spill path', () => {
    const text = renderCmdResult({ exitCode: 0, signal: null, timedOut: false, timeoutMs: 1000, stdout: truncated('tail', 'C:\\spill\\out.txt'), stderr: out('') })
    expect(text).toContain('[output truncated; full output: C:\\spill\\out.txt]')
  })

  it('reports a sandbox denial and, when escalation is advertised, the hint', () => {
    const base = { exitCode: 1, signal: null, timedOut: false, timeoutMs: 1000, stdout: out(''), stderr: out(''), sandbox: { mode: 'read-only' as const, denied: true } }
    expect(renderCmdResult(base)).toContain('denied')
    expect(renderCmdResult(base, ['workspace-write'])).toContain('sandbox_permissions')
  })
})

describe('renderCmdProcessRead', () => {
  it('returns the delta unchanged when there is nothing to report', () => {
    expect(renderCmdProcessRead({ delta: 'tick\n', lossy: false })).toBe('tick\n')
  })

  it('reports a lossy read with its spill paths', () => {
    const text = renderCmdProcessRead({ delta: 'x', lossy: true, stdoutSpillPath: 'C:\\spill\\a' })
    expect(text).toContain('full output: C:\\spill\\a')
  })

  it('reports a sandbox runner failure as a sandbox problem', () => {
    const text = renderCmdProcessRead({ delta: '', lossy: false }, { mode: 'workspace-write', denied: false, runnerFailed: true })
    expect(text).toContain('the sandbox runner itself failed')
  })
})

describe('processOutcome', () => {
  it('maps a completed process to its exit code', () => {
    expect(processOutcome({ status: 'completed', exitCode: 0, signal: null } as ShellProcess))
      .toEqual({ status: 'completed', detail: 'exit code: 0' })
  })

  it('maps a killed process to its signal', () => {
    expect(processOutcome({ status: 'killed', exitCode: null, signal: 'SIGKILL' } as ShellProcess))
      .toEqual({ status: 'killed', detail: 'signal: SIGKILL' })
  })

  it('maps a kill without a signal', () => {
    expect(processOutcome({ status: 'killed', exitCode: null, signal: null } as ShellProcess))
      .toEqual({ status: 'killed', detail: 'killed before exit' })
  })
})
