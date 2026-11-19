import { createHash, randomUUID } from 'node:crypto'
import { link, open, readFile, unlink } from 'node:fs/promises'
import { check } from './t06-cloud-inventory.ts'
import { t04ProjectRef } from './t04-cloud-recovery.ts'
import {
  assertModerationBaseline,
  fileModerationStore,
  type ModerationJournal,
  type ModerationSnapshot,
  type ModerationStore,
  parseModerationSnapshot,
  validateModerationJournal,
} from './t11-cloud-inventory.ts'
import { readT11Config } from './t11-cloud-runner.ts'

const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
export const canonical = (value: unknown): string =>
  JSON.stringify(
    value,
    (_key, item) =>
      item && typeof item === 'object' && !Array.isArray(item)
        ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]]))
        : item,
  )
export const smokeArtifactSuffixes = [
  'json',
  'journal.json',
  'verify.sql',
  'retention-plan.md',
  'grant-review.sql',
  'revoke-review.sql',
] as const
export interface SmokeReviewAnchor {
  runId: string
  mode: '--smoke'
  failureCode: 'T11_FEED_COUNT'
  hashes: Record<typeof smokeArtifactSuffixes[number], string>
}
// Journal legacy không lưu mode/failure: chỉ case đã review và pin đủ sáu checksum được phép phục hồi.
export const failedSmokeAnchor: SmokeReviewAnchor = {
  runId: 'f351e685c1d648edba54072418d462af',
  mode: '--smoke',
  failureCode: 'T11_FEED_COUNT',
  hashes: {
    'json': 'eab19d9826a73bf23fc0d29cac021bc40d0a026df3844edcd522babd5e61cedf',
    'journal.json': '13454926cc4c99a60defc4ef969a589a9301613d8e52dc8f84358eeab4066bfd',
    'verify.sql': '6e6f6985155c47c38095aeb39f2bdf04480a012dfa84ef0f68332847f484d6fd',
    'retention-plan.md': '87d22c492368e6310e1dbd2c6158237585f79b802e018f87a565dcd30818d77f',
    'grant-review.sql': 'e08f26cd7f6dcb30c4e4f21b61a191faf95c1ab7400c48cafe9d97b5b940dbf0',
    'revoke-review.sql': 'e08f26cd7f6dcb30c4e4f21b61a191faf95c1ab7400c48cafe9d97b5b940dbf0',
  },
}

export function assertReviewableSmoke(j: ModerationJournal, anchor: SmokeReviewAnchor) {
  validateModerationJournal(j)
  check(
    anchor.mode === '--smoke' && anchor.failureCode === 'T11_FEED_COUNT' &&
      j.inventory.runId === anchor.runId && j.inventory.projectRef === t04ProjectRef &&
      j.status === 'UNCERTAIN' && j.uncertain && j.inventory.fixtures.length === 0 &&
      j.roles.length === 0 && j.audits.length === 0,
    'T11_RECOVERY_NOT_FAILED_SMOKE',
  )
  assertModerationBaseline(j.inventory.baseline)
  assertSmokeDenials(j)
}

function assertSmokeDenials(j: ModerationJournal) {
  check(canonical(j.last) === canonical(j.inventory.baseline), 'T11_RECOVERY_HISTORICAL_DRIFT')
  const phases = ['AUTH:VERIFIED']
  for (let actor = 0; actor < 2; actor++) {
    phases.push(
      'PRE_NON_ADMIN_DENIED:VERIFIED',
      'NON_ADMIN_DENIED:INTENT',
      'NON_ADMIN_DENIED:ACK',
      'NON_ADMIN_DENIED:VERIFIED',
      'RAW_RPC_DENIAL:INTENT',
      'RAW_RPC_DENIAL:ACK',
      'RAW_RPC_DENIAL:VERIFIED',
    )
  }
  check(
    canonical(j.events.map((e) => `${e.stage}:${e.phase}`)) === canonical(phases),
    'T11_RECOVERY_PENDING_OR_BUSINESS_INTENT',
  )
  for (const event of j.events) {
    if (event.phase === 'VERIFIED') {
      check(event.proof === sha(JSON.stringify(j.last)), 'T11_RECOVERY_CHECKPOINT_PROOF')
    } else if (event.phase === 'ACK') {
      const proofs = event.stage === 'NON_ADMIN_DENIED'
        ? [sha(JSON.stringify([{ http: 403, code: 'FORBIDDEN' }]))]
        : [401, 403].map((status) => sha(JSON.stringify({ status, code: '42501' })))
      check(proofs.includes(event.proof), 'T11_RECOVERY_DENIAL_NOT_ACKNOWLEDGED')
    }
  }
}

