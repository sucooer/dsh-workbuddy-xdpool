/**
 * The `@earendil-works/pi-ai` copy the HOST will consume the stream with.
 *
 * The failure this module exists to remove: the plugin assembles its provider
 * with one copy of pi-ai while the host's `PiAiAdapter` consumes the event
 * stream with another. The two generations disagree on the shape of the
 * terminal message, the seam between them throws `Cannot read properties of
 * undefined (reading 'length')`, and the host classifies that as a
 * non-retryable `PI_AI_ERROR` — every turn fails instantly, with no content and
 * no useful error.
 *
 * A `package.json` range cannot prevent it: a range describes what a package
 * tolerates, never which copy the OTHER side resolved on this machine (a
 * neighbouring plugin pinning `@earendil-works/pi-ai` to an older generation is
 * enough to move the plugin's own import off the host's). So the host's copy is
 * located and loaded here, and the plugin's own import is kept as the fallback.
 *
 * That is why the search starts at Electron's `resources/` instead of at this
 * file's `node_modules`: the desktop host is an Electron app whose dependency
 * tree ships inside its bundle (`app.asar`), out of reach of a plain module walk
 * from the profile.
 *
 * Everything here is best-effort by design. When the host copy cannot be found
 * or read — a plain-Node host, an unexpected layout — the plugin keeps its own
 * import and, at worst, says so in the log. Refusing to start over a filesystem
 * guess would be a worse bug than the mismatch being guarded against.
 *
 * @module dsh-workbuddy-xdpool/host-pi-ai
 */

import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createProvider } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import {
  generationOf,
  piAiGenerationFrom,
  piAiMismatchMessage,
} from '../pi-ai-generation.ts'

/** The package whose generation has to agree across the adapter seam. */
const PI_AI_PACKAGE = '@earendil-works/pi-ai'

/**
 * The host package that consumes the provider.
 *
 * This plugin imports it by bare name and the host's own module map answers, so
 * its resolved location is a handle on the host's dependency tree even when
 * that tree is inside the host's bundle.
 */
const HOST_ADAPTER_PACKAGE = '@deepseek-ai/dsh-llm-pi-ai'

/**
 * The package's entry points, relative to its own directory.
 *
 * Spelled out rather than resolved: `require.resolve` cannot see the `./api/*`
 * subpath (pi-ai publishes it for `import` only), and this layout has held
 * across every generation this plugin spans. A miss is not fatal — the copy is
 * treated as unusable and the plugin's own import takes over.
 */
const PI_AI_MAIN = 'dist/index.js'
const PI_AI_OPENAI_COMPLETIONS_LAZY = 'dist/api/openai-completions.lazy.js'

/**
 * `/node_modules` roots, relative to a host resources directory, that can hold
 * the harness's own dependency tree.
 *
 * `app.asar/dsh` is the shipped desktop layout (the harness itself sits in
 * `dsh/`); the flat and unpacked variants cover a plain `app/` bundle and a
 * development build. Every candidate costs a single `existsSync`, so the list
 * can afford to be generous.
 */
const HOST_MODULE_ROOTS = [
  'app.asar/dsh/node_modules',
  'app.asar/node_modules',
  'app/node_modules',
  'app.asar.unpacked/dsh/node_modules',
  'app.asar.unpacked/node_modules',
] as const

/** What the provider assembly needs from a pi-ai copy. */
export interface PiAiSurface {
  createProvider: typeof createProvider
  openAICompletionsApi: typeof openAICompletionsApi
  /** Which copy this is, for the log line. */
  source: 'host' | 'plugin'
  /** The copy's version, when it could be read. */
  version?: string
}

/** A host copy of pi-ai as found on disk. */
export interface HostPiAi {
  /** The `node_modules` root it was found under. */
  root: string
  /** The package directory itself. */
  dir: string
  version: string
}

/** The plugin's own copy, used whenever the host's cannot be used. */
export const PLUGIN_PI_AI: PiAiSurface = {
  createProvider,
  openAICompletionsApi,
  source: 'plugin',
}

/** {@link choosePiAiSurface}'s verdict. */
export interface PiAiChoice {
  /** The copy the provider must be assembled with. */
  surface: PiAiSurface
  /**
   * Set only when the two copies disagree AND the host's could not be loaded —
   * the one state the plugin cannot fix by itself. Names both versions and the
   * manual remedy, so the report is actionable rather than a vague warning.
   */
  warning?: string
  /** What was chosen and why; logged at info level. */
  note: string
}

/**
 * Directories whose sibling `resources/` may hold the host's bundled
 * `node_modules`.
 *
 * `process.resourcesPath` is Electron's own answer and is preferred. The
 * executable's directory is the fallback for a host that runs the app through a
 * wrapper, where the property can be missing.
 */
export function hostBases(): string[] {
  const bases: string[] = []
  const resources = (process as NodeJS.Process & { resourcesPath?: unknown }).resourcesPath
  if (typeof resources === 'string' && resources !== '') bases.push(resources)
  const exec = process.execPath
  if (typeof exec === 'string' && exec !== '') {
    const beside = join(dirname(exec), 'resources')
    if (!bases.includes(beside)) bases.push(beside)
  }
  return bases
}

/** Expand resource directories into the `node_modules` roots worth probing. */
export function candidateHostRoots(bases: readonly string[]): string[] {
  const roots: string[] = []
  for (const base of bases) {
    for (const relative of HOST_MODULE_ROOTS) {
      // Not `join(base, relative)`: the relative paths carry separators on
      // purpose, and splitting them keeps this correct on Windows and POSIX
      // alike without a platform check.
      roots.push(join(base, ...relative.split('/')))
    }
  }
  return roots
}

