import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const fromRoot = (path: string) => fileURLToPath(new URL(`../${path}`, import.meta.url))
const englishReadme = readFileSync(fromRoot('README.md'), 'utf8')
const chineseReadme = readFileSync(fromRoot('README.zh.md'), 'utf8')
const marketplaceChecklist = readFileSync(fromRoot('docs/2026-11-05-插件市场投稿准备清单.md'), 'utf8')
const manifest = JSON.parse(readFileSync(fromRoot('package.json'), 'utf8')) as { description?: string; files?: string[] }
const enLocale = JSON.parse(readFileSync(fromRoot('locale/en.json'), 'utf8')) as { meta?: { description?: string } }
const zhLocale = JSON.parse(readFileSync(fromRoot('locale/zh.json'), 'utf8')) as { meta?: { description?: string } }
const EN_DESCRIPTION = 'Configure automation Hooks for user and project scopes to run commands on session, tool, permission, and context-compaction events. Manage Hook authorization manually in Hooks setting.'
const ZH_DESCRIPTION = '为用户和项目配置自动化 Hook，在会话、工具调用、权限请求和上下文压缩等事件发生时运行命令。Hook 授权需在“Hooks 设置”中手动管理。'

describe('release documentation', () => {
  it('ships the full license notice for bundled Lucide code', () => {
    const noticePath = fromRoot('THIRD_PARTY_NOTICES')
    expect(existsSync(noticePath)).toBe(true)
    expect(manifest.files).toContain('THIRD_PARTY_NOTICES')
    const notice = existsSync(noticePath) ? readFileSync(noticePath, 'utf8') : ''
    expect(notice).toContain('lucide-react 0.468.0')
    expect(notice).toContain('ISC License')
    expect(notice).toContain('Copyright (c) for portions of Lucide are held by Cole Bemis 2013-2022')
    expect(notice).toContain('Permission to use, copy, modify, and/or distribute this software')
  })

  it('uses one human-readable description across package, locale, and marketplace metadata', () => {
    expect(manifest.description).toBe(EN_DESCRIPTION)
    expect(enLocale.meta?.description).toBe(EN_DESCRIPTION)
    expect(zhLocale.meta?.description).toBe(ZH_DESCRIPTION)
    expect(marketplaceChecklist).toContain(`en: ${EN_DESCRIPTION}`)
    expect(marketplaceChecklist).toContain(`zh: ${ZH_DESCRIPTION}`)
    expect(englishReadme).toContain(EN_DESCRIPTION)
    expect(chineseReadme).toContain(ZH_DESCRIPTION)
    expect(`${manifest.description}\n${enLocale.meta?.description}\n${zhLocale.meta?.description}\n${englishReadme}\n${chineseReadme}\n${marketplaceChecklist}`)
      .not.toMatch(/Workspace-scoped command workflows|explicitly enabled external commands|生命周期事件发生时运行明确启用的外部命令|分作用域的外部命令工作流/)
  })

  it('uses the exact Settings labels', () => {
    expect(`${englishReadme}\n${chineseReadme}`).not.toContain('Hooks Setting')
    expect(englishReadme).toContain('Hooks setting')
    expect(chineseReadme).toContain('Hooks 设置')
  })

  it('documents source, canonical npm, and optional mirror installation', () => {
    for (const readme of [englishReadme, chineseReadme]) {
      expect(readme).toContain('git clone https://github.com/oliverCJ/dsh-notice-hooks.git')
      expect(readme).toContain('pnpm run check')
      expect(readme).toContain('pnpm pack')
      expect(readme).toContain('--registry=https://registry.npmjs.org/')
      expect(readme).toContain('--registry=https://registry.npmmirror.com')
      expect(readme).toContain('dsh-notice-hooks-0.1.0.tgz')
    }
  })

  it('separates Host and Settings support without suggesting Desktop CLI installation', () => {
    for (const readme of [englishReadme, chineseReadme]) {
      expect(readme).toMatch(/\| `web` .*\|.*\|.*\|/)
      expect(readme).toMatch(/\| `headless` .*\|.*\|.*\|/)
      expect(readme).toMatch(/\| `tui` .*\|.*\|.*\|/)
      expect(readme).toMatch(/\| `desktop` .*\|.*\|.*\|/)
      expect(readme).toContain('Electron Plugin Manager')
      expect(readme).not.toContain('dsh plugin --profile desktop add')
    }
  })
})

describe('marketplace submission materials', () => {
  it('contains the approved upstream file and workflow entry without an npm field', () => {
    expect(marketplaceChecklist).toContain('data/plugins/oliverCJ__dsh-notice-hooks.yml')
    expect(marketplaceChecklist).toContain('category: workflow')
    expect(marketplaceChecklist).toContain(`en: ${EN_DESCRIPTION}`)
    expect(marketplaceChecklist).toContain('icon: https://raw.githubusercontent.com/oliverCJ/dsh-notice-hooks/main/assets/icon-180.png')
    expect(marketplaceChecklist).not.toMatch(/^\s*npm:/m)
  })

  it('ships a real 180 by 180 PNG marketplace icon', () => {
    const icon = readFileSync(fromRoot('assets/icon-180.png'))

    expect(icon.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    expect(icon.readUInt32BE(16)).toBe(180)
    expect(icon.readUInt32BE(20)).toBe(180)
  })
})