function fingerprint(snapshot: ModerationSnapshot, baseline: ModerationSnapshot) {
  const copy = structuredClone(snapshot)
  // R1 chỉ thêm timestamp public; mọi fingerprint/field cũ vẫn phải khớp tuyệt đối.
  for (const proof of copy.postProofs) {
    if (!Object.hasOwn(baseline.postProofs.find((p) => p.id === proof.id) ?? {}, 'publishedAt')) {
      delete proof.publishedAt
    }
  }
  return sha(canonical(copy))
}

export function assertRecoverySnapshot(j: ModerationJournal, fresh: ModerationSnapshot) {
  parseModerationSnapshot(fresh)
  assertModerationBaseline(fresh)
  const expected = fingerprint(j.inventory.baseline, j.inventory.baseline)
  check(fingerprint(fresh, j.inventory.baseline) === expected, 'T11_RECOVERY_FRESH_FINGERPRINT_DRIFT')
  return expected
}

function smokeReviewRecord(j: ModerationJournal, anchor: SmokeReviewAnchor, reviewedAt: string) {
  return {
    version: 1,
    projectRef: t04ProjectRef,
    originalRunId: anchor.runId,
    originalMode: anchor.mode,
    originalChecksums: anchor.hashes,
    failureCode: anchor.failureCode,
    verifiedCheckpoints: j.events.filter((e) => e.phase === 'VERIFIED').map((e) => e.stage),
    verification: {
      readOnly: true,
      fullFingerprintsMatch: true,
      countsMatch: true,
      securityMatch: true,
      storageMetadataMatch: true,
      rolesAndAuditsUnchanged: true,
      baselineFingerprint: fingerprint(j.inventory.baseline, j.inventory.baseline),
    },
    status: 'REVIEWED_NO_BUSINESS_WRITES',
    reviewedAt,
    decision: 'SMOKE_RETRY_ONLY_NO_WRITE_AUTHORIZATION',
  }
}

function assertSmokeReviewSidecar(prior: unknown, j: ModerationJournal, anchor: SmokeReviewAnchor) {
  const time = (prior as { reviewedAt?: unknown })?.reviewedAt
  check(
    typeof time === 'string' && Number.isFinite(Date.parse(time)) &&
      new Date(Date.parse(time)).toISOString() === time && Date.parse(time) <= Date.now() &&
      canonical(prior) === canonical(smokeReviewRecord(j, anchor, time)),
    'T11_RECOVERY_INVALID_SIDECAR',
  )
}

export async function verifyArtifactChecksums(
  directory: URL,
  runId: string,
  hashes: SmokeReviewAnchor['hashes'],
) {
  check(/^[a-f0-9]{32}$/.test(runId), 'T11_INCIDENT_RUN_ID')
  const files = new Map<string, Buffer>()
  for (const suffix of smokeArtifactSuffixes) {
    const bytes = await readFile(new URL(`${runId}.${suffix}`, directory))
    check(
      sha(bytes) === hashes[suffix],
      'T11_RECOVERY_ARTIFACT_SHA',
    )
    files.set(suffix, bytes)
  }
  return files
}

