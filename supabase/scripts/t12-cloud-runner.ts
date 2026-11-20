import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { check } from './t06-cloud-inventory.ts'
import { type CliExecute, resolveT08Cli } from './t08-cloud-cli.ts'
import { confirmT08Project } from './t08-cloud-runner.ts'
import { object } from './t09-cloud-inventory.ts'
import { type ModerationSnapshot } from './t11-cloud-inventory.ts'
import { canonical } from './t11-cloud-recovery.ts'
import { parseT12Proof, sha256 } from './t12-preflight.ts'
import { type T12ReadJournal } from './t12-evidence.ts'
import { t04ProjectRef } from './t04-cloud-recovery.ts'

export async function createT12Cli(
  env: NodeJS.ProcessEnv,
  sql: string,
  execute: CliExecute = promisify(execFile),
) {
  const executable = await resolveT08Cli(env)
  const command = async (args: string[]) => {
    try {
      return (await execute(executable, args, {
        cwd: fileURLToPath(new URL('../../', import.meta.url)),
        env: { ...env, DO_NOT_TRACK: '1', SUPABASE_NO_UPDATE_NOTIFIER: '1' },
        windowsHide: true,
        encoding: 'utf8',
        timeout: 60_000,
        maxBuffer: 8 * 1024 * 1024,
      })).stdout
    } catch {
      check(false, 'T12_CLI_FAILED_NO_RAW_OUTPUT')
      throw new Error('unreachable')
    }
  }
  check((await command(['--version'])).trim() === '3.1.0', 'T12_CLI_VERSION')
  const json = async (args: string[]) => {
    try {
      return JSON.parse(await command(args)) as unknown
    } catch {
      check(false, 'T12_CLI_INVALID_OR_FAILED_JSON')
    }
  }
  return {
    async project() {
      const value = await json(['projects', 'list', '--output-format', 'json'])
      confirmT08Project(Array.isArray(value) ? { projects: value } : value)
    },
    async snapshot() {
      const value = await json([
        'db',
        'query',
        `--remote=${t04ProjectRef}`,
        '--read-only',
        '--output-format',
        'json',
        sql,
      ])
      const rows = Array.isArray(value) ? value : object(value) ? value.rows : null
      check(Array.isArray(rows) && rows.length === 1 && object(rows[0]), 'T12_CLI_PROOF_SHAPE')
      return rows[0].proof
    },
  }
}

export async function runT12Preflight(
  expected: ModerationSnapshot,
  cli: { project(): Promise<void>; snapshot(): Promise<unknown> },
  store: { create(j: T12ReadJournal): Promise<void>; save(j: T12ReadJournal): Promise<void> },
  reviewEvidence: () => Promise<void>,
  report: (line: string) => void,
) {
  const journal: T12ReadJournal = {
    version: 1,
    projectRef: t04ProjectRef,
    status: 'RUNNING',
    uncertain: true,
    baseline: null,
    events: [],
  }
  await store.create(journal)
  async function step<T>(stage: 'PROJECT' | 'BEFORE' | 'AFTER', operation: () => Promise<T>) {
    journal.events.push({ stage, phase: 'INTENT', proof: sha256(stage) })
    await store.save(journal)
    const result = await operation()
    const proof = sha256(canonical(result ?? { projectVerified: true }))
    journal.events.push({ stage, phase: 'ACK', proof })
    await store.save(journal)
    journal.events.push({ stage, phase: 'VERIFIED', proof })
    await store.save(journal)
    return result
  }
  try {
    await reviewEvidence()
    await step('PROJECT', () => cli.project())
    const before = await step('BEFORE', async () => parseT12Proof(await cli.snapshot(), expected))
    journal.baseline = before
    await store.save(journal)
    await reviewEvidence()
    const after = await step('AFTER', async () => parseT12Proof(await cli.snapshot(), expected))
    check(canonical(before) === canonical(after), 'T12_READ_ONLY_BEFORE_AFTER_DRIFT')
    await reviewEvidence()
    journal.status = 'PREFLIGHT_COMPLETE'
    journal.uncertain = false
    await store.save(journal)
    report(
      'PASS: T12_SQL_PREFLIGHT_ONLY; FULL_SNAPSHOT_MATCH; ROLES_0; AUTH_POLICY_ACTORS_EDGE_DEPLOYMENT_PENDING; NO_WRITE_PERMISSION.',
    )
  } catch (error) {
    journal.status = 'UNCERTAIN'
    journal.uncertain = true
    await store.save(journal)
    throw error
  }
}
