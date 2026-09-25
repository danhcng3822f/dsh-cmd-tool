#!/usr/bin/env node
/**
 * Installer core for `dsh-cmd-tool`.
 *
 * Registers this package as a bundle in a DeepSeek Harness profile: builds it,
 * links it into the profile's `dependencies`, and appends it to
 * `dsh.profile.bundles` **last** (the patch layer it contributes disables a row
 * `@deepseek-ai/dsh-base` inserts, so it must be applied after that bundle).
 *
 * The two wrappers beside this file — `install.sh` and `install.ps1` — do
 * nothing but call this module. The logic lives here because the JSON edit is
 * the one step a shell cannot do portably: `jq` is not guaranteed, while Node
 * is (dsh runs on it), and the plugin is Windows-only while bash is not
 * installed by default there.
 *
 * Idempotent: re-running is safe and never duplicates the entry. It never
 * restarts dsh — the running server hosts whoever invoked this.
 *
 * @module dsh-cmd-tool/scripts/install
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The package name this installer registers. */
const PLUGIN_NAME = 'dsh-cmd-tool'

/** This package's root, derived from this module's own location. */
const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Entry artifacts the profile will load; a missing one means "not built". */
const REQUIRED_ARTIFACTS = ['lib/index.js', 'lib/executor.js', 'lib/client.js']

/** Print one progress line. */
function say(message) {
  process.stdout.write(`${message}\n`)
}

/** Print a failure and exit non-zero. */
function fail(message) {
  process.stderr.write(`\ninstall: ${message}\n`)
  process.exit(1)
}

/**
 * Run one command with the terminal's own stdio.
 *
 * `shell` is on for Windows because `npm`/`pnpm` are `.cmd` shims there, and
 * stdio is inherited rather than piped: a piped capture needs a named pipe,
 * which a confined environment may refuse.
 */
function run(command, args, cwd) {
  say(`\n$ ${command} ${args.join(' ')}`)
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
  if (result.error !== undefined) fail(`could not run ${command}: ${result.error.message}`)
  if (result.status !== 0) fail(`${command} ${args.join(' ')} exited with ${result.status}`)
}

/** Parse `--flag value`, `--flag=value`, and bare flags. */
function parseArgs(argv) {
  const options = { profile: 'web', home: undefined, uninstall: false, help: false }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    const equals = token.indexOf('=')
    const [flag, inline] = equals === -1 ? [token, undefined] : [token.slice(0, equals), token.slice(equals + 1)]
    const take = () => {
      if (inline !== undefined) return inline
      index += 1
      if (index >= argv.length) fail(`${flag} needs a value`)
      return argv[index]
    }
    switch (flag) {
      case '--profile': options.profile = take(); break
      case '--home': options.home = take(); break
      case '--uninstall': options.uninstall = true; break
      case '--help':
      case '-h': options.help = true; break
      default: fail(`unknown argument: ${token}`)
    }
  }
  if (options.profile === '') fail('--profile needs a name')
  return options
}

/** The usage text. */
function usage() {
  return [
    'Register dsh-cmd-tool as a bundle in a DeepSeek Harness profile.',
    '',
    'Usage:',
    '  ./install.sh   [--profile <name>] [--home <path>] [--uninstall]',
    '  .\\install.ps1 [--profile <name>] [--home <path>] [--uninstall]',
    '',
    'Both wrappers forward their arguments to this module verbatim, so the',
    'PowerShell entry point takes the same double-dash flags as the bash one.',
    '',
    'Options:',
    '  --profile <name>  Profile to install into (default: web)',
    '  --home <path>     Harness home (default: $DSH_HOME, else ~/.dsh)',
    '  --uninstall       Remove the bundle entry and the dependency instead',
    '  -h, --help        This text',
    '',
    'A restart of `dsh` is required afterwards; this script never does it,',
    'because the running server hosts the shell that invoked the script.',
  ].join('\n')
}

/** Resolve the harness home the same way dsh does. */
function resolveHome(explicit) {
  if (explicit !== undefined) return resolve(explicit)
  const fromEnv = process.env.DSH_HOME
  if (fromEnv !== undefined && fromEnv !== '') return resolve(fromEnv)
  return join(homedir(), '.dsh')
}