export function createSmokeRecoveryStore(
  config: ReturnType<typeof readT11Config>,
  env: NodeJS.ProcessEnv,
  cli: { project(): Promise<void>; snapshot(): Promise<ModerationSnapshot> },
  report: (line: string) => void,
  directory = new URL('../.temp/t11-moderation/', import.meta.url),
  anchor = failedSmokeAnchor,
) {
  check(
    canonical(config) ===
        canonical(
          readT11Config(
            env,
            t04ProjectRef,
            config.mode === '--review-failed-smoke' ? [config.mode, config.runId!] : [config.mode],
          ),
        ) &&
      config.recoveryRunId === anchor.runId &&
      (config.mode === '--smoke' || config.mode === '--review-failed-smoke'),
    'T11_RECOVERY_CONFIG',
  )
  const review = config.mode === '--review-failed-smoke'
  const artifact = (suffix: string) => new URL(`${anchor.runId}.${suffix}`, directory)
  const originalChecksums = async () => {
    await verifyArtifactChecksums(directory, anchor.runId, anchor.hashes)
  }
  let original: ModerationJournal | undefined
  const store = fileModerationStore(directory, {
    runId: anchor.runId,
    purpose: review ? 'review' : 'retry',
    async verify(j) {
      assertReviewableSmoke(j, anchor)
      original = j
      await originalChecksums()
      const sidecar = artifact('smoke-review.json')
      let prior: unknown
      if (review) {
        try {
          await readFile(sidecar)
          check(false, 'T11_RECOVERY_SIDECAR_EXISTS')
        } catch (error) {
          if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') {
            throw error
          }
        }
      } else prior = JSON.parse(await readFile(sidecar, 'utf8'))
      if (!review) {
        assertSmokeReviewSidecar(prior, j, anchor)
      }
      await cli.project()
      assertRecoverySnapshot(j, await cli.snapshot())
      await originalChecksums()
      if (review) {
        const temp = artifact(`smoke-review.${randomUUID()}.tmp`)
        const handle = await open(temp, 'wx', 0o600)
        try {
          try {
            await handle.writeFile(
              JSON.stringify(smokeReviewRecord(j, anchor, new Date().toISOString()), null, 2) + '\n',
            )
            await handle.sync()
          } finally {
            await handle.close()
          }
          // Công bố atomic, không overwrite: link thất bại nếu sidecar đã tồn tại.
          await link(temp, sidecar)
        } finally {
          await unlink(temp)
        }
      }
      report(`PASS: T11_SMOKE_RECOVERY_${review ? 'REVIEWED_NO_BUSINESS_WRITES' : 'FRESH_RETRY_VERIFIED'}.`)
    },
  })
  return {
    ...store,
    async verifyRecoverySnapshot(snapshot: ModerationSnapshot) {
      check(original, 'T11_RECOVERY_LOCK_AND_REVIEW_REQUIRED')
      assertRecoverySnapshot(original, snapshot)
      await originalChecksums()
    },
  }
}

export async function reviewFailedSmoke(
  config: ReturnType<typeof readT11Config>,
  store: ModerationStore,
) {
  check(
    config.mode === '--review-failed-smoke' && config.runId === config.recoveryRunId &&
      store.verifyRecoverySnapshot,
    'T11_RECOVERY_REVIEW_MODE',
  )
  try {
    await store.acquire(config.runId!, false, config.mode)
  } finally {
    await store.release()
  }
}

export interface ReviewedSmokeIncident {
  failed: SmokeReviewAnchor
  sidecarHash: string
  successful: { runId: string; hashes: SmokeReviewAnchor['hashes'] }
}

// Chỉ đóng blocker của incident đã review; không đổi status cũ hoặc cấp quyền phase moderation.
export const reviewedSmokeIncident: ReviewedSmokeIncident = {
  failed: failedSmokeAnchor,
  sidecarHash: 'dd36dedbc76c760e36bc9fa0d9f62b8e03b8d03b602bc2aadb5dcc7fe70a427f',
  successful: {
    runId: 'b8e9bb37105c4668a539ed735cf1d3df',
    hashes: {
      'json': 'b996e3626ed12f582fa2b136c6d39d73aacfa92f70d6241d6e5315ad6ffeecce',
      'journal.json': '75bafe449e43315e7b3e4c3aad4777121aff2d065b4b5f83a147195da157598a',
      'verify.sql': '1fcbb0f34ff304ab24098254d8ca4d1d36cf59f66d057692c70772c6400a8c66',
      'retention-plan.md': 'ede94a294718138853ba4af502394ba0305ffc80a7beda18646b5fdcca974a53',
      'grant-review.sql': 'e08f26cd7f6dcb30c4e4f21b61a191faf95c1ab7400c48cafe9d97b5b940dbf0',
      'revoke-review.sql': 'e08f26cd7f6dcb30c4e4f21b61a191faf95c1ab7400c48cafe9d97b5b940dbf0',
    },
  },
}

