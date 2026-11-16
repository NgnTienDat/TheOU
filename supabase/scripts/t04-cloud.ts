import { readFile } from 'node:fs/promises'
import { cleanupT04Cloud, readT04CloudConfig, runT04Cloud } from './t04-cloud-runner.ts'
import { fileRecoveryStore, T04CloudError, ensure } from './t04-cloud-recovery.ts'

try {
  const linkedRef = await readFile(new URL('../.temp/project-ref', import.meta.url), 'utf8')
  const config = readT04CloudConfig(process.env, linkedRef)
  const args = process.argv.slice(2)
  ensure(args.length === 0 || args.length === 2 && args[0] === '--cleanup', 'ARGS chỉ nhận --cleanup <runId> hoặc để trống')
  const store = fileRecoveryStore()
  const report = (line: string) => process.stdout.write(`${line}\n`)
  if (args.length) await cleanupT04Cloud(config, await store.read(args[1]), store, report)
  else await runT04Cloud(config, store, report)
} catch (error) {
  process.stderr.write(`${error instanceof T04CloudError ? error.message : 'FAIL: cấu hình, recovery I/O hoặc SDK. Không in lỗi thô; kiểm tra manifest local.'}\n`)
  process.exitCode = 1
}
