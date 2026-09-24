import { afterEach, describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pruneStaleScriptDirs, scriptBody, toCrlf, writeCommandScript } from '../src/script.ts'

const dirs: string[] = []
async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-cmd-script-'))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

describe('toCrlf', () => {
  it('normalizes LF and lone CR to CRLF', () => {
    expect(toCrlf('a\nb\rc\r\nd')).toBe('a\r\nb\r\nc\r\nd')
  })

  it('leaves an already-CRLF string unchanged', () => {
    expect(toCrlf('a\r\nb')).toBe('a\r\nb')
  })
})

describe('scriptBody', () => {
  it('starts with a bare @echo off so the interpreter does not echo commands', () => {
    expect(scriptBody('dir').startsWith('@echo off\r\n')).toBe(true)
  })

  it('sets the code page on its own line, output suppressed', () => {
    expect(scriptBody('dir')).toBe('@echo off\r\nchcp 65001>nul\r\ndir\r\n')
  })

  it('omits the code page line when disabled', () => {
    expect(scriptBody('dir', { setCodePage: false })).toBe('@echo off\r\ndir\r\n')
  })

  it('honors an explicit code page', () => {
    expect(scriptBody('dir', { codePage: 437 })).toContain('chcp 437>nul\r\n')
  })

  it('normalizes a multi-line command to CRLF and trims trailing blank lines', () => {
    expect(scriptBody('echo one\necho two\n\n')).toBe('@echo off\r\nchcp 65001>nul\r\necho one\r\necho two\r\n')
  })

  it('carries quotes, percents, operators and non-ASCII through unchanged', () => {
    const command = 'echo "Xin chào" & echo 100%% done | findstr /i "done"'
    expect(scriptBody(command)).toContain(command)
  })
})

describe('writeCommandScript', () => {
  it('writes UTF-8 without a BOM and CRLF line endings', async () => {
    const root = await scratch()
    const script = await writeCommandScript('echo hi', { scriptDir: root })
    const bytes = await readFile(script.path)
    expect(bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))).toBe(false)
    expect(bytes.toString('utf8')).toBe('@echo off\r\nchcp 65001>nul\r\necho hi\r\n')
    await script.dispose()
  })

  it('places the file under a per-process directory and gives every call a unique name', async () => {
    const root = await scratch()
    const a = await writeCommandScript('echo a', { scriptDir: root })
    const b = await writeCommandScript('echo b', { scriptDir: root })
    expect(a.path).not.toBe(b.path)
    expect(a.path).toContain(String(process.pid))
    expect(a.path.endsWith('.cmd')).toBe(true)
    await Promise.all([a.dispose(), b.dispose()])
  })

  it('removes the file on dispose and tolerates a second dispose', async () => {
    const root = await scratch()
    const script = await writeCommandScript('echo hi', { scriptDir: root })
    expect(existsSync(script.path)).toBe(true)
    await script.dispose()
    expect(existsSync(script.path)).toBe(false)
    await expect(script.dispose()).resolves.toBeUndefined()
  })
})

describe('pruneStaleScriptDirs', () => {
  it('removes only directories older than the age bound', async () => {
    const root = await scratch()
    const oldDir = join(root, 'old')
    const freshDir = join(root, 'fresh')
    await mkdir(oldDir, { recursive: true })
    await mkdir(freshDir, { recursive: true })
    await writeFile(join(oldDir, 'x.cmd'), 'echo x', 'utf8')
    const stale = new Date(Date.now() - 48 * 60 * 60 * 1000)
    await utimes(oldDir, stale, stale)

    await pruneStaleScriptDirs(root, 24 * 60 * 60 * 1000)

    expect(existsSync(oldDir)).toBe(false)
    expect(existsSync(freshDir)).toBe(true)
  })

  it('is a no-op on a root that does not exist', async () => {
    await expect(pruneStaleScriptDirs(join(tmpdir(), 'dsh-cmd-absent-root'), 1000)).resolves.toBeUndefined()
  })
})
