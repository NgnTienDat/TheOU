import { readFile } from 'node:fs/promises'
import { createInterface } from 'node:readline/promises'
import { Writable } from 'node:stream'
import { ManualAuthError } from './auth-helpers.ts'
import { check } from './t06-cloud-inventory.ts'
import { fileCommentInventory, readCommentInventory } from './t08-cloud-inventory.ts'
import { confirmT08Project, readT08Config, runT08Cloud } from './t08-cloud-runner.ts'
import { createT08Cli } from './t08-cloud-cli.ts'
import { fileCommentDeleteStore } from './t08-cloud-delete.ts'

let closeInput = () => {}
try {
  const linkedRef = await readFile(
    new URL('../.temp/project-ref', import.meta.url),
    'utf8',
  )
  const config = readT08Config(process.env, linkedRef, process.argv.slice(2))
  const resume = config.runId ? await readCommentInventory(config.runId) : undefined
  const cli = await createT08Cli(process.env)
  confirmT08Project(await cli.projects())
  let input: ReturnType<typeof createInterface> | undefined
  async function askHidden(prompt: string) {
    check(
      process.stdin.isTTY && process.stdout.isTTY,
      'T08_A_B_CREDENTIALS_ENV_OR_INTERACTIVE_REQUIRED',
    )
    if (!input) {
      input = createInterface({
        input: process.stdin,
        output: new Writable({
          write(_chunk, _encoding, done) {
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
  await runT08Cloud(
    config,
    process.env,
    askHidden,
    fileCommentInventory(),
    (expected = resume) => cli.snapshot(expected ?? undefined),
    (line) => process.stdout.write(line + '\n'),
    undefined,
    resume,
    config.mode === '--resume-delete' ? fileCommentDeleteStore() : undefined,
  )
} catch (error) {
  process.stderr.write(
    (error instanceof ManualAuthError
      ? error.message
      : 'FAIL: T08_CONFIG_OR_IO. Không in lỗi/response thô.') + '\n',
  )
  process.exitCode = 1
} finally {
  closeInput()
}
