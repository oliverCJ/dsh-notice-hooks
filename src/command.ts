import parseArgsStringToArgv from 'string-argv'

export function parseCommandLine(command: string): readonly [string, ...string[]] {
  if (command.includes('\0')) throw new Error('command must not contain NUL bytes')
  if (command.trim().length === 0) throw new Error('command must not be empty')

  const argv = parseArgsStringToArgv(command)
  if (argv.length === 0 || argv[0] === undefined || argv[0].length === 0) {
    throw new Error('command must contain an executable')
  }
  return argv as [string, ...string[]]
}
