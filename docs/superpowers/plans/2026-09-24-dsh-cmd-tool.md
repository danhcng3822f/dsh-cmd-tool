# dsh-cmd-tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `cmd` tool to DeepSeek Harness on Windows that runs Windows Command Prompt commands alongside the existing `pwsh` tool.

**Architecture:** One out-of-tree bundle package providing two loader entries. A `CmdSandboxExecutor` subclasses the core `SandboxPwshExecutor` and overrides its protected `argv()` seam: a command carrying an internal marker becomes `[cmd.exe, /d, /c, <script>]`, anything else keeps the inherited PowerShell argv. The `cmd` tool writes the model's command to a temporary `.cmd` file and sends the marker, so `cmd.exe` reads the text verbatim from disk instead of from a command line that Node and the Windows ACL runner would re-quote.

**Tech Stack:** TypeScript (NodeNext, `tsc` → `lib/`), Vitest, Cordis plugin framework, `@deepseek-ai/*` harness packages resolved from the running installation.

**Spec:** `docs/superpowers/specs/2026-09-24-dsh-cmd-tool-design.md`

## Global Constraints

- Target platform is Windows only. `apply()` throws at plugin load on any other platform.
- Package name is `dsh-cmd-tool`. Loader entry specifiers are `dsh-cmd-tool/executor` and `dsh-cmd-tool/tool`.
- Row ids: `cmd-sandbox` (executor) and `tool-cmd` (tool).
- The marker is the exact string `dsh-cmd-script:` and must never reach the model, a job label, or a rendered result.
- `@deepseek-ai/*` imports resolve through `node_modules/@deepseek-ai`, a junction to `C:\Users\Admin\.dsh\profiles\node_modules\@deepseek-ai`. Never install `@deepseek-ai/*` from npm — a second `cordis` instance breaks the plugin tree.
- Temp scripts are UTF-8 **without BOM**, CRLF line endings, first line exactly `@echo off`.
- TypeScript is `strict` with `verbatimModuleSyntax`. Every relative import ends in `.ts`.
- All source files carry a module JSDoc block naming the module, matching the harness convention.
- Commit after every task.

---

### Task 1: Package skeleton, build wiring, and the marker protocol

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `cordis.patch.yml`
- Create: `src/protocol.ts`
- Test: `tests/protocol.spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `CMD_SCRIPT_MARKER: string`, `markScriptCommand(scriptPath: string): string`, `scriptPathOf(command: string): string | undefined`.

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "dsh-cmd-tool",
  "version": "0.1.0",
  "description": "Windows Command Prompt (cmd.exe) tool for DeepSeek Harness, alongside pwsh",
  "type": "module",
  "exports": {
    "./tool": {
      "types": "./lib/types/tool.d.ts",
      "default": "./lib/tool.js"
    },
    "./executor": {
      "types": "./lib/types/executor.d.ts",
      "default": "./lib/executor.js"
    },
    "./cordis.patch.yml": "./cordis.patch.yml",
    "./package.json": "./package.json"
  },
  "files": [
    "lib",
    "src",
    "cordis.patch.yml",
    "README.md"
  ],
  "dsh": {
    "bundle": {
      "patch": "./cordis.patch.yml"
    }
  },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "check": "tsc -p tsconfig.json --noEmit"
  },
  "keywords": [
    "deepseek-harness",
    "dsh",
    "dsh-bundle",
    "cmd",
    "windows"
  ],
  "license": "MIT",
  "engines": {
    "node": ">=22.0.0"
  }
}
```

Note there is deliberately no `@deepseek-ai/*` entry in `dependencies`: those resolve through the junction created in Step 3, which guarantees they are the exact modules the running dsh loads.