/** Read and parse a profile manifest, or fail with a usable message. */
function readManifest(path, profile) {
  if (!existsSync(path)) {
    fail(`no profile ${JSON.stringify(profile)} at ${dirname(path)} — run 'dsh plugin --profile ${profile} add <package>' once to create it`)
  }
  try {
    // A byte-order mark is tolerated rather than rejected: Windows editors and
    // `Set-Content -Encoding UTF8` add one, and this script then rewrites the
    // file without it, which repairs the manifest for dsh too.
    return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''))
  } catch (error) {
    fail(`could not parse ${path}: ${error.message}`)
  }
}

/** The main flow. */
function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    say(usage())
    return
  }

  const home = resolveHome(options.home)
  const profileDir = join(home, 'profiles', options.profile)
  const manifestPath = join(profileDir, 'package.json')

  say(`plugin:  ${PLUGIN_ROOT}`)
  say(`profile: ${profileDir}`)

  if (options.uninstall) {
    const manifest = readManifest(manifestPath, options.profile)
    const bundles = manifest.dsh?.profile?.bundles ?? []
    const before = bundles.length
    if (manifest.dsh?.profile !== undefined) {
      manifest.dsh.profile.bundles = bundles.filter(name => name !== PLUGIN_NAME)
    }
    if (manifest.dependencies !== undefined) delete manifest.dependencies[PLUGIN_NAME]
    writeFileSync(manifestPath, `${JSON.stringify(manifest, undefined, 2)}\n`)
    say(`\nremoved ${PLUGIN_NAME} from ${manifestPath} (bundles ${before} -> ${manifest.dsh?.profile?.bundles?.length ?? 0})`)
    run('pnpm', ['install'], profileDir)
    say('\nDone. Restart dsh, then reload the page.')
    return
  }

  // 1. Build. `npm install` only when node_modules is absent: it is slow, and
  //    the @deepseek-ai dependencies are `file:` links, so a re-run is safe but
  //    unnecessary.
  if (!existsSync(join(PLUGIN_ROOT, 'node_modules'))) {
    run('npm', ['install'], PLUGIN_ROOT)
  } else {
    say('\nnode_modules present — skipping npm install')
  }
  run('npm', ['run', 'build'], PLUGIN_ROOT)

  for (const artifact of REQUIRED_ARTIFACTS) {
    if (!existsSync(join(PLUGIN_ROOT, artifact))) {
      fail(`the build did not produce ${artifact} — the profile would fail to load ${PLUGIN_NAME}`)
    }
  }
  say(`\nbuilt: ${REQUIRED_ARTIFACTS.join(', ')}`)

  // 2. Register. `link:` is pnpm's protocol, which is what the profile uses.
  const manifest = readManifest(manifestPath, options.profile)
  const linkTarget = `link:${PLUGIN_ROOT.replace(/\\/g, '/')}`
  manifest.dependencies = { ...manifest.dependencies, [PLUGIN_NAME]: linkTarget }
  const existing = manifest.dsh?.profile?.bundles ?? []
  manifest.dsh = { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles: [...existing.filter(name => name !== PLUGIN_NAME), PLUGIN_NAME] } }
  writeFileSync(manifestPath, `${JSON.stringify(manifest, undefined, 2)}\n`)
  say(`\nregistered in ${manifestPath}`)
  say(`  dependencies.${PLUGIN_NAME} = ${linkTarget}`)
  say(`  dsh.profile.bundles = ${manifest.dsh.profile.bundles.join(', ')}`)

  // 3. Link it into the profile.
  run('pnpm', ['install'], profileDir)

  say('\nDone. Now restart dsh and reload the page:')
  say('  dsh.profile.bundles is read at boot and does not hot-reload, and the')
  say('  browser half is composed into the boot graph at the same point.')
  say('\nVerify the composed tree before booting:')
  say(`  dsh --profile ${options.profile} --dump-config | grep -A1 'tool-cmd'`)
  say('\nRoll back with:')
  say(`  ${process.platform === 'win32' ? 'install.ps1' : 'install.sh'} --profile ${options.profile} --uninstall`)
}

main()
