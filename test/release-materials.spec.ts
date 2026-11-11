import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Resvg } from '@resvg/resvg-js'
import { describe, expect, it } from 'vitest'

const fromRoot = (path: string) => fileURLToPath(new URL(`../${path}`, import.meta.url))
const englishReadme = readFileSync(fromRoot('README.md'), 'utf8')
const chineseReadme = readFileSync(fromRoot('README.zh.md'), 'utf8')
const iconSvg = readFileSync(fromRoot('icon.svg'), 'utf8')
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

  it('uses one human-readable description across package, locale, and README metadata', () => {
    expect(manifest.description).toBe(EN_DESCRIPTION)
    expect(enLocale.meta?.description).toBe(EN_DESCRIPTION)
    expect(zhLocale.meta?.description).toBe(ZH_DESCRIPTION)
    expect(englishReadme).toContain(EN_DESCRIPTION)
    expect(chineseReadme).toContain(ZH_DESCRIPTION)
    expect(`${manifest.description}\n${enLocale.meta?.description}\n${zhLocale.meta?.description}\n${englishReadme}\n${chineseReadme}`)
      .not.toMatch(/Workspace-scoped command workflows|explicitly enabled external commands|生命周期事件发生时运行明确启用的外部命令|分作用域的外部命令工作流/)
  })

  it('uses the exact Settings labels', () => {
    expect(`${englishReadme}\n${chineseReadme}`).not.toContain('Hooks Setting')
    expect(englishReadme).toContain('Hooks setting')
    expect(chineseReadme).toContain('Hooks 设置')
  })

  it('keeps the English Highlights section fully English', () => {
    const highlights = englishReadme.match(/## Highlights\n([\s\S]*?)\n## /u)?.[1] ?? ''

    expect(highlights).not.toBe('')
    expect(highlights).not.toMatch(/[\p{Script=Han}，。：]/u)
    expect(highlights).toContain('**14 lifecycle events**: session, tool, permission, subagent, stop, and context-compaction events.')
  })

  it('documents source, canonical npm, and optional mirror installation', () => {
    for (const readme of [englishReadme, chineseReadme]) {
      expect(readme).toContain('git clone https://github.com/oliverCJ/dsh-notice-hooks.git')
      expect(readme).toContain('pnpm run check')
      expect(readme).toContain('pnpm pack')
      expect(readme).not.toContain('--registry=')
      expect(readme).toContain('dsh plugin --profile web add dsh-notice-hooks')
      expect(readme).toContain('dsh-notice-hooks-0.1.3.tgz')
    }
  })

  it('provides bilingual quick-start and post-install steps', () => {
    expect(englishReadme).toContain('## Quick start')
    expect(englishReadme).toContain('### Desktop')
    expect(englishReadme).toContain('### CLI profiles')
    expect(englishReadme).toContain('### After installation')
    expect(englishReadme).toContain('Open **Hooks setting**')
    expect(chineseReadme).toContain('## 快速开始')
    expect(chineseReadme).toContain('### Desktop')
    expect(chineseReadme).toContain('### CLI profile')
    expect(chineseReadme).toContain('### 安装后')
    expect(chineseReadme).toContain('打开 **Hooks 设置**')
  })

  it('documents the Settings screenshot and organized README structure', () => {
    expect(englishReadme).toContain('assets/hook-settings.png')
    expect(englishReadme).toContain('Configuration scopes')
    expect(englishReadme).toContain('Authorization')
    expect(englishReadme).toContain('Settings')
    expect(englishReadme).toContain('Chat activity feedback')
    expect(chineseReadme).toContain('assets/hook-settings.png')
    expect(chineseReadme).toContain('双层作用域')
    expect(chineseReadme).toContain('授权模型')
    expect(chineseReadme).toContain('Settings')
    expect(chineseReadme).toContain('会话活动提示')
    expect(existsSync(fromRoot('assets/hook-settings.png'))).toBe(true)
  })

  it('recommends CC Notice as an optional companion without weakening authorization', () => {
    expect(englishReadme).toContain('## Recommended companion: CC Notice')
    expect(chineseReadme).toContain('## 推荐搭配：CC Notice')
    for (const readme of [englishReadme, chineseReadme]) {
      expect(readme).toContain('https://github.com/oliverCJ/cc-notice')
      expect(readme).toMatch(/desktop notifications|桌面通知/u)
      expect(readme).toMatch(/sounds|声音/u)
      expect(readme).toContain('Webhook')
      expect(readme).toMatch(/hardware-device feedback|硬件设备反馈/u)
      expect(readme).toMatch(/Hooks setting|Hooks 设置/u)
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

describe('release icon materials', () => {
  it('ships an original whale with the provided yellow hook and a matching 180px PNG', () => {
    const icon = readFileSync(fromRoot('assets/icon-180.png'))

    expect(iconSvg).toContain('aria-label="Whale Hook"')
    expect(iconSvg).toContain('data-part="whale"')
    expect(iconSvg).toContain('data-part="hook"')
    expect(iconSvg).toContain('fill="#ffffff"')
    expect(iconSvg).toContain('fill="#20242c"')
    expect(iconSvg).toContain('data-part="hook"')
    expect(iconSvg.match(/data-part="hook"[^>]*fill="#f9c23c"/u)).not.toBeNull()
    expect(iconSvg.match(/data-part="hook"[^>]*stroke=/u)).toBeNull()
    expect(iconSvg.match(/data-part="signal-line"[^>]*stroke="#f9c23c"/u)).not.toBeNull()
    expect(iconSvg.match(/data-part="signal-wave"[^>]*stroke="#f9c23c"/u)).not.toBeNull()
    expect(iconSvg).not.toContain('#ef4444')
    expect(iconSvg).not.toMatch(/<(?:script|text|linearGradient|radialGradient|style)\b|(?:xlink:)?href=/u)
    expect(iconSvg).not.toMatch(/url\((?!#)/u)
    expect(icon.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    expect(icon.readUInt32BE(16)).toBe(180)
    expect(icon.readUInt32BE(20)).toBe(180)
    expect(icon.readUInt8(25)).toBe(6)

    const rendered = new Resvg(iconSvg, { fitTo: { mode: 'width', value: 180 } }).render().asPng()
    expect(icon).toEqual(Buffer.from(rendered))
  })
})
