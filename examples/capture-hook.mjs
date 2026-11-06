#!/usr/bin/env node
import { randomUUID } from 'node:crypto'
import { open, rename, unlink } from 'node:fs/promises'

const MAX_INPUT_BYTES = 128 * 1024 + 1
const outputPath = process.argv[2]

if (!outputPath) {
  console.error('Usage: capture-hook.mjs <output-file>')
  process.exitCode = 2
} else {
  const chunks = []
  let bytes = 0
  for await (const chunk of process.stdin) {
    bytes += chunk.length
    if (bytes > MAX_INPUT_BYTES) throw new Error('Hook payload exceeds 128 KiB')
    chunks.push(chunk)
  }

  const input = Buffer.concat(chunks).toString('utf8').trimEnd()
  const payload = JSON.parse(input)
  const content = `${JSON.stringify(payload, null, 2)}\n`
  const temporaryPath = `${outputPath}.${process.pid}.${randomUUID()}.tmp`
  let handle
  try {
    handle = await open(temporaryPath, 'wx', 0o600)
    await handle.writeFile(content, 'utf8')
    await handle.sync()
    await handle.close()
    handle = undefined
    await rename(temporaryPath, outputPath)
  } catch (error) {
    await handle?.close().catch(() => undefined)
    await unlink(temporaryPath).catch(() => undefined)
    throw error
  }
}
