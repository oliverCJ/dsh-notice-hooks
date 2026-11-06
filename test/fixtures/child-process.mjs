import { spawn } from 'node:child_process'
import { appendFileSync, writeFileSync } from 'node:fs'

const mode = process.argv[2]

if (mode === 'stdin') {
  let input = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', chunk => { input += chunk })
  process.stdin.on('end', () => { process.stdout.write(input) })
} else if (mode === 'output') {
  process.stdout.write('o'.repeat(70 * 1024))
  process.stderr.write('e'.repeat(70 * 1024))
} else if (mode === 'exit') {
  process.stderr.write('intentional failure')
  process.exitCode = 7
} else if (mode === 'linger') {
  setInterval(() => {}, 1000)
} else if (mode === 'append' || mode === 'append-json') {
  let input = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', chunk => { input += chunk })
  process.stdin.on('end', () => {
    const payload = JSON.parse(input)
    appendFileSync(process.argv[3], mode === 'append' ? `${payload.hook_event_name}\n` : input)
  })
} else if (mode === 'linger-file') {
  writeFileSync(process.argv[3], `${process.pid}\n`)
  setInterval(() => {}, 1000)
} else if (mode === 'tree') {
  const child = spawn(process.execPath, [new URL(import.meta.url).pathname, 'linger'], {
    stdio: 'ignore',
  })
  process.stdout.write(`${child.pid}\n`)
  setInterval(() => {}, 1000)
} else {
  process.stderr.write(`unknown mode: ${String(mode)}`)
  process.exitCode = 2
}
