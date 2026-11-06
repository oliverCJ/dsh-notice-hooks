import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

interface PackageManifest {
  repository?: { type?: string; url?: string }
  homepage?: string
  bugs?: { url?: string }
  keywords?: string[]
  publishConfig?: { access?: string; registry?: string }
  scripts?: Record<string, string>
  peerDependencies?: Record<string, string>
  dsh?: { client?: { inject?: string[] } }
}

const manifestPath = fileURLToPath(new URL('../package.json', import.meta.url))
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as PackageManifest
const bundlePatch = readFileSync(fileURLToPath(new URL('../cordis.patch.yml', import.meta.url)), 'utf8')

describe('npm package manifest', () => {
  it('points package metadata at the public repository', () => {
    expect(manifest.repository).toEqual({
      type: 'git',
      url: 'git+https://github.com/oliverCJ/dsh-notice-hooks.git',
    })
    expect(manifest.homepage).toBe('https://github.com/oliverCJ/dsh-notice-hooks#readme')
    expect(manifest.bugs).toEqual({ url: 'https://github.com/oliverCJ/dsh-notice-hooks/issues' })
    expect(manifest.keywords).toEqual(expect.arrayContaining(['dsh', 'dsh-plugin', 'hooks', 'workflow']))
  })

  it('always publishes publicly through the canonical npm registry', () => {
    expect(manifest.publishConfig).toEqual({
      access: 'public',
      registry: 'https://registry.npmjs.org/',
    })
  })

  it('builds before packing and exposes explicit check and publish commands', () => {
    expect(manifest.scripts?.prepack).toBe('pnpm run build')
    expect(manifest.scripts?.['release:check']).toBe(
      'pnpm run check && npm publish --dry-run --access public --registry=https://registry.npmjs.org/',
    )
    expect(manifest.scripts?.['release:publish']).toBe(
      'pnpm run release:check && npm publish --access public --registry=https://registry.npmjs.org/',
    )
  })

  it('requires the first RC with official plugin records without pinning unrelated shipped packages', () => {
    expect(manifest.peerDependencies).toMatchObject({
      '@deepseek-ai/cordis': '^4.0.5',
      '@deepseek-ai/dsh-session': '>=0.2.1-rc.1 <0.2.2 || >=0.2.2-0 <0.3.0',
    })
    expect(manifest.peerDependencies).not.toHaveProperty('@deepseek-ai/dsh-workspace')
  })

  it('ships only the Hook plugin row without a fallback Workspace provider', () => {
    expect(bundlePatch).not.toContain('dsh-notice-hooks-workspace')
    expect(bundlePatch).not.toContain('@deepseek-ai/dsh-workspace')
    expect(bundlePatch.match(/id:\s*dsh-notice-hooks\s*$/gm)).toHaveLength(1)
  })

  it('injects the Conversation and Chat runtimes that own the activity flow contracts', () => {
    expect(manifest.dsh?.client?.inject).toEqual(expect.arrayContaining([
      '@deepseek-ai/dsh-client-ui-conversation',
      '@deepseek-ai/dsh-client-ui-chat',
    ]))
    expect(manifest.peerDependencies).not.toHaveProperty('@deepseek-ai/dsh-client-ui-conversation')
    expect(manifest.peerDependencies).not.toHaveProperty('@deepseek-ai/dsh-client-ui-chat')
  })

  it('keeps release scripts free of credentials, privilege escalation, and Git mutations', () => {
    const scripts = [manifest.scripts?.prepack, manifest.scripts?.['release:check'], manifest.scripts?.['release:publish']].join('\n')

    expect(scripts).not.toMatch(/token|password|sudo|git\s+(?:commit|push|tag)|npm\s+version/i)
  })
})
