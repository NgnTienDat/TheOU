import { readFile } from 'node:fs/promises'
import { createInterface } from 'node:readline/promises'
import { Writable } from 'node:stream'
import { ManualAuthError } from './auth-helpers.ts'
import { check } from './t06-cloud-inventory.ts'
import { createT09Cli } from './t09-cloud-cli.ts'
import { fileVoteStore } from './t09-cloud-inventory.ts'
import { readT09Config, runT09Cloud } from './t09-cloud-runner.ts'

let closeInput = () => {}
try {
  const linkedRef = await readFile(new URL('../.temp/project-ref', import.meta.url), 'utf8')
  const config = readT09Config(process.env, linkedRef, process.argv.slice(2))
  const cli = await createT09Cli(process.env)
  let input: ReturnType<typeof createInterface> | undefined
  const hidden = async (prompt: string) => {
    check(process.stdin.isTTY && process.stdout.isTTY, 'T09_ENV_OR_INTERACTIVE_CREDENTIALS_REQUIRED')
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
  await runT09Cloud(
    config,
    process.env,
    hidden,
    fileVoteStore(),
    () => cli.snapshot(),
    () => cli.project(),
    (line) => process.stdout.write(line + '\n'),
  )
} catch (error) {
  process.stderr.write(
    (error instanceof ManualAuthError
      ? error.message
      : 'FAIL: T09_CONFIG_OR_IO. Không in lỗi/response thô.') + '\n',
  )
  process.exitCode = 1
} finally {
  closeInput()
}