export async function readReviewedSmokeIncident(
  directory = new URL('../.temp/t11-moderation/', import.meta.url),
  incident = reviewedSmokeIncident,
) {
  check(incident.failed.runId !== incident.successful.runId, 'T11_INCIDENT_DISTINCT_RUNS')
  const failedFiles = await verifyArtifactChecksums(directory, incident.failed.runId, incident.failed.hashes)
  const successfulFiles = await verifyArtifactChecksums(
    directory,
    incident.successful.runId,
    incident.successful.hashes,
  )
  const read = (id: string, files: Map<string, Buffer>) => {
    const journal = JSON.parse(files.get('journal.json')!.toString('utf8')) as ModerationJournal
    validateModerationJournal(journal)
    check(
      journal.inventory.runId === id &&
        canonical(JSON.parse(files.get('json')!.toString('utf8'))) ===
          canonical(journal.inventory),
      'T11_INCIDENT_INVENTORY_MISMATCH',
    )
    return journal
  }
  const failed = read(incident.failed.runId, failedFiles),
    successful = read(incident.successful.runId, successfulFiles)
  assertReviewableSmoke(failed, incident.failed)
  const sidecar = await readFile(new URL(`${incident.failed.runId}.smoke-review.json`, directory))
  check(sha(sidecar) === incident.sidecarHash, 'T11_INCIDENT_SIDECAR_SHA')
  assertSmokeReviewSidecar(JSON.parse(sidecar.toString('utf8')), failed, incident.failed)
  check(
    successful.status === 'COMPLETED_SMOKE' && !successful.uncertain &&
      successful.inventory.fixtures.length === 0 && successful.roles.length === 0 &&
      successful.audits.length === 0 &&
      canonical(successful.inventory.actors) === canonical(failed.inventory.actors),
    'T11_INCIDENT_RETRY_NOT_COMPLETED_SMOKE',
  )
  assertSmokeDenials(successful)
  assertRecoverySnapshot(failed, successful.inventory.baseline)
  assertRecoverySnapshot(failed, successful.last)
  return { failed, successful }
}

export function createReviewedIncidentStore(
  config: ReturnType<typeof readT11Config>,
  env: NodeJS.ProcessEnv,
  report: (line: string) => void,
  directory = new URL('../.temp/t11-moderation/', import.meta.url),
  incident = reviewedSmokeIncident,
): ModerationStore {
  check(
    config.mode === '--fixture-write' && !config.recoveryRunId &&
      !env.THEOU_ALLOW_T11_MODERATION_WRITES &&
      canonical(config) === canonical(readT11Config(env, t04ProjectRef, ['--fixture-write'])),
    'T11_INCIDENT_FIXTURE_APPROVAL_ONLY',
  )
  let acquired = false, snapshotVerified = false
  const store = fileModerationStore(directory, {
    runId: incident.failed.runId,
    purpose: 'fixture',
    async verify(journal) {
      const evidence = await readReviewedSmokeIncident(directory, incident)
      check(canonical(journal) === canonical(evidence.failed), 'T11_INCIDENT_EXTERNAL_CHANGE')
      acquired = true
    },
  })
  return {
    ...store,
    async verifyRecoverySnapshot(fresh) {
      snapshotVerified = false
      check(acquired, 'T11_INCIDENT_LOCK_REQUIRED')
      const evidence = await readReviewedSmokeIncident(directory, incident)
      assertRecoverySnapshot(evidence.failed, fresh)
      assertRecoverySnapshot(evidence.successful, fresh)
      snapshotVerified = true
      report('PASS: T11_REVIEWED_SMOKE_INCIDENT_CLOSED; FRESH_BASELINE_MATCH; FIXTURE_APPROVAL_SEPARATE.')
    },
    async save(journal, actor) {
      check(acquired && snapshotVerified, 'T11_INCIDENT_FRESH_PREFLIGHT_REQUIRED')
      await store.save(journal, actor)
    },
    async release() {
      acquired = false
      snapshotVerified = false
      await store.release()
    },
  }
}
