/**
 * Temporary batch-script writer: the mechanism that lets `cmd.exe` receive an
 * arbitrary command text intact.
 *
 * `cmd.exe` re-parses its command line with rules incompatible with the CRT
 * quoting Node and the Windows ACL runner apply, so a command passed as an
 * argv element arrives with its quotes mangled (`dir "C:\Program Files"`
 * becomes a syntax error, `if exist "C:\Windows"` answers `NO`). Writing the
 * text to a file and invoking `cmd.exe /d /c <path>` sidesteps argv quoting
 * entirely: the path carries no quote characters, so it round-trips exactly.
 *
 * The file is UTF-8 WITHOUT a BOM — a BOM would corrupt the first line — with
 * CRLF endings, and opens with `@echo off` so the interpreter does not echo
 * each command into the model's output.
 *
 * @module dsh-cmd-tool/script
 */

import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Root under which per-process script directories are created. */
export const DEFAULT_SCRIPT_DIR = join(tmpdir(), 'dsh-cmd')

/** Default code page: UTF-8, which is what the subprocess collector decodes. */
export const DEFAULT_CODE_PAGE = 65001

/** Options accepted by {@link scriptBody} and {@link writeCommandScript}. */
export interface ScriptOptions {
  /** Root directory for per-process script directories. */
  scriptDir?: string
  /** Emit the `chcp` line (default true). */
  setCodePage?: boolean
  /** Code page the script sets (default {@link DEFAULT_CODE_PAGE}). */
  codePage?: number
}

/** One written script and its cleanup handle. */
export interface WrittenScript {
  /** Absolute path of the written `.cmd` file. */
  path: string
  /** Remove the file. Idempotent; a missing file is not an error. */
  dispose(): Promise<void>
}

let counter = 0

/**
 * Normalize every line ending to CRLF. A batch file read with LF-only endings
 * mis-parses block constructs, so this is not cosmetic.
 * @param text - the text to normalize.
 * @returns the text with only CRLF line endings.
 */
export function toCrlf(text: string): string {
  return text.replace(/\r\n|\r|\n/g, '\r\n')
}

/**
 * The exact script text written for one command.
 * @param command - the model's command text.
 * @param options - code-page selection.
 * @returns `@echo off`, then an optional `chcp` line, then the command, CRLF-terminated.
 */
export function scriptBody(command: string, options: ScriptOptions = {}): string {
  const setCodePage = options.setCodePage ?? true
  const codePage = options.codePage ?? DEFAULT_CODE_PAGE
  const lines = ['@echo off']
  if (setCodePage) lines.push(`chcp ${codePage}>nul`)
  const body = command.replace(/(\r\n|\r|\n)+$/, '')
  lines.push(toCrlf(body))
  return lines.join('\r\n') + '\r\n'
}

/**
 * Write one command to a fresh temporary batch script.
 * @param command - the model's command text.
 * @param options - script directory and code-page selection.
 * @returns the written script and its cleanup handle.
 * @throws when the script directory cannot be created or the file cannot be written.
 */
export async function writeCommandScript(command: string, options: ScriptOptions = {}): Promise<WrittenScript> {
  const dir = join(options.scriptDir ?? DEFAULT_SCRIPT_DIR, String(process.pid))
  await mkdir(dir, { recursive: true })
  counter += 1
  const path = join(dir, `${counter}-${randomBytes(6).toString('hex')}.cmd`)
  // 'utf8' writes no BOM, which is required: a BOM would make cmd.exe read a
  // corrupted first line instead of `@echo off`.
  await writeFile(path, scriptBody(command, options), 'utf8')
  let disposed = false
  return {
    path,
    async dispose(): Promise<void> {
      if (disposed) return
      disposed = true
      await rm(path, { force: true })
    },
  }
}

/**
 * Best-effort removal of script directories left behind by an earlier process.
 * Age, not process liveness, is the criterion: a dead pid cannot be told apart
 * from a reused one.
 * @param root - the script root directory.
 * @param maxAgeMs - directories whose last modification is older than this are removed.
 */
export async function pruneStaleScriptDirs(root: string, maxAgeMs: number): Promise<void> {
  let entries: string[]
  try {
    entries = await readdir(root)
  } catch {
    return
  }
  const cutoff = Date.now() - maxAgeMs
  for (const entry of entries) {
    const candidate = join(root, entry)
    try {
      const info = await stat(candidate)
      if (info.isDirectory() && info.mtimeMs < cutoff) {
        await rm(candidate, { recursive: true, force: true })
      }
    } catch {
      // A concurrent process owns this directory; leave it alone.
    }
  }
}
