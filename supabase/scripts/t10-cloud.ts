import { readFile } from 'node:fs/promises'
import { createInterface } from 'node:readline/promises'
import { Writable } from 'node:stream'
import { ManualAuthError } from './auth-helpers.ts'
import { check } from './t06-cloud-inventory.ts'
import { createT10Cli } from './t10-cloud-cli.ts'
import { fileMediaStore } from './t10-cloud-inventory.ts'
import { readT10Config, runT10Cloud } from './t10-cloud-runner.ts'

let closeInput = () => {}
try {
  const linkedRef = await readFile(new URL('../.temp/project-ref', import.meta.url), 'utf8')
  const config = readT10Config(process.env, linkedRef, process.argv.slice(2))
  const cli = await createT10Cli(process.env)
  let input: ReturnType<typeof createInterface> | undefined
  const hidden = async (prompt: string) => {
    check(process.stdin.isTTY && process.stdout.isTTY, 'T10_ENV_OR_INTERACTIVE_CREDENTIALS_REQUIRED')
    if (!input) {
      input = createInterface({
        input: process.stdin,
        output: new Writable({
          write(_data, _encoding, done) {
            done()
          },
        }),
        terminal: true,
        historySize: 0,
      })
      input.on('SIGINT', () => input?.close())
      closeInput = () => input?.close()
    }
    process.stdout.write(prompt)
    try {
      return await input.question('')
    } finally {
      process.stdout.write('\n')
    }
  }
  await runT10Cloud(
    config,
    process.env,
    hidden,
    fileMediaStore(),
    () => cli.snapshot(),
    () => cli.project(),
    (line) => process.stdout.write(line + '\n'),
  )
} catch (error) {
  process.stderr.write(
    (error instanceof ManualAuthError
      ? error.message
      : 'FAIL: T10_CONFIG_OR_IO. Không in lỗi/response thô.') + '\n',
  )
  process.exitCode = 1
} finally {
  closeInput()
}
