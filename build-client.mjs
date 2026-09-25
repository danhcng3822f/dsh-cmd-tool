// Bundle lib/client.js: the closure factory the shell's module loader
// registers under this package's name.
//
// Externals are read live from the shell's own PLATFORM_MODULES list so module
// identities cannot drift from the shell's frozen table, plus react. The list
// is located through the installed package rather than a hard-coded checkout
// path, so a moved checkout still builds.
//
// Deliberately not `execFileSync('npx', ['esbuild', ...])`: spawning npx from
// Node on Windows needs a shell (.cmd shims), so this uses the esbuild JS API
// (the same devDependency, same flags) instead.
//
// No CSS: a CSS import would emit a sibling stylesheet nothing loads. The row's
// chrome comes from `DisclosureRow`, whose styles ship with the shell; the few
// styles this row owns are inline.
import { createRequire } from 'node:module'
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { build } from 'esbuild'

const require = createRequire(import.meta.url)

/** Locate the shell's platform module list, or fail loudly. */
function platformSource() {
  try {
    return require.resolve('@deepseek-ai/dsh-client-web/src/platform.ts')
  } catch {
    // The package's `./src/*` export is the documented route; a checkout whose
    // export map differs still resolves from the package root.
    const manifest = require.resolve('@deepseek-ai/dsh-client-web/package.json')
    return join(dirname(manifest), 'src', 'platform.ts')
  }
}

const platformSrc = platformSource()
const platformArray = readFileSync(platformSrc, 'utf8').match(/PLATFORM_MODULES\s*=\s*\[([\s\S]*?)\]/)?.[1]
if (platformArray === undefined) {
  throw new Error(`no PLATFORM_MODULES array found in ${platformSrc} — externals unknown, refusing to guess`)
}
const platformWords = [...platformArray.matchAll(/'([^']+)'/g)].map(match => match[1])
if (platformWords.length === 0) {
  throw new Error(`PLATFORM_MODULES extraction yielded nothing usable from ${platformSrc}`)
}
const externals = [...new Set([...platformWords, 'react'])]

mkdirSync('lib', { recursive: true })
await build({
  entryPoints: ['src/client/index.tsx'],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  jsx: 'automatic',
  external: externals,
  banner: { js: 'window.__ModuleLoader__.load({id:"dsh-cmd-tool",factory:function(require){var module={exports:{}};' },
  footer: { js: 'return module.exports;}});' },
  outfile: 'lib/client.js',
  logLevel: 'info',
})
console.log('externals:', externals.join(', '))