/** Read one pi-ai package directory, or `undefined` when it is not one. */
function readPiAiDir(dir: string): HostPiAi | undefined {
  const manifest = join(dir, 'package.json')
  try {
    if (!existsSync(manifest)) return undefined
    const pkg = JSON.parse(readFileSync(manifest, 'utf8')) as { version?: unknown }
    if (typeof pkg.version !== 'string') return undefined
    // `@earendil-works/pi-ai` → root is the `node_modules` that holds it.
    return { root: dirname(dirname(dir)), dir, version: pkg.version }
  } catch {
    return undefined
  }
}

/**
 * Resolve pi-ai from the host ADAPTER's own location.
 *
 * Consulted only when the adapter resolved to something inside an archive
 * (`.asar`): outside a bundle the plugin's and the host's `node_modules` are one
 * and the same tree, and there is nothing to align. Inside a bundle this is the
 * better anchor of the two — the adapter is the one host module this plugin can
 * already load, so its directory is the host's tree by construction, whatever
 * layout the packaging step chose.
 */
function piAiBesideHostAdapter(): HostPiAi | undefined {
  try {
    const resolve = (import.meta as { resolve?: (specifier: string) => string }).resolve
    if (typeof resolve !== 'function') return undefined
    const anchor = resolve(HOST_ADAPTER_PACKAGE)
    if (!anchor.includes('.asar')) return undefined
    // `new URL(...)`: `createRequire` wants a path or a URL, and the string
    // `import.meta.resolve` returns would otherwise be read as a relative path.
    const besideAdapter = createRequire(new URL(anchor))
    return readPiAiDir(dirname(besideAdapter.resolve(`${PI_AI_PACKAGE}/package.json`)))
  } catch {
    return undefined
  }
}

/**
 * Locate the host's pi-ai under the given roots.
 *
 * `existsSync`/`readFileSync` are asar-aware inside Electron, which is the only
 * reason an in-archive path is readable here at all.
 */
export function findHostPiAi(roots: readonly string[]): HostPiAi | undefined {
  for (const root of roots) {
    const found = readPiAiDir(join(root, ...PI_AI_PACKAGE.split('/')))
    if (found !== undefined) return found
  }
  return piAiBesideHostAdapter()
}

/**
 * Load the host's copy as a module.
 *
 * The absolute path is imported rather than the bare specifier, because a bare
 * specifier would resolve through the PLUGIN's `node_modules` — landing back on
 * the copy this exists to get away from. Importing by path also means the host
 * and the plugin share one module instance whenever the host imported the same
 * file.
 */
async function loadHostSurface(host: HostPiAi): Promise<PiAiSurface | undefined> {
  const main = join(host.dir, ...PI_AI_MAIN.split('/'))
  const lazy = join(host.dir, ...PI_AI_OPENAI_COMPLETIONS_LAZY.split('/'))
  try {
    if (!existsSync(main) || !existsSync(lazy)) return undefined
    const loaded = await Promise.all([
      import(/* @vite-ignore */ pathToFileURL(main).href),
      import(/* @vite-ignore */ pathToFileURL(lazy).href),
    ])
    // Split rather than cast on the `await`: the two module namespaces are
    // unknown until their exports are checked below.
    const [mainModule, lazyModule] = loaded as [
      { createProvider?: unknown },
      { openAICompletionsApi?: unknown },
    ]
    const create = mainModule.createProvider
    const openai = lazyModule.openAICompletionsApi
    if (typeof create !== 'function' || typeof openai !== 'function') return undefined
    return {
      createProvider: create as PiAiSurface['createProvider'],
      openAICompletionsApi: openai as PiAiSurface['openAICompletionsApi'],
      source: 'host',
      version: host.version,
    }
  } catch {
    return undefined
  }
}

/** A one-line description of a surface, for the log and for diagnostics. */
function describe(surface: PiAiSurface): string {
  const where = surface.source === 'host' ? 'host' : 'plugin'
  return surface.version === undefined ? where : `${where} ${surface.version}`
}

/**
 * Decide which pi-ai the provider must be assembled with.
 *
 * Aligned generations keep the plugin's own import: the check exists to catch a
 * split, and a copy that already agrees is the cheapest correct answer. A split
 * is fixed by loading the host's copy; only when that fails does the caller get
 * a warning to log.
 *
 * @param pluginDir - this plugin's install root, the anchor for its own copy.
 * @param roots - host `node_modules` roots to probe; defaults to this machine's.
 */
export async function choosePiAiSurface(
  pluginDir: string,
  roots: readonly string[] = candidateHostRoots(hostBases()),
): Promise<PiAiChoice> {
  const plugin = piAiGenerationFrom(pluginDir)
  const host = findHostPiAi(roots)

  if (plugin === undefined) {
    return { surface: PLUGIN_PI_AI, note: 'pi-ai generation unknown (plugin copy unresolvable)' }
  }
  if (host === undefined) {
    return { surface: PLUGIN_PI_AI, note: `using ${describe(PLUGIN_PI_AI)} (no host copy found)` }
  }
  if (generationOf(plugin.version) === generationOf(host.version)) {
    return { surface: PLUGIN_PI_AI, note: `using ${describe(PLUGIN_PI_AI)} (aligned with host)` }
  }

  const hostSurface = await loadHostSurface(host)
  if (hostSurface !== undefined) {
    return { surface: hostSurface, note: `using ${describe(hostSurface)} (plugin had ${plugin.version})` }
  }

  return {
    surface: PLUGIN_PI_AI,
    note: `using ${describe(PLUGIN_PI_AI)} (host copy unreadable)`,
    warning: piAiMismatchMessage({
      kind: 'mismatched',
      plugin,
      host: { version: host.version, resolvedFrom: join(host.dir, 'package.json') },
    }),
  }
}
