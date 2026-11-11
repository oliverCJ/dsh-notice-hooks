import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const ci = readFileSync('.github/workflows/ci.yml', 'utf8')
const release = readFileSync('.github/workflows/release.yml', 'utf8')
const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as { scripts?: Record<string, string> }

describe('GitHub workflows', () => {
  it('runs frozen pnpm checks and uploads coverage to Codecov', () => {
    expect(ci).toContain('pull_request:')
    expect(ci).toContain('push:')
    expect(ci).toContain('pnpm install --frozen-lockfile')
    expect(ci).toContain('pnpm run check:coverage')
    expect(ci).toContain('codecov/codecov-action')
    expect(ci).toContain('fail_ci_if_error: true')
    expect(ci).toContain('node-version: 24.9.0')
    expect(ci).toContain('pnpm/action-setup')
  })

  it('builds and uploads a version-matching tarball for numeric tags without npm publish', () => {
    expect(release).toContain('tags:')
    expect(release).toContain("'[0-9]*'")
    expect(release).not.toContain("'v*'")
    expect(release).toContain('tag="$GITHUB_REF_NAME"')
    expect(release).not.toContain('GITHUB_REF_NAME#v')
    expect(release).toContain('pnpm install --frozen-lockfile')
    expect(release).toContain('pnpm run check')
    expect(release).toContain('pnpm pack')
    expect(release).toContain('softprops/action-gh-release')
    expect(release).toContain('contents: write')
    expect(release).toContain('version')
    expect(release).not.toContain('npm publish')
  })

  it('exposes a coverage command without changing the normal test command', () => {
    expect(packageJson.scripts?.test).toBe('vitest run')
    expect(packageJson.scripts?.['check:coverage']).toContain('vitest run --coverage')
  })
})