- [ ] **Step 2: Write `tsconfig.json` and `vitest.config.ts`**

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "allowImportingTsExtensions": true,
    "rewriteRelativeImportExtensions": true,
    "lib": ["ES2023"],
    "declaration": true,
    "declarationDir": "lib/types",
    "outDir": "lib",
    "rootDir": "src",
    "strict": true,
    "verbatimModuleSyntax": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["src/**/*.ts"]
}
```

`vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
})
```

- [ ] **Step 3: Install dev dependencies, then create the module junction**

Order matters: `npm install` may prune unknown entries under `node_modules`, so the junction is created **after** the install.

```powershell
cd D:\dsh-cmd-plugin
npm install --save-dev typescript@^5.9.0 vitest@^3.2.0 @types/node@^24.13.3
New-Item -ItemType Directory -Force -Path D:\dsh-cmd-plugin\node_modules | Out-Null
New-Item -ItemType Junction -Path D:\dsh-cmd-plugin\node_modules\@deepseek-ai -Target C:\Users\Admin\.dsh\profiles\node_modules\@deepseek-ai
```

Verify the junction resolves the harness packages:

```powershell
node -e "console.log(require.resolve('@deepseek-ai/dsh-pwsh-sandbox/package.json',{paths:['D:/dsh-cmd-plugin']}))"
```

Expected: a path under `D:\deepseek-harness\packages\shell\pwsh-sandbox`.

- [ ] **Step 4: Write `cordis.patch.yml`**

```yaml
# dsh-cmd-tool bundle patch.
#
# Applied after @deepseek-ai/dsh-base, so the `pwsh-sandbox` row already exists
# and this layer can disable it: ctx.shell admits exactly one provider, so the
# cmd-capable executor replaces the PowerShell-only one rather than joining it.
# The replacement keeps the PowerShell dialect for every command that does not
# carry the tool's internal marker, so the untouched `pwsh` tool behaves exactly
# as before.
#
# Override either row's config from a profile's own cordis.patch.yml, restating
# the whole `config` value — a patch replaces a row's config rather than merging.

- id: pwsh-sandbox
  disabled: true

- insert:
    - id: cmd-sandbox
      name: dsh-cmd-tool/executor
    - id: tool-cmd
      name: dsh-cmd-tool/tool
```

- [ ] **Step 5: Write the failing test `tests/protocol.spec.ts`**

```ts
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
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `npx vitest run tests/protocol.spec.ts`
Expected: FAIL — cannot resolve `../src/protocol.ts`.

- [ ] **Step 7: Write `src/protocol.ts`**

```ts
/**
 * The one fact shared by the `cmd` tool and the executor that runs it.
 *
 * The tool cannot hand `cmd.exe` a command line: `cmd.exe` re-parses its own
 * command line with rules that are incompatible with the CRT quoting Node and
 * the Windows ACL runner both apply, so quotes reach it mangled. The tool
 * therefore writes the command to a temporary `.cmd` file and sends this
 * marker plus the file path as the `command`; the executor strips the marker
 * and runs `cmd.exe /d /c <path>`, letting `cmd.exe` read the text verbatim
 * from disk.
 *
 * The marker is an internal protocol between the two entries of this package.
 * It must never reach the model: the tool supplies its own job label, call
 * card, and rendered output from the user's real command text.
 *
 * @module dsh-cmd-tool/protocol
 */

/** Prefix marking a `ctx.shell` command as "run this script file with cmd.exe". */
export const CMD_SCRIPT_MARKER = 'dsh-cmd-script:'

/**
 * Wrap a written script's path as the `command` the executor dispatches on.
 * @param scriptPath - absolute path of the temporary `.cmd` file.
 * @returns the marked command string.
 */
export function markScriptCommand(scriptPath: string): string {
  return CMD_SCRIPT_MARKER + scriptPath
}

/**
 * Recover the script path from a marked command.
 * @param command - a `ctx.shell` command string.
 * @returns the script path, or `undefined` when this is an ordinary command
 *   that must keep the executor's inherited dialect.
 */
export function scriptPathOf(command: string): string | undefined {
  return command.startsWith(CMD_SCRIPT_MARKER) ? command.slice(CMD_SCRIPT_MARKER.length) : undefined
}
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `npx vitest run tests/protocol.spec.ts`
Expected: PASS, 4 tests.

- [ ] **Step 9: Verify the build**

Run: `npm run build`
Expected: exit 0, `lib/protocol.js` and `lib/types/protocol.d.ts` exist.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "feat: package skeleton and the cmd script marker protocol"
```

---

### Task 2: `cmd.exe` resolution

**Files:**
- Create: `src/resolve.ts`
- Test: `tests/resolve.spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `candidateCmdPaths(env?: NodeJS.ProcessEnv): string[]`, `resolveCmdPath(configured?: string, env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform): string`.

This mirrors `@deepseek-ai/dsh-pwsh-local/src/resolve.ts`: dependency-free and fully parameterized, so resolution is a pure function of its inputs on every platform and the suite can exercise every branch without touching the real machine.

- [ ] **Step 1: Write the failing test `tests/resolve.spec.ts`**

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/resolve.spec.ts`
Expected: FAIL — cannot resolve `../src/resolve.ts`.

- [ ] **Step 3: Write `src/resolve.ts`**

