import { describe, expect, it } from 'vitest'
import { parseCommandLine } from '../src/command.ts'

describe('parseCommandLine', () => {
  it('parses a quoted executable path and quoted arguments', () => {
    expect(parseCommandLine('"/Applications/My Tool/bin/hook" --event "Pre Tool"')).toEqual([
      '/Applications/My Tool/bin/hook',
      '--event',
      'Pre Tool',
    ])
  })

  it('keeps shell metacharacters as literal argv data', () => {
    expect(parseCommandLine('echo "$(touch /tmp/pwn)" "a|b" "x&&y"')).toEqual([
      'echo',
      '$(touch /tmp/pwn)',
      'a|b',
      'x&&y',
    ])
  })

  it.each(['', '   ', '\t\n'])('rejects empty input %j', (command) => {
    expect(() => parseCommandLine(command)).toThrow(/empty/i)
  })

  it('rejects NUL bytes', () => {
    expect(() => parseCommandLine('echo before\0after')).toThrow(/nul/i)
  })
})
