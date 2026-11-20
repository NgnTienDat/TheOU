import { mkdir, open, readdir, readFile, rename, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { check } from './t06-cloud-inventory.ts'
import { identityHash, object } from './t09-cloud-inventory.ts'
import {
  type ModerationJournal,
  moderationRetentionPlan,
  moderationVerificationSql,
  roleReviewSql,
  validateModerationJournal,
} from './t11-cloud-inventory.ts'
import { canonical, readReviewedSmokeIncident, verifyArtifactChecksums } from './t11-cloud-recovery.ts'
import { sha256 } from './t12-preflight.ts'
import { t04ProjectRef } from './t04-cloud-recovery.ts'

export const t12RetainedAnchor = {
  runId: '7066370436a444a488ca5d458bfd3846',
  hashes: {
    'json': '8f094aa11c5168af1b4b30f37e130cca20d3dd8ef92db7ed3e66a35de3446b19',
    'journal.json': 'e116df24a0ae7d40fb0c721f88f408de6163b9e36604d2879351ea2ce7d1b82e',
    'verify.sql': '6c635d1db15ee16479eef3f23879b57bf317f9ce35b76a70673436ede9352650',
    'retention-plan.md': 'bd31d79b2a406f94d3fc403b19229ee3831041ced9b43e7b07ad90d684b39dc2',
    'grant-review.sql': 'e08f26cd7f6dcb30c4e4f21b61a191faf95c1ab7400c48cafe9d97b5b940dbf0',
    'revoke-review.sql': '5f847a188c0eb2a85ca6191192282cacdd46359a821288903e2819b50b549084',
  },
}
export const t12ReadOnlyIncident = {
  runId: '055bc92b6ef248818dfa2157b18fe5c4',
  path: 't12-e2e/055bc92b6ef248818dfa2157b18fe5c4/preflight.journal.json',
  hash: '953cf8892e7c9d1987a96df5f309e1de54c49898ce9f37ab14d955c74e0e2a05',
}
// Hai retention/cleanup đã được owner đóng; không đổi status của journal lịch sử.
const retainedLegacy = new Map([
  [
    't09-votes/81f0d01ff37248f2bff2de7650cf1deb.journal.json',
    '959e8639b55b82edbbf2d2a98d52bc9d30cb7f5b482772f9b2a034eb3dbc1bb8',
  ],
  [
    't10-media/241a869766c84d8fa229f30ba8ff7d6b.journal.json',
    '43d8d95c551373d4d70d4e375d0d4fba97f24bf8e19f92d696e2d7d6e873746e',
  ],
])

function assertNoPendingMarkers(value: unknown) {
  if (!value || typeof value !== 'object') return
  for (const [key, item] of Object.entries(value)) {
    check(
      !(key === 'uncertain' && item === true) &&
        !(['pending', 'unknown'].includes(key) && item !== null && item !== false && item !== '' &&
          !(Array.isArray(item) && item.length === 0)) &&
        !(key === 'state' && typeof item === 'string' &&
          ['PENDING', 'UNKNOWN', 'UNCERTAIN'].includes(item.toUpperCase())),
      'T12_UNKNOWN_MUTATION_MARKER',
    )
    assertNoPendingMarkers(item)
  }
}

export async function readT12Evidence(directory = new URL('../.temp/t11-moderation/', import.meta.url)) {
  await readReviewedSmokeIncident(directory)
  const files = await verifyArtifactChecksums(directory, t12RetainedAnchor.runId, t12RetainedAnchor.hashes)
  const journal = JSON.parse(files.get('journal.json')!.toString('utf8')) as ModerationJournal
  validateModerationJournal(journal)
  check(
    journal.status === 'AWAITING_RETENTION_AND_ROLE_REVIEW' && !journal.uncertain &&
      journal.events.length === 139 && journal.events.at(-1)?.phase === 'VERIFIED',
    'T12_T11_FINAL_HISTORY_REQUIRED',
  )
  check(
    canonical(JSON.parse(files.get('json')!.toString('utf8'))) === canonical(journal.inventory),
    'T12_T11_INVENTORY_DRIFT',
  )
  for (
    const [suffix, expected] of [
      ['verify.sql', moderationVerificationSql(journal.inventory)],
      ['retention-plan.md', moderationRetentionPlan(journal.inventory)],
      ['grant-review.sql', roleReviewSql(journal, 'B', false)],
      ['revoke-review.sql', roleReviewSql(journal, 'B', true)],
    ]
  ) check(files.get(suffix)!.toString('utf8') === expected, 'T12_T11_TEMPLATE_DRIFT')
  const expected = structuredClone(journal.last)
  // Owner đã xác nhận revoke; projection này không ghi lại journal T11.
  expected.roles = []
  expected.business.counts.roles = 0
  expected.business.roleHash = identityHash('[]')
  return expected
}

export async function assertNoT12Incidents(
  root = new URL('../.temp/', import.meta.url),
  ownLock = false,
  ownJournal?: string,
  reviewExactReadOnlyIncident?: () => Promise<void>,
) {
  if (ownJournal) {
    check(
      ownLock && /^t12-e2e\/[a-f0-9]{32}\/preflight[.]journal[.]json$/.test(ownJournal),
      'T12_OWN_JOURNAL_SCOPE',
    )
  }
  async function scan(directory: URL, relative: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      check(!entry.isSymbolicLink(), 'T12_EVIDENCE_SYMLINK_REVIEW')
      const name = relative + entry.name,
        file = new URL(entry.name + (entry.isDirectory() ? '/' : ''), directory)
      if (entry.isDirectory()) {
        await scan(file, name + '/')
        continue
      }
      if (entry.name.endsWith('.lock')) {
        check(ownLock && name === 't11-moderation/theou-dev.lock', 'T12_PROJECT_LOCK_PRESENT')
      }
      if (!entry.name.endsWith('.json')) continue
      const bytes = await readFile(file)
      // Chỉ workflow R4 đã duyệt mới được đối chiếu incident này; mặc định vẫn chặn UNCERTAIN.
      if (name === t12ReadOnlyIncident.path && reviewExactReadOnlyIncident) {
        check(ownLock && sha256(bytes) === t12ReadOnlyIncident.hash, 'T12_RECOVERY_INCIDENT_DRIFT')
        await reviewExactReadOnlyIncident()
        continue
      }
      let value: unknown
      try {
        value = JSON.parse(bytes.toString('utf8'))
      } catch {
        check(false, 'T12_INVALID_LOCAL_JSON')
      }
      if (!object(value)) continue
      if (name === ownJournal) {
        check(
          value.projectRef === t04ProjectRef && value.version === 1 &&
            ['RUNNING', 'UNCERTAIN'].includes(String(value.status)) && value.uncertain === true,
          'T12_OWN_JOURNAL_SCHEMA',
        )
        continue
      }
      if (retainedLegacy.has(name)) {
        check(
          sha256(bytes) === retainedLegacy.get(name) && value.uncertain === false,
          'T12_LEGACY_RETENTION_DRIFT',
        )
        continue
      }
      // Đủ19files đã pin được kiểm riêng; journal T11 mới không được miễn kiểm tra.
      if (name.startsWith('t11-moderation/')) continue
      assertNoPendingMarkers(value)
      if (value.status !== undefined || value.uncertain !== undefined) {
        check(
          value.uncertain === false &&
            ['COMPLETED', 'COMPLETED_SMOKE', 'PREFLIGHT_COMPLETE'].includes(String(value.status)),
          'T12_UNRESOLVED_LOCAL_JOURNAL',
        )
        check(
          Array.isArray(value.events) && value.events.length > 0 && !value.pending && !value.unknown,
          'T12_HISTORY_REQUIRED',
        )
        const pending = new Map<string, string>()
        for (const event of value.events) {
          check(
            object(event) && typeof event.stage === 'string' &&
              ['INTENT', 'ACK', 'VERIFIED'].includes(String(event.phase)),
            'T12_HISTORY_SCHEMA',
          )
          if (event.phase === 'INTENT') pending.set(event.stage, 'INTENT')
          if (event.phase === 'ACK') {
            check(pending.has(event.stage), 'T12_ACK_WITHOUT_INTENT')
            pending.set(event.stage, 'ACK')
          }
          if (event.phase === 'VERIFIED' && pending.has(event.stage)) {
            check(pending.get(event.stage) === 'ACK', 'T12_MISSING_ACK')
            pending.delete(event.stage)
          }
        }
        check(pending.size === 0, 'T12_PENDING_INTENT')
      }
    }
  }
  const legacy = new URL('t11-moderation/', root)
  const names = (await readdir(legacy)).filter((n) => n !== 'theou-dev.lock').sort()
  check(names.length === 19, 'T12_EXTRA_OR_MISSING_T11_ARTIFACT')
  await scan(root, '')
}

