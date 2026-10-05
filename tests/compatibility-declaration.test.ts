/**
 * Guard the declarations a user reads BEFORE they trust the plugin.
 *
 * A false compatibility declaration is expensive in a specific way: it makes
 * everyone diagnose in the wrong direction. `engines.dsh` said `<0.2.0` while
 * the card demonstrably worked on 0.2.0, so the first thing anyone did was
 * assume the plugin was out of range — and a bug report was filed and later
 * withdrawn on that assumption.
 *
 * These tests keep the stated range and the documented entry point honest, since
 * both are cheap to let rot.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(import.meta.dirname, '..')
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
  dependencies?: Record<string, string>
  engines?: Record<string, string>
  peerDependencies?: Record<string, string>
  version?: string
}
const readme = readFileSync(join(ROOT, 'README.md'), 'utf8')

describe('engines.dsh admits the generation that actually works', () => {
  it('allows 0.2.x', () => {
    const range = pkg.engines?.['dsh'] ?? ''
    expect(range).not.toBe('')
    // The concrete regression: `<0.2.0` excluded a host the plugin runs on
    // fine, so the declaration contradicted reality.
    expect(range).toContain('<0.3.0')
  })

  it('still refuses a major version it has never been tested against', () => {
    // Widening is not "accept anything": an untested major should still be
    // flagged by the range rather than silently claimed as supported.
    const range = pkg.engines?.['dsh'] ?? ''
    expect(range).not.toMatch(/^>=0\.1\.5-rc\.1$/)
    expect(range).toContain('<0.3.0')
  })

  it('keeps the host peer ranges in step with engines.dsh', () => {
    // These bound the SAME host packages; letting them disagree is how the
    // original inconsistency appeared.
    for (const name of ['@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-llm-pi-ai', '@deepseek-ai/dsh-settings']) {
      const range = pkg.peerDependencies?.[name] ?? ''
      expect(range, `${name} must admit the 0.2.x line too`).toContain('<0.3.0')
    }
  })
})

describe('the README points at the entry point that exists', () => {
  it('does not INSTRUCT the reader to use the removed 0.1.x path', () => {
    // "设置 → 插件 → DSH WorkBuddy XD Pool" was right for 0.1.x and is wrong
    // from 0.2.0 on, where the card is a PEER tab of 通用设置/模型/内置插件.
    //
    // A historical mention is fine and deliberately kept — it is what tells an
    // upgrading user why their old habit stopped working. What must not appear
    // is that path as an INSTRUCTION, so the assertions target the imperative
    // forms (the image caption and the "装完以后" line) rather than the string
    // appearing anywhere at all.
    expect(readme).not.toMatch(/插件配置卡片（设置 → 插件/u)
    expect(readme).not.toMatch(/装完以后：[^。]*设置 → 插件/u)
    // And the explanatory mention must be framed as history, not as guidance.
    const mention = /（0\.1\.x 时代它叫「设置 → 插件 → DSH WorkBuddy XD Pool」[^）]*）/u.exec(readme)
    expect(mention, 'the old path may only appear as a historical note').not.toBeNull()
    expect(mention?.[0]).toContain('找不到')
  })

  it('names the tab the user will actually see', () => {
    expect(readme).toContain('XD Pool')
  })

  it('says how to OPEN the settings panel', () => {
    // The entry point is only actionable with the way in: the gear in the
    // sidebar, or the shortcut.
    expect(readme).toMatch(/Ctrl\+Alt\+,/)
  })

  it('does not still claim adaptation to the 0.1.2 host alone', () => {
    expect(readme).not.toContain('已针对 DSH Desktop host `0.1.2` 适配')
    expect(readme).toContain('0.2.0')
  })
})

describe('pi-ai is pinned to the host generation at install time', () => {
  it('is a direct dependency, not a peer', () => {
    // The regression this guards: as an OPTIONAL PEER, pi-ai resolved to
    // whatever the profile happened to hoist. One neighbouring plugin pinning
    // 0.82.1 was enough to move the plugin onto a different generation than the
    // host adapter's 0.87, and every turn then failed with a non-retryable
    // `PI_AI_ERROR`. A range can describe what a package tolerates; it cannot
    // describe which copy the HOST resolved on that machine.
    expect(pkg.dependencies?.['@earendil-works/pi-ai']).toBeDefined()
    expect(pkg.peerDependencies?.['@earendil-works/pi-ai']).toBeUndefined()
  })

  it('pins one generation, not a span of them', () => {
    const range = pkg.dependencies?.['@earendil-works/pi-ai'] ?? ''
    // `^0.87.1` is >=0.87.1 <0.88.0 — exactly the host's generation. On the 0.x
    // line a caret stops at the next minor, which is the boundary that matters
    // here: anything wider (or a bare `>=`) would silently admit a split again.
    expect(range).toMatch(/^\^0\.\d+\.\d+/u)
  })
})