```ts
/**
 * `cmd.exe` executable resolution, dependency-free so the executor and its
 * suites share one definition. Mirrors `@deepseek-ai/dsh-pwsh-local/resolve.ts`
 * in shape and parameterization: resolution is a pure function of its inputs,
 * so every branch is testable on any platform.
 *
 * @module dsh-cmd-tool/resolve
 */

import { lstatSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Candidate `cmd.exe` locations in resolution order: the `ComSpec` the host
 * itself uses, then the conventional System32 location. Entries may carry
 * surrounding quotes from `setx`-style definitions.
 * @param env - the environment to probe; defaults to the process environment.
 * @returns candidate `cmd.exe` executable paths.
 */
export function candidateCmdPaths(env: NodeJS.ProcessEnv = process.env): string[] {
  const candidates: string[] = []
  const comspec = (env.ComSpec ?? '').trim().replace(/^"|"$/g, '')
  if (comspec.length > 0) candidates.push(comspec)
  candidates.push(join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe'))
  return candidates
}

/**
 * Whether a candidate can be spawned. lstat opens the entry itself instead of
 * following reparse points, and a real directory never matches.
 */
function candidateExists(candidate: string): boolean {
  try {
    const stat = lstatSync(candidate)
    return stat.isFile() || stat.isSymbolicLink()
  } catch {
    // ENOENT is the expected failure; any other error names an unspawnable
    // path, so false is the safe answer for it too.
    return false
  }
}

/**
 * Resolve the `cmd.exe` the executor spawns.
 * @param configured - an explicit `cmdPath` config value, trusted as-is.
 * @param env - the environment to probe; defaults to the process environment.
 * @param platform - the platform to resolve for; defaults to the process platform.
 * @returns the first existing candidate on Windows, else `cmd.exe` for PATH resolution.
 */
export function resolveCmdPath(
  configured?: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  if (configured !== undefined && configured.length > 0) return configured
  if (platform === 'win32') {
    for (const candidate of candidateCmdPaths(env)) {
      if (candidateExists(candidate)) return candidate
    }
  }
  return 'cmd.exe'
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/resolve.spec.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: cmd.exe resolution from ComSpec and SystemRoot"
```

---

### Task 3: Temporary batch-script writer

**Files:**
- Create: `src/script.ts`
- Test: `tests/script.spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `ScriptOptions` (`{ scriptDir?: string; setCodePage?: boolean; codePage?: number }`), `WrittenScript` (`{ path: string; dispose(): Promise<void> }`), `DEFAULT_SCRIPT_DIR: string`, `toCrlf(text: string): string`, `scriptBody(command: string, options?: ScriptOptions): string`, `writeCommandScript(command: string, options?: ScriptOptions): Promise<WrittenScript>`, `pruneStaleScriptDirs(root: string, maxAgeMs: number): Promise<void>`.

- [ ] **Step 1: Write the failing test `tests/script.spec.ts`**

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/script.spec.ts`
Expected: FAIL — cannot resolve `../src/script.ts`.

- [ ] **Step 3: Write `src/script.ts`**

```ts
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/script.spec.ts`
Expected: PASS, 13 tests.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: temporary batch-script writer"
```

---

### Task 4: The dual-dialect executor

**Files:**
- Create: `src/executor.ts`
- Test: `tests/executor.spec.ts`

**Interfaces:**
- Consumes: `CMD_SCRIPT_MARKER`, `scriptPathOf` from `./protocol.ts`; `resolveCmdPath` from `./resolve.ts`.
- Produces: `name = 'cmd-sandbox'`, `Config` (interface), `Config` (schemastery schema), `class CmdSandboxExecutor extends SandboxPwshExecutor` with `protected override argv(spec: ShellExecSpec): string[]` and a public `get cmdPath(): string`. Default export is the class.

- [ ] **Step 1: Write the failing test `tests/executor.spec.ts`**

```ts
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/executor.spec.ts`
Expected: FAIL — cannot resolve `../src/executor.ts`.

- [ ] **Step 3: Write `src/executor.ts`**

```ts
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/executor.spec.ts`
Expected: PASS, 5 tests.

If the first case fails because the inherited argv has a different length, print the argv and adjust the expectation — do not change `src/executor.ts`: the unmarked branch must stay byte-identical to the parent's.

- [ ] **Step 5: Verify the build**

Run: `npm run build`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: dual-dialect cmd executor over the argv seam"
```

---

### Task 5: Model-facing rendering and the background adaptation

**Files:**
- Create: `src/render.ts`
- Create: `src/background.ts`
- Test: `tests/render.spec.ts`

**Interfaces:**
- Consumes: `ShellProcessRead`, `ShellSandboxInfo`, `CollectedOutput`, `ShellProcess` from `@deepseek-ai/dsh-shell`; `SandboxMode`, `escalationHintMarker`, `sandboxDenialMarker` from `@deepseek-ai/dsh-sandbox`.
- Produces: `RenderableCmdResult` (interface), `renderCmdResult(result: RenderableCmdResult, escalationModes?: readonly SandboxMode[]): string`, `renderCmdProcessRead(read: ShellProcessRead, sandbox?: ShellSandboxInfo, escalationModes?: readonly SandboxMode[]): string`, `processOutcome(proc: ShellProcess): { status: 'completed' | 'killed'; detail: string }`.

