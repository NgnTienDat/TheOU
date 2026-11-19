import { readFile } from 'node:fs/promises'
import { createInterface } from 'node:readline/promises'
import { Writable } from 'node:stream'
import { ManualAuthError } from './auth-helpers.ts'
import { check } from './t06-cloud-inventory.ts'
import { createT11Cli } from './t11-cloud-cli.ts'
import { fileModerationStore } from './t11-cloud-inventory.ts'
import { readT11Config, runT11Cloud } from './t11-cloud-runner.ts'
import { createModerationGateStore } from './t11-moderation-gate.ts'
import {
  createReviewedIncidentStore,
  createSmokeRecoveryStore,
  reviewFailedSmoke,
} from './t11-cloud-recovery.ts'

let closeInput = () => {}
try {
  const linkedRef = await readFile(new URL('../.temp/project-ref', import.meta.url), 'utf8')
  const config = readT11Config(process.env, linkedRef, process.argv.slice(2)),
    cli = await createT11Cli(process.env)
  const report = (line: string) => process.stdout.write(line + '\n')
  const store = config.mode === '--fixture-write'
    ? createReviewedIncidentStore(config, process.env, report)
    : config.mode === '--moderate-write'
    ? createModerationGateStore(config, process.env, report)
    : config.recoveryRunId
    ? createSmokeRecoveryStore(config, process.env, cli, report)
    : fileModerationStore()
  if (config.mode === '--review-failed-smoke') {
    await reviewFailedSmoke(config, store)
  } else {
    let input: ReturnType<typeof createInterface> | undefined
    const hidden = async (prompt: string) => {
      check(process.stdin.isTTY && process.stdout.isTTY, 'T11_ENV_OR_INTERACTIVE_CREDENTIALS_REQUIRED')
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
    await runT11Cloud(
      config,
      process.env,
      hidden,
      store,
      () => cli.snapshot(),
      () => cli.project(),
      (line) => process.stdout.write(line + '\n'),
    )
  }
} catch (error) {
  process.stderr.write(
    (error instanceof ManualAuthError
      ? error.message
      : 'FAIL: T11_CONFIG_OR_IO. Không in lỗi hoặc response thô.') + '\n',
  )
  process.exitCode = 1
} finally {
  closeInput()
}
