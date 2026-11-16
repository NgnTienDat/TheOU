import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'

export const t04ProjectRef = 'puhkisyehspcmgzerutm'
export const fixtureRoles = ['banned', 'admin', 'race'] as const
export const uuidPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i
export type FixtureRole = typeof fixtureRoles[number]
export interface Baseline { users: number; profiles: number; roles: number }
export interface Recovery {
  projectRef: string
  runId: string
  baseline: Baseline
  fixtures: { role: FixtureRole; email: string; id: string | null }[]
}
export interface RecoveryStore {
  save(record: Recovery): Promise<void>
  remove(runId: string): Promise<void>
}
export class T04CloudError extends Error {}
export function ensure(condition: unknown, stage: string): asserts condition {
  if (!condition) throw new T04CloudError(`FAIL: ${stage}. Không in response hoặc lỗi SDK thô.`)
}
export function fixtureEmail(runId: string, role: FixtureRole): string {
  ensure(/^[a-f0-9]{32}$/.test(runId) && fixtureRoles.includes(role), 'FIXTURE_ID_INVALID')
  return `theou-t04-${runId}-${role}@ou.edu.vn`
}
export function validateRecovery(value: unknown): Recovery {
  const r = value as Recovery
  ensure(r && typeof r === 'object' && Object.keys(r).sort().join(',') === 'baseline,fixtures,projectRef,runId', 'RECOVERY_SHAPE')
  ensure(r.projectRef === t04ProjectRef && typeof r.runId === 'string' && /^[a-f0-9]{32}$/.test(r.runId), 'RECOVERY_TARGET')
  ensure(r.baseline && Object.keys(r.baseline).sort().join(',') === 'profiles,roles,users' &&
    Object.values(r.baseline).every(n => Number.isSafeInteger(n) && n >= 0), 'RECOVERY_BASELINE')
  ensure(Array.isArray(r.fixtures) && r.fixtures.length === 3, 'RECOVERY_FIXTURES')
  const ids: string[] = []
  for (const [index, f] of r.fixtures.entries()) {
    ensure(f && Object.keys(f).sort().join(',') === 'email,id,role' && f.role === fixtureRoles[index] &&
      f.email === fixtureEmail(r.runId, f.role) && (f.id === null || typeof f.id === 'string' && uuidPattern.test(f.id)), 'RECOVERY_FIXTURE_SCOPE')
    if (f.id) ids.push(f.id)
  }
  ensure(new Set(ids).size === ids.length, 'RECOVERY_DUPLICATE_ID')
  return r
}

export function fileRecoveryStore(directory = new URL('../.temp/t04-cloud/', import.meta.url)) {
  function path(runId: string, suffix = '.json') {
    ensure(/^[a-f0-9]{32}$/.test(runId), 'RECOVERY_PATH')
    return new URL(`${runId}${suffix}`, directory)
  }
  return {
    async save(record: Recovery) {
      validateRecovery(record)
      await mkdir(directory, { recursive: true })
      const temporary = path(record.runId, '.tmp')
      await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 })
      await rename(temporary, path(record.runId))
    },
    async read(runId: string) {
      const record = validateRecovery(JSON.parse(await readFile(path(runId), 'utf8')))
      ensure(record.runId === runId, 'RECOVERY_RUN_MISMATCH')
      return record
    },
    async remove(runId: string) { await unlink(path(runId)) },
  }
}