These are deliberate copies of `@deepseek-ai/dsh-tool-pwsh`'s `render.ts` and `background.ts`. `dsh-tool-pwsh` exports no `./render` subpath (only `.`, `./invariant`, `./src/*`), and `./src/*` would be TypeScript source that a built install cannot import at runtime. The harness itself keeps these as intentional twins, so a local copy is the established pattern rather than a shortcut.

- [ ] **Step 1: Write the failing test `tests/render.spec.ts`**

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/render.spec.ts`
Expected: FAIL — cannot resolve `../src/render.ts`.

- [ ] **Step 3: Write `src/render.ts`**

Copy `D:\deepseek-harness\packages\shell\tool-pwsh\src\render.ts` verbatim, then rename the exported symbols `renderPwshResult` → `renderCmdResult`, `renderPwshProcessRead` → `renderCmdProcessRead`, and the interface `RenderablePwshResult` → `RenderableCmdResult`. Replace the module JSDoc with:

```ts
/**
 * Model-facing result rendering for the `cmd` tool — a deliberate twin of
 * `@deepseek-ai/dsh-tool-pwsh`'s renderer, which this package cannot import
 * (`dsh-tool-pwsh` exports no `./render` subpath, and `./src/*` is TypeScript
 * source a built install cannot load). The twin keeps stdout, a marked stderr
 * section, sandbox denial/runner-failure markers with the same-turn escalation
 * hint, truncation notices with spill paths, and exit-status markers identical
 * to the pwsh tool's, so both tools read the same way to the model and to the
 * terminal card.
 *
 * @module dsh-cmd-tool/render
 */
```

- [ ] **Step 4: Write `src/background.ts`**

Copy `D:\deepseek-harness\packages\shell\tool-pwsh\src\background.ts` verbatim, replacing the module JSDoc with:

```ts
/**
 * Generic-task adaptation for background `cmd` process handles — the
 * shell-agnostic twin of `@deepseek-ai/dsh-tool-pwsh`'s background adaptation,
 * copied for the same reason as the renderer.
 *
 * @module dsh-cmd-tool/background
 */
```

Keep the `TODO(background-infrastructure-outcome)` comment: it records an upstream contract gap that applies here identically.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/render.spec.ts`
Expected: PASS, 14 tests.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: cmd result rendering and background outcome adaptation"
```

---

### Task 6: The `cmd` tool

**Files:**
- Create: `src/tool.ts`
- Test: `tests/tool.spec.ts`

**Interfaces:**
- Consumes: `markScriptCommand` from `./protocol.ts`; `writeCommandScript`, `pruneStaleScriptDirs`, `ScriptOptions` from `./script.ts`; `processOutcome` from `./background.ts`; `renderCmdResult`, `renderCmdProcessRead`, `RenderableCmdResult` from `./render.ts`.
- Produces: `name = 'tool-cmd'`, `inject`, `Config` (interface + schemastery schema), `apply(ctx: Context, config?: Config): void`, and the module-level declaration merge adding `cmd: 'cmd'` to `JobKindMap`.

- [ ] **Step 1: Write the failing test `tests/tool.spec.ts`**

This suite uses a **fake executor** so it needs no real process; the real-world suite is Task 7.

```ts
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
    // `parseExitStatus`'s pattern consumes the newline as the marker's
    // delimiter, so the recovered body has no trailing newline. The harness's
    // own pwsh suite asserts the same shape.
    expect(view).toMatchObject({ card: 'terminal', output: 'body' })
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/tool.spec.ts`
Expected: FAIL — cannot resolve `../src/tool.ts`.

- [ ] **Step 3: Write `src/tool.ts`**

Mirror `D:\deepseek-harness\packages\shell\tool-pwsh\src\index.ts` call-for-call, with these exact differences.

Imports and module JSDoc:

```ts
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

import { isAbsolute, resolve as resolvePath } from 'node:path'
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
```

Config:

```ts
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
```

Parsed args and validation (identical to `pwsh`, renamed):

```ts
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
```

Description. The first paragraph is cmd-specific; the rest is copied verbatim from `pwshDescription` because the confinement machinery is identical:

```ts
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
  return base + ' In both confined modes, programs cannot open named pipes, so a command that captures another '
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
```

`resolveWorkdir` and `canonicalCmdResult` are copied verbatim from `tool-pwsh` with `PwshForegroundResult` renamed to `CmdForegroundResult`:

```ts
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