export async function withT12ProjectLock<T>(
  action: () => Promise<T>,
  root = new URL('../.temp/', import.meta.url),
) {
  const file = new URL('t11-moderation/theou-dev.lock', root)
  // Chung file wx với T11: runner cũ cũng bị chặn trong lúc preflight.
  const handle = await open(file, 'wx', 0o600), nonce = randomUUID()
  try {
    await handle.writeFile(nonce)
    await handle.sync()
    return await action()
  } finally {
    await handle.close()
    check(await readFile(file, 'utf8') === nonce, 'T12_LOCK_OWNERSHIP_CHANGED')
    await unlink(file)
  }
}

export interface T12ReadJournal {
  version: 1
  projectRef: string
  status: 'RUNNING' | 'UNCERTAIN' | 'PREFLIGHT_COMPLETE'
  uncertain: boolean
  baseline: import('./t11-cloud-inventory.ts').ModerationSnapshot | null
  events: { stage: 'PROJECT' | 'BEFORE' | 'AFTER'; phase: 'INTENT' | 'ACK' | 'VERIFIED'; proof: string }[]
}

export function t12ReadStore(directory: URL) {
  const file = new URL('preflight.journal.json', directory)
  return {
    async create(journal: T12ReadJournal) {
      await mkdir(directory, { recursive: true })
      const handle = await open(file, 'wx', 0o600)
      try {
        await handle.writeFile(JSON.stringify(journal))
        await handle.sync()
      } finally {
        await handle.close()
      }
    },
    async save(journal: T12ReadJournal) {
      const temp = new URL('preflight.journal.next', directory), handle = await open(temp, 'wx', 0o600)
      try {
        await handle.writeFile(JSON.stringify(journal))
        await handle.sync()
      } finally {
        await handle.close()
      }
      await rename(temp, file)
    },
  }
}
