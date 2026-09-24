import { describe, expect, it } from 'vitest'
import { candidateCmdPaths, resolveCmdPath } from '../src/resolve.ts'

describe('candidateCmdPaths', () => {
  it('puts ComSpec first, then System32', () => {
    const candidates = candidateCmdPaths({ ComSpec: 'D:\\alt\\cmd.exe', SystemRoot: 'C:\\Win' })
    expect(candidates[0]).toBe('D:\\alt\\cmd.exe')
    expect(candidates[1]).toBe('C:\\Win\\System32\\cmd.exe')
  })

  it('strips quotes a setx-style definition may carry', () => {
    expect(candidateCmdPaths({ ComSpec: '"D:\\alt\\cmd.exe"', SystemRoot: 'C:\\Win' })[0]).toBe('D:\\alt\\cmd.exe')
  })

  it('falls back to the conventional roots when the environment is empty', () => {
    expect(candidateCmdPaths({})).toEqual(['C:\\Windows\\System32\\cmd.exe'])
  })
})

describe('resolveCmdPath', () => {
  it('trusts an explicit configured path', () => {
    expect(resolveCmdPath('E:\\tools\\cmd.exe', {}, 'win32')).toBe('E:\\tools\\cmd.exe')
  })

  it('ignores an empty configured path', () => {
    // Asserted against the undefined case rather than a literal path: the
    // implementation existence-checks every candidate (mirroring
    // dsh-pwsh-local), so which candidate wins is a host fact, while "an empty
    // string is treated as absent" is the behavior under test.
    const env = { ComSpec: 'D:\\alt\\cmd.exe', SystemRoot: 'C:\\Windows' }
    const withEmpty = resolveCmdPath('', env, 'win32')
    expect(withEmpty).toBe(resolveCmdPath(undefined, env, 'win32'))
    expect(withEmpty.length).toBeGreaterThan(0)
  })

  it('returns a bare cmd.exe off Windows', () => {
    expect(resolveCmdPath(undefined, { ComSpec: 'D:\\alt\\cmd.exe' }, 'linux')).toBe('cmd.exe')
  })

  it('falls back to the bare name when no candidate exists on disk', () => {
    expect(resolveCmdPath(undefined, { ComSpec: 'D:\\definitely-absent\\cmd.exe', SystemRoot: 'D:\\absent' }, 'win32'))
      .toBe('cmd.exe')
  })

  it('resolves a real candidate on this host when one is present', () => {
    const resolved = resolveCmdPath()
    expect(typeof resolved).toBe('string')
    expect(resolved.length).toBeGreaterThan(0)
  })
})
