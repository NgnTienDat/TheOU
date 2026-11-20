import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile } from 'node:fs/promises'
import { ManualAuthError } from './auth-helpers.ts'
import { canonical } from './t11-cloud-recovery.ts'
import { assertNoT12Incidents, readT12Evidence, t12ReadStore, withT12ProjectLock } from './t12-evidence.ts'
import { createT12Cli, runT12Preflight } from './t12-cloud-runner.ts'
import {
  readT12Compatibility,
  readT12Config,
  sha256,
  t12FixturePlan,
  t12RoleReviewTemplate,
  t12SnapshotSql,
} from './t12-preflight.ts'

try {
  const args = process.argv.slice(2)
  const linked = args[0] === '--prepare'
    ? ''
    : await readFile(new URL('../.temp/project-ref', import.meta.url), 'utf8')
  const config = readT12Config(process.env, linked, args)
  const compatibility = await readT12Compatibility(),
    sql = t12SnapshotSql(compatibility)
  if (config.mode === '--prepare') {
    const expected = await readT12Evidence()
    await assertNoT12Incidents()
    const directory = new URL('../.temp/t12-e2e-review/', import.meta.url)
    await mkdir(directory, { recursive: true })
    const outputs = {
      // Version mới sau sửa CF-01; không overwrite SQL/checksums lịch sử.
      'preflight-cli-r3-v2.sql': `${sql};\n`,
      'fixture-plan.json': JSON.stringify(
        {
          version: 1,
          budget: { posts: 4, comments: 5, objects: 3 },
          fixtures: t12FixturePlan,
          roles: 'UNVERIFIED',
          keys: 'generate once per approved manifest; keep retry snapshot/key',
          retention: 'PENDING_OWNER_APPROVAL_KEEP_ROWS_AND_AUDITS',
          retainedExpectedHash: sha256(canonical(expected)),
          freshBaseline: 'NOT_COLLECTED',
        },
        null,
        2,
      ) + '\n',
      'grant-review.md': t12RoleReviewTemplate('grant'),
      'revoke-review.md': t12RoleReviewTemplate('revoke'),
    }
    // Không overwrite: partial output sau I/O failure phải được review, không tự xóa để retry.
    for (const [name, text] of Object.entries(outputs)) {
      const handle = await open(new URL(name, directory), 'wx', 0o600)
      try {
        await handle.writeFile(text)
        await handle.sync()
      } finally {
        await handle.close()
      }
    }
    process.stdout.write(
      'PASS: T12_LOCAL_TEMPLATES_PREPARED; supabase/.temp/t12-e2e-review/; ZERO_CLOUD_CALLS; NOT_EXECUTION_APPROVAL.\n',
    )
  } else {
    await withT12ProjectLock(async () => {
      const review = async () => {
        await readT12Evidence()
        await assertNoT12Incidents(undefined, true)
      }
      await review()
      const expected = await readT12Evidence()
      const runId = randomUUID().replaceAll('-', '')
      const store = t12ReadStore(
        new URL(`../.temp/t12-e2e/${runId}/`, import.meta.url),
      )
      // CLI initialization/version không gọi Auth hoặc social-api. Không có fetch business trong entrypoint.
      const cli = await createT12Cli(process.env, sql)
      await runT12Preflight(expected, cli, store, async () => {
        await readT12Evidence()
        await assertNoT12Incidents(
          undefined,
          true,
          `t12-e2e/${runId}/preflight.journal.json`,
        )
      }, (line) => process.stdout.write(line + '\n'))
    })
  }
} catch (error) {
  process.stderr.write(
    (error instanceof ManualAuthError
      ? error.message
      : 'FAIL: T12_LOCAL_CONFIG_OR_IO; no raw errors/records.') + '\n',
  )
  process.exitCode = 1
}
