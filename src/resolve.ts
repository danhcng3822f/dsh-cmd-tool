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
