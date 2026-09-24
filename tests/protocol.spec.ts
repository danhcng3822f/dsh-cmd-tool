import { describe, expect, it } from 'vitest'
import { CMD_SCRIPT_MARKER, markScriptCommand, scriptPathOf } from '../src/protocol.ts'

describe('cmd script marker protocol', () => {
  it('marks a script path so the executor can recognize it', () => {
    expect(markScriptCommand('C:\\Temp\\dsh-cmd\\1\\a.cmd')).toBe('dsh-cmd-script:C:\\Temp\\dsh-cmd\\1\\a.cmd')
  })

  it('recovers the exact path it was given', () => {
    const path = 'C:\\Users\\a b\\Temp\\dsh-cmd\\12\\3f.cmd'
    expect(scriptPathOf(markScriptCommand(path))).toBe(path)
  })

  it('reports undefined for an ordinary command', () => {
    expect(scriptPathOf('dir "C:\\Program Files"')).toBeUndefined()
    expect(scriptPathOf('')).toBeUndefined()
  })

  it('uses a marker that cannot appear at the start of a real cmd command', () => {
    expect(CMD_SCRIPT_MARKER.startsWith('dsh-cmd-script:')).toBe(true)
  })
})
