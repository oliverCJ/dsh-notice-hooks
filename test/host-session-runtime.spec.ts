import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import { loadAppendPluginRecord } from '../src/index.js'

describe('optional Host Session runtime', () => {
  it('degrades when the Session runtime cannot be resolved and warns once', async () => {
    const warn = vi.fn()
    const missing = Object.assign(new Error('missing'), { code: 'ERR_MODULE_NOT_FOUND' })

    await expect(loadAppendPluginRecord(vi.fn(async () => { throw missing }), warn)).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledOnce()
  })

  it('rejects an invalid append export without failing Host startup', async () => {
    const warn = vi.fn()
    await expect(loadAppendPluginRecord(vi.fn(async () => ({ appendPluginRecord: 'bad' })), warn)).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledOnce()
  })

  it('emits dispatch-notice without a top-level Session runtime import', () => {
    const source = readFileSync('src/dispatch-notice.ts', 'utf8')
    const output = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    }).outputText

    expect(output).not.toMatch(/from ['"]@deepseek-ai\/dsh-session['"]/u)
    expect(output).not.toMatch(/require\(['"]@deepseek-ai\/dsh-session['"]\)/u)
  })
})