function resolveWorkdir(modelWorkdir: string | undefined, exec: { agent?: Agent }): string | undefined {
  const headerCwd = exec.agent?.session.header.cwd
  if (modelWorkdir === undefined) return headerCwd
  if (headerCwd !== undefined && !isAbsolute(modelWorkdir)) {
    return resolvePath(headerCwd, modelWorkdir)
  }
  return modelWorkdir
}

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

const BACKGROUND_OUTPUT_PROPERTIES = {
  kind: { type: 'string', required: true, const: 'background' },
  jobId: { type: 'string', required: true },
} as const
```

`apply()`. The preamble, prompt section, parameter block, and output schema are the `pwsh` ones with `pwsh` → `cmd` in names and tool name; the execute path is the only structurally new code:

```ts
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
  void pruneStaleScriptDirs(scriptRoot, 24 * 60 * 60 * 1000)
  // Best-effort: `force` suppresses only a missing path, and a background job
  // still holding its script open at teardown would otherwise reject. An
  // unhandled rejection is fatal in dsh — the host installs a fail-loud handler
  // that exits the process — so a locked temp file must not turn a clean
  // shutdown into a crash.
  ctx.effect(() => () => {
    rm(join(scriptRoot, String(process.pid)), { recursive: true, force: true }).catch(() => {})
  })

  const resolveSandboxPolicy = (exec: ToolExecution): SandboxExecutionPolicy | undefined =>
    sandboxPolicy?.resolve(exec.agent === undefined ? {} : { session: exec.agent.session })

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
  ...
}
```

Add `import { rm } from 'node:fs/promises'`, and change the existing `node:path` import to `import { isAbsolute, join, resolve as resolvePath } from 'node:path'`. No `node:os` import is needed: the script root default comes from `DEFAULT_SCRIPT_DIR`.

The `execute` body:

```ts
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
```

The parameter block and output schema are copied from `tool-pwsh` with the description strings adjusted:

- `command`: `'The Windows Command Prompt command to execute (batch syntax; use `%%i` in `for` loops).'`
- `description` examples become `"dir" → "List files in current directory"`, `"git status" → "Show working tree status"`, `"tasklist" → "List running processes"`.
- `run_in_background`, `sandbox_permissions`, `justification`, `timeoutMs`, `workdir`: unchanged text.
- `output.schema`: the same `oneOf` union, verbatim.
- `output.render`: `renderCmdResult(value as RenderableCmdResult, escalationModes)`.
- `presentCall` / `presentResult`: copied verbatim from `tool-pwsh`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/tool.spec.ts`
Expected: PASS, 17 tests.

- [ ] **Step 5: Verify the build and the whole unit suite**

