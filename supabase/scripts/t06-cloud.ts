import { readFile } from 'node:fs/promises'
import { createInterface } from 'node:readline/promises'
import { Writable } from 'node:stream'
import { ManualAuthError } from './auth-helpers.ts'
import { filePostInventory } from './t06-cloud-inventory.ts'
import { readT06Config, runT06Cloud } from './t06-cloud-runner.ts'

let closeInput = () => {}
try {
  const linkedRef = await readFile(new URL('../.temp/project-ref', import.meta.url), 'utf8')
  const config = readT06Config(process.env, linkedRef, process.argv.slice(2))
  let input: ReturnType<typeof createInterface> | undefined
  const askHidden = async (prompt: string) => {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new ManualAuthError(
        'Chưa có credentials A/B trong env. Tự điền THEOU_T06_EMAIL_A/PASSWORD_A/EMAIL_B/PASSWORD_B trong .env.auth.local, hoặc chạy terminal tương tác. Không gửi credentials qua chat.',
      )
    }
    if (!input) {
      const muted = new Writable({
        write(_chunk, _encoding, callback) {
          callback()
        },
      })
      input = createInterface({ input: process.stdin, output: muted, terminal: true, historySize: 0 })
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
  await runT06Cloud(
    config,
    process.env,
    askHidden,
    filePostInventory(),
    (line) => process.stdout.write(`${line}\n`),
  )
} catch (error) {
  process.stderr.write(
    `${
      error instanceof ManualAuthError ? error.message : 'FAIL: T06_CONFIG_OR_IO. Không in lỗi/response thô.'
    }\n`,
  )
  process.exitCode = 1
} finally {
  closeInput()
}
