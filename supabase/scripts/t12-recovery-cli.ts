import { readFile } from 'node:fs/promises'
import {
  readT12RecoverySources,
  runT12Recovery,
  t12RecoveryDependencies,
  t12RecoverySqlHash,
  verifyT12ReadOnlyIncident,
} from './t12-recovery.ts'

try {
  const args = process.argv.slice(2)
  if (args.length !== 1 || !['--inspect', '--evidence', '--resolve', '--followup'].includes(args[0])) {
    throw new Error('mode')
  }
  if (args[0] === '--inspect') {
    await verifyT12ReadOnlyIncident(new URL('../.temp/', import.meta.url))
    const { sourceHash } = await readT12RecoverySources()
    process.stdout.write(JSON.stringify({ sourceHash, sqlHash: t12RecoverySqlHash, cloudCalls: 0 }) + '\n')
  } else {
    const linked = await readFile(new URL('../.temp/project-ref', import.meta.url), 'utf8')
    const mode = args[0].slice(2) as 'evidence' | 'resolve' | 'followup'
    const result = await runT12Recovery(
      mode,
      { ...process.env },
      linked,
      t12RecoveryDependencies({ ...process.env }),
    )
    process.stdout.write(JSON.stringify(result) + '\n')
  }
} catch {
  // Không in lỗi SDK/CLI hoặc response/proof thô vào stdout/stderr.
  process.stderr.write('FAIL: T12_RECOVERY_STOP_REVIEW_LOCAL_EVIDENCE; NO_RETRY_NO_RAW_OUTPUT.\n')
  process.exitCode = 1
}
