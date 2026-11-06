import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { build, type UserConfig } from 'tsdown'
import { afterEach, describe, expect, it } from 'vitest'
import clientConfig from '../tsdown.config.js'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

async function buildClientArtifact(): Promise<string> {
  const outputDirectory = mkdtempSync(join(tmpdir(), 'dsh-notice-hooks-client-'))
  temporaryDirectories.push(outputDirectory)
  await build({
    ...(clientConfig as UserConfig),
    clean: true,
    logLevel: 'silent',
    outDir: outputDirectory,
  })
  return readFileSync(join(outputDirectory, 'client.js'), 'utf8')
}

describe('Client bundle artifact', () => {
  it('boots using only modules supplied by the desktop platform table', async () => {
    const source = await buildClientArtifact()
    const nodeRequire = createRequire(import.meta.url)
    const platformModules = new Map<string, unknown>([
      ['react', nodeRequire('react')],
      ['react/jsx-runtime', nodeRequire('react/jsx-runtime')],
      ['react-dom/client', nodeRequire('react-dom/client')],
      ['@deepseek-ai/cordis', nodeRequire('@deepseek-ai/cordis')],
    ])
    const requests: string[] = []
    let registeredId: string | undefined

    const window = {
      __ModuleLoader__: {
        load(registration: { id: string; factory: (require: (id: string) => unknown) => unknown }) {
          registeredId = registration.id
          registration.factory((id) => {
            requests.push(id)
            if (!platformModules.has(id)) throw new Error(`desktop module table has no entry for ${id}`)
            return platformModules.get(id)
          })
        },
      },
    }

    expect(() => runInNewContext(source, { window })).not.toThrow()
    expect(registeredId).toBe('dsh-notice-hooks')
    expect(requests).toEqual(expect.arrayContaining(['react', 'react/jsx-runtime']))
    expect(requests.every(id => platformModules.has(id))).toBe(true)
  })

  it('bundles only the Lucide icon used by the activity row', async () => {
    const source = await buildClientArtifact()

    expect(source).toContain('createLucideIcon("Webhook"')
    expect(source).not.toContain('createLucideIcon("AArrowDown"')
    expect(Buffer.byteLength(source, 'utf8')).toBeLessThan(200 * 1024)
  })

  it('carries the shared content font-size axis into dispatch row styles', async () => {
    const source = await buildClientArtifact()

    expect(source).toContain('.dnh-dispatch-row {')
    expect(source).toContain('.dnh-dispatch-icon svg {')
    expect(source).toContain('font-size: var(--dsh-code-font-size, 11px)')
    expect(source).toContain('line-height: calc(19px + var(--dsh-code-font-delta, 0px))')
    expect(source).toContain('width: calc(13px + var(--dsh-code-font-delta, 0px))')
    expect(source).toContain('width: calc(11px + var(--dsh-code-font-delta, 0px))')
    expect(source).toContain('overflow-wrap: anywhere')
    expect(source).toContain('var(--dsw-alias-label-tertiary)')
    expect(source).not.toContain('var(--dsw-alias-state-success-primary)')
    expect(source).not.toContain('var(--dsw-alias-state-warn-primary)')
  })
})
