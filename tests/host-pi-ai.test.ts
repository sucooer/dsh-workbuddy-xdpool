/**
 * Tests for the host-copy loader.
 *
 * The production failure: the plugin assembled its provider with one pi-ai
 * generation while the host's `PiAiAdapter` consumed the stream with another,
 * so every turn failed with a non-retryable `PI_AI_ERROR` and no content. These
 * tests cover the decision that replaced trusting the plugin's own import — and,
 * just as importantly, the states where it must change NOTHING (aligned
 * generations, no host copy, an unreadable host copy), because a loader that
 * misfires would break installs that work today.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  PLUGIN_PI_AI,
  candidateHostRoots,
  choosePiAiSurface,
  findHostPiAi,
} from '../src/host-pi-ai.ts'

/** A fake host `node_modules` root holding pi-ai at `version`. */
function fakeHostRoot(version: string, entryPoints = false): string {
  const root = mkdtempSync(join(tmpdir(), 'host-piai-'))
  const modules = join(root, 'node_modules')
  const pkg = join(modules, '@earendil-works', 'pi-ai')
  mkdirSync(pkg, { recursive: true })
  writeFileSync(
    join(pkg, 'package.json'),
    // `type: module` matters: the entry points below are loaded through a real
    // dynamic import, and a `.js` file without it is parsed as CommonJS.
    JSON.stringify({ name: '@earendil-works/pi-ai', version, type: 'module' }),
    'utf8',
  )
  if (entryPoints) {
    mkdirSync(join(pkg, 'dist', 'api'), { recursive: true })
    writeFileSync(
      join(pkg, 'dist', 'index.js'),
      'export function createProvider() { return { copy: "host" } }\n',
      'utf8',
    )
    writeFileSync(
      join(pkg, 'dist', 'api', 'openai-completions.lazy.js'),
      'export function openAICompletionsApi() { return { copy: "host-api" } }\n',
      'utf8',
    )
  }
  return modules
}

/** A fake plugin install root whose OWN pi-ai is at `version`. */
function fakePluginRoot(version: string): string {
  const root = mkdtempSync(join(tmpdir(), 'plugin-piai-'))
  const pkg = join(root, 'node_modules', '@earendil-works', 'pi-ai')
  mkdirSync(pkg, { recursive: true })
  writeFileSync(
    join(pkg, 'package.json'),
    JSON.stringify({ name: '@earendil-works/pi-ai', version }),
    'utf8',
  )
  return root
}

describe('candidateHostRoots', () => {
  it('expands a resources directory into the layouts a host may use', () => {
    const roots = candidateHostRoots([join('/host', 'resources')])
    // The shipped Electron layout is the one that matters; the rest are cheap
    // probes for a plain `app/` bundle and an unpacked build.
    expect(roots).toContain(join('/host', 'resources', 'app.asar', 'dsh', 'node_modules'))
    expect(roots).toContain(join('/host', 'resources', 'app.asar', 'node_modules'))
    expect(roots.every(root => root.includes('node_modules'))).toBe(true)
  })

  it('is empty when the host exposes no resources directory', () => {
    expect(candidateHostRoots([])).toEqual([])
  })
})

describe('findHostPiAi', () => {
  it('reads the version from the first root that has the package', () => {
    const empty = join(mkdtempSync(join(tmpdir(), 'host-none-')), 'node_modules')
    const found = findHostPiAi([empty, fakeHostRoot('0.87.1')])
    expect(found?.version).toBe('0.87.1')
  })

  it('returns undefined when no root has the package', () => {
    expect(findHostPiAi([])).toBeUndefined()
  })
})

describe('choosePiAiSurface', () => {
  it('leaves an aligned install alone', async () => {
    // A patch difference is not a split: the plugin's own copy stays in use.
    const choice = await choosePiAiSurface(fakePluginRoot('0.85.1'), [fakeHostRoot('0.85.3')])
    expect(choice.surface).toBe(PLUGIN_PI_AI)
    expect(choice.warning).toBeUndefined()
    expect(choice.note).toContain('aligned')
  })

  it('leaves the plugin alone when no host copy is found', async () => {
    const choice = await choosePiAiSurface(fakePluginRoot('0.82.1'), [])
    expect(choice.surface).toBe(PLUGIN_PI_AI)
    expect(choice.warning).toBeUndefined()
    expect(choice.note).toContain('no host copy')
  })

  it('loads the host copy when the generations differ', async () => {
    // The reported failure: 0.82.1 in the profile, 0.87.1 in the host bundle.
    const choice = await choosePiAiSurface(fakePluginRoot('0.82.1'), [fakeHostRoot('0.87.1', true)])
    expect(choice.surface.source).toBe('host')
    expect(choice.surface.version).toBe('0.87.1')
    expect(choice.warning).toBeUndefined()
    // Not just "a host copy was chosen": the loaded module is what gets used.
    const createProvider = choice.surface.createProvider as unknown as () => { copy: string }
    expect(createProvider()).toEqual({ copy: 'host' })
  })

  it('warns with both versions when the host copy cannot be read', async () => {
    // A package directory without entry points: the split is real, but nothing
    // can be loaded, so the only honest outcome is a warning the user can act on.
    const choice = await choosePiAiSurface(fakePluginRoot('0.82.1'), [fakeHostRoot('0.87.1')])
    expect(choice.surface).toBe(PLUGIN_PI_AI)
    expect(choice.warning).toContain('0.82.1')
    expect(choice.warning).toContain('0.87.1')
    expect(choice.warning).toContain('PI_AI_ERROR')
  })
})