Run: `npm run build && npx vitest run`
Expected: build exit 0; all suites pass.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: the cmd tool"
```

---

### Task 7: Real `cmd.exe` integration suite

**Files:**
- Create: `tests/integration.spec.ts`

**Interfaces:**
- Consumes: the built plugin entries `../src/executor.ts` and `../src/tool.ts`, plus the harness packages listed below.
- Produces: nothing importable; this task's deliverable is the passing suite.

- [ ] **Step 1: Write `tests/integration.spec.ts`**

**Corrections applied during implementation — the code block below is superseded on these five points. `tests/integration.spec.ts` as committed is the authoritative form.** Each was found by running the block below verbatim and is verified against harness source:

1. **The `agent()` helper must carry `session.events: []` and an `id`.** A bare `{ session: { header: { id, cwd } } }` fails EVERY call: `SandboxPolicyService.resolve` returns `effectiveSandboxMode(session.events)` (`sandbox-policy/src/index.ts:150`), which indexes `events.length` (`sandbox-policy/src/session-mode.ts:53`).
2. **`AgentRegistry` (`@deepseek-ai/dsh-agent`) must be mounted and `agent()` must return a live registered instance.** `dsh-jobs-local`'s `ensureOwnerCleanup` throws without `ctx.agents` and throws again unless the owner is the exact instance `ctx.agents.get(id)` returns (`jobs-local/src/index.ts:448-456`), so the two background cases could only ever exercise the unowned path otherwise.
3. **Each background case must reuse ONE owner agent for the start, the read, and the kill.** `assertAccess` fences an owned job on `job.owner.id !== caller?.id` (`jobs-local/src/index.ts:357`), so a fresh `agent()` for `job_output` or `job_kill` raises "belongs to another session".
4. **The workspace round-trip case expects `'written \n'`, not `'written\n'`.** `cmd.exe` keeps the space that precedes the `&` separator in the first command's text, so `echo written> out.txt & type out.txt` writes the bytes `119…110 32 13 10`. Measured both through this package and with a plain `cmd /d /c` at a prompt; `echo written>out.txt& type out.txt` (no space) writes `written` with none. Asserting the exact bytes pins that the command text reached the interpreter verbatim.
5. **Two cases are added beyond the list below**, and the expected count is therefore 15, not 14: a foreground case asserting the model-facing text does not contain `CMD_SCRIPT_MARKER`, and assertions inside the background case that the rendered `job_list` label is the user's raw command and marker-free. The committed unit suites only prove the marker is *constructed*; these prove it is not rendered back.

```ts
/**
 * Integration tests: the REAL `CmdSandboxExecutor` plus the `cmd` tool,
 * exercised through `ctx.tools.execute()` against a real cmd.exe. These verify
 * the world — that quotes survive, `%VAR%` expands, batch blocks parse, exit
 * codes render, and background jobs settle through the generic job runtime.
 * The suite self-skips off Windows.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import * as ToolJobs from '@deepseek-ai/dsh-tool-jobs'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import LocalSandbox from '@deepseek-ai/dsh-sandbox-local'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import * as ShellEnv from '@deepseek-ai/dsh-shell-env'
import * as ToolPwsh from '@deepseek-ai/dsh-tool-pwsh'
import { CmdSandboxExecutor } from '../src/executor.ts'
import * as ToolCmd from '../src/tool.ts'

const testToolSignal = new AbortController().signal
const lf = (text: string): string => text.replace(/\r\n/g, '\n')

let dir: string
let ctx: Context
let counter = 0

function call(name: string, args: unknown, agentObj?: object) {
  return ctx.tools.execute({
    signal: testToolSignal,
    callId: CallId(`it-${++counter}`),
    name,
    arguments: args,
    ...agentObj ? { agent: agentObj as never } : {},
  })
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(b => b.type === 'text').map(b => b.text).join('')
}

describe.skipIf(process.platform !== 'win32')('cmd tool over the real cmd.exe', () => {
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-tool-cmd-'))
    await writeFile(join(dir, 'greeting.txt'), 'hello cmd\n')

    ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(LocalJobRegistry)
    await ctx.plugin(ToolJobs)
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(LocalSandbox)
    // Full access keeps the suite fast: the confinement path is the core
    // executor's own, covered by the pwsh suites, and is not what this suite
    // exists to verify.
    await ctx.plugin(SandboxPolicy, { mode: 'danger-full-access', workspaceRoot: dir })
    await ctx.plugin(ShellEnv)
    await ctx.plugin(CmdSandboxExecutor, { timeoutMs: 20_000, graceMs: 200 })
    await ctx.plugin(ToolCmd)
    // Mounted alongside so the dual-dialect contract is exercised, not assumed.
    await ctx.plugin(ToolPwsh)
  })

  afterEach(async () => {
    await ctx?.fiber.dispose()
    await rm(dir, { recursive: true, force: true })
  })

  const agent = () => ({ session: { header: { id: 'session-cmd-int', cwd: dir } } })

  it('runs a command and returns stdout with no marker on a clean exit', async () => {
    const result = await call('cmd', { command: 'echo hi', description: 'say hi' }, agent())
    expect(result.isError).toBe(false)
    expect(lf(text(result))).toBe('hi\n')
  })

  it('preserves quotes around a path containing spaces', async () => {
    await writeFile(join(dir, 'a b.txt'), 'spaced\n')
    const result = await call('cmd', { command: 'type "a b.txt"', description: 'read a spaced path' }, agent())
    expect(lf(text(result))).toBe('spaced\n')
  })

  it('expands environment variables', async () => {
    const result = await call('cmd', { command: 'echo [%CD%]', description: 'print the working directory' }, agent())
    // Exact, not `toContain`: a subdirectory path contains `dir` as a prefix, so
    // a containment check would also pass for the wrong directory.
    expect(lf(text(result))).toBe(`[${dir}]\n`)
  })

  it('runs a multi-line if block', async () => {
    const result = await call('cmd', {
      command: 'if exist "greeting.txt" (\r\n  echo FOUND\r\n  echo SECOND\r\n)',
      description: 'branch on a file',
    }, agent())
    expect(lf(text(result))).toBe('FOUND\nSECOND\n')
  })

  it('iterates with a doubled percent loop variable', async () => {
    const result = await call('cmd', { command: 'for %%i in (a b) do @echo item=%%i', description: 'loop' }, agent())
    expect(lf(text(result))).toBe('item=a\nitem=b\n')
  })

  it('reports a non-zero exit code', async () => {
    const result = await call('cmd', { command: 'exit /b 7', description: 'fail deliberately' }, agent())
    expect(result.isError).toBe(false)
    expect(text(result)).toContain('[exit code: 7]')
  })

  it('reports the status of the last command when the script does not exit explicitly', async () => {
    const result = await call('cmd', { command: 'cmd /c exit 9', description: 'propagate a status' }, agent())
    expect(text(result)).toContain('[exit code: 9]')
  })

  it('writes into the session workspace and reads it back', async () => {
    const result = await call('cmd', { command: 'echo written> out.txt & type out.txt', description: 'round-trip a file' }, agent())
    expect(lf(text(result))).toBe('written\n')
  })

  it('carries non-ASCII text through the script and the collector', async () => {
    const result = await call('cmd', { command: 'echo Xin chào Việt Nam', description: 'echo unicode' }, agent())
    expect(text(result)).toContain('Xin chào Việt Nam')
  })

  it('applies batch-file percent semantics end to end', async () => {
    // The file-based mechanism changes `%` handling: inside a batch file `%%`
    // is the escape for a literal `%`, whereas on a command line `%%` stays
    // `%%`. Nothing in the unit suites pins this, so it is pinned here against
    // the real interpreter.
    const result = await call('cmd', { command: 'echo 100%% done', description: 'echo a literal percent' }, agent())
    expect(lf(text(result))).toBe('100% done\n')
  })

  it('honors an explicit workdir', async () => {
    // A workdir DISTINCT from the session header cwd. `resolveWorkdir` returns
    // the session cwd when the argument is absent and the argument unchanged
    // when it is absolute, so passing `dir` here would pass identically for a
    // tool that ignored `args.workdir` entirely.
    const sub = join(dir, 'sub')
    await mkdir(sub, { recursive: true })
    const result = await call('cmd', { command: 'echo [%CD%]', description: 'print cwd', workdir: sub }, agent())
    expect(lf(text(result))).toBe(`[${sub}]\n`)
  })

  it('runs a background job and collects its output', async () => {
    const started = await call('cmd', { command: 'echo bg-ok', description: 'background echo', run_in_background: true }, agent())
    expect(text(started)).toBe('started background job cmd-1')

    const id = (started.value as { jobId: string }).jobId
    let output = ''
    for (let attempt = 0; attempt < 100; attempt++) {
      const read = await call('job_output', { job_id: id, wait: true })
      output = text(read)
      if (output.includes('bg-ok')) break
    }
    expect(output).toContain('bg-ok')
  })

  it('stops a background job on request', async () => {
    const started = await call('cmd', { command: 'ping -n 60 127.0.0.1 >nul', description: 'long ping', run_in_background: true }, agent())
    const id = (started.value as { jobId: string }).jobId
    const killed = await call('job_kill', { job_id: id }, agent())
    expect(text(killed)).toContain(id)
    const final = await call('job_output', { job_id: id, wait: true }, agent())
    expect(text(final)).toMatch(/status: (killed|completed)/)
  })

  it('serves the pwsh dialect through the same executor', async () => {
    // The dual-dialect contract: the pwsh tool shares ctx.shell with the cmd
    // tool, and its unmarked command must still run PowerShell.
    const result = await call('pwsh', { command: 'Write-Output still-pwsh', description: 'check the twin dialect' }, agent())
    expect(result.isError).toBe(false)
    expect(lf(text(result))).toBe('still-pwsh\n')
  })
})
```

- [ ] **Step 2: Run the suite**

Run: `npx vitest run tests/integration.spec.ts`
Expected: PASS on Windows, 15 tests. On a non-Windows host: skipped.

If `LocalSandbox` or `SandboxPolicy` reject the config used above, print the plugin's `Config` schema default export and correct the argument — do not drop the sandbox plugins: `CmdSandboxExecutor` injects `sandbox` and `sandboxPolicy` and will not activate without them.

- [ ] **Step 3: Run the full suite**

Run: `npx vitest run`
Expected: all suites pass.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "test: real cmd.exe integration suite"
```

---

### Task 8: Install into the web profile, verify end to end, document

**Files:**
- Create: `README.md`
- Modify: `C:\Users\Admin\.dsh\profiles\web\package.json`

**Interfaces:**
- Consumes: the built package from Tasks 1–7.
- Produces: a running dsh web profile exposing both `cmd` and `pwsh`.

- [ ] **Step 1: Build the package**

```powershell
cd D:\dsh-cmd-plugin
npm run build
Test-Path D:\dsh-cmd-plugin\lib\tool.js, D:\dsh-cmd-plugin\lib\executor.js
```

Expected: both `True`.

- [ ] **Step 2: Register the bundle in the web profile**

Edit `C:\Users\Admin\.dsh\profiles\web\package.json`:

- add to `dependencies`: `"dsh-cmd-tool": "link:D:/dsh-cmd-plugin"`
- append `"dsh-cmd-tool"` to the END of `dsh.profile.bundles` (after `@deepseek-ai/dsh-base`, so the patch can disable `pwsh-sandbox`)

Then:

```powershell
cd C:\Users\Admin\.dsh\profiles\web
pnpm install
```

- [ ] **Step 3: Verify the composed tree before restarting**

```powershell
cd D:\deepseek-harness
node --import tsx/esm apps/cli/src/bin.ts --profile web --dump-config > $env:TEMP\web-composed.yml
Select-String -Path $env:TEMP\web-composed.yml -Pattern 'pwsh-sandbox|cmd-sandbox|tool-cmd' -Context 0,3
```

Expected: a `pwsh-sandbox` row with `disabled: true`, plus `cmd-sandbox` (`dsh-cmd-tool/executor`) and `tool-cmd` (`dsh-cmd-tool/tool`) rows. If the `pwsh-sandbox` patch reports "entry not found", stop — the executor row would collide on `ctx.shell`; report the drift instead of continuing.

- [ ] **Step 4: Restart the web server and verify both tools**

Restart the running `dsh web` (the bundle list is read at boot; it does not hot-reload). Then, in a fresh session in the Web GUI, ask the model to:

1. run `cmd` with `dir "C:\Program Files" | findstr /i windows` — expect a directory listing, not a syntax error
2. run `cmd` with `for %%i in (a b) do @echo item=%%i` — expect `item=a`, `item=b`
3. run `pwsh` with `Get-ChildItem C:\ | Select-Object -First 3` — expect a listing, proving the PowerShell dialect still works on the same executor

- [ ] **Step 5: Write `README.md`**

Cover, in this order:

1. What it is: a Windows `cmd` tool alongside `pwsh`.
2. Why the command goes through a temporary script, with the measured quoting table from the spec (quoted paths, `if exist`, `%VAR%`).
3. The batch-semantics consequence: `for %%i`, `%0`/`%~dp0`.
4. Install steps (Steps 2 and 4 above), including the restart requirement and the `node_modules/@deepseek-ai` junction.
5. Configuration table: `enableRunInBackground`, `setCodePage`, `codePage`, `scriptDir`, `cmdPath` — and that `cmdPath`/`codePage` are composition-entry knobs, not `settings.yaml` knobs.
6. Known limitations: the upstream-coupling warning (renamed `pwsh-sandbox` row id or a changed `SandboxPwshExecutor.argv` requires revisiting), temp-script lifetime, and the `chcp` console side effect.
7. How to run the tests, and that `tests/integration.spec.ts` self-skips off Windows.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "docs: README and web-profile installation"
```

---

## Self-Review

**Spec coverage**

| Spec section | Task |
|---|---|
| Goal, non-goals | Global Constraints; Task 6 platform guard |
| Context: shell seam composition | Task 1 (`cordis.patch.yml`), Task 4 |
| The constraint that shapes the design | Task 3 (script writer), Task 4 (argv seam) |
| Architecture / file tree | Tasks 1–6 create every listed file |
| `cordis.patch.yml` | Task 1 Step 4 |
| `src/protocol.ts` | Task 1 |
| `src/executor.ts` | Task 4 |
| `src/script.ts` | Task 3 |
| `src/tool.ts` | Task 6 |
| Data flow | Task 6 `execute`, Task 7 end-to-end |
| Error handling (non-Windows, unresolvable cmd, write failure, denial, row drift) | Task 6 platform guard, Task 2 fallback, Task 3 throw, Task 6 escalation, Task 8 Step 3 |
| Testing (4 suites) | Tasks 1–7 |
| Installation (5 steps) | Task 8 |
| Known limitations | Task 8 Step 5 |
| Alternatives considered | Recorded in the spec; no task needed |

**Placeholder scan:** no TBD/TODO markers introduced by this plan. Task 5 carries one upstream `TODO(background-infrastructure-outcome)` comment by design, copied with its file.

**Type consistency:** `ScriptOptions` uses `setCodePage`/`codePage` in `src/script.ts` (Task 3) and identically in `src/tool.ts` (Task 6). `markScriptCommand`/`scriptPathOf` are defined in Task 1 and consumed unchanged in Tasks 4 and 6. `WrittenScript.dispose()` returns `Promise<void>` in Task 3 and is awaited in Task 6. `renderCmdResult`/`renderCmdProcessRead`/`RenderableCmdResult` are named identically in Tasks 5 and 6. `processOutcome` returns `{ status: 'completed' | 'killed'; detail: string }` in Task 5 and is used directly as a `JobHooks.done` resolution in Task 6.
