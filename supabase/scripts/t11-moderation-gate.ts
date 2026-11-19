import { check } from './t06-cloud-inventory.ts'
import { t04ProjectRef } from './t04-cloud-recovery.ts'
import {
  assertModerationScope,
  fileModerationStore,
  type ModerationJournal,
  type ModerationSnapshot,
  type ModerationStore,
  parseModerationSnapshot,
  validateModerationJournal,
} from './t11-cloud-inventory.ts'
import {
  assertRecoverySnapshot,
  canonical,
  readReviewedSmokeIncident,
  type ReviewedSmokeIncident,
  reviewedSmokeIncident,
  type SmokeReviewAnchor,
  verifyArtifactChecksums,
} from './t11-cloud-recovery.ts'
import { readT11Config, requestHash } from './t11-cloud-runner.ts'

export const moderationFixtureAnchor: { runId: string; hashes: SmokeReviewAnchor['hashes'] } = {
  runId: '7066370436a444a488ca5d458bfd3846',
  hashes: {
    'json': 'afc2c139cf2120e62b54ce1bb8edcd4aaf58f2cc449b49b2613c0f3af15c8d51',
    'journal.json': 'b59dc39f25b85cef2fa340e9b29f057cff141b78ebf2f383f3aa9f75a52b1890',
    'verify.sql': 'f1d229b6c42174b288af00a55c371678fba8bc70d0d4ac0754bf137b45360083',
    'retention-plan.md': 'bd31d79b2a406f94d3fc403b19229ee3831041ced9b43e7b07ad90d684b39dc2',
    'grant-review.sql': 'ab408e32181f42bfe788de7d984544d2377e970b9edcd35e32aedf14bab7121f',
    'revoke-review.sql': 'e08f26cd7f6dcb30c4e4f21b61a191faf95c1ab7400c48cafe9d97b5b940dbf0',
  },
}

export function assertReadyModerationFixture(j: ModerationJournal) {
  validateModerationJournal(j)
  check(
    j.status === 'AWAITING_MODERATION_REVIEW' && !j.uncertain && j.roles.length === 0 &&
      j.audits.length === 0 && j.inventory.fixtures.length === 8 &&
      j.inventory.fixtures.every((f) =>
        f.id && f.immutableHash &&
        f.status === (f.kind === 'COMMENT' ? 'VISIBLE' : f.label === 'draft' ? 'DRAFT' : 'PUBLISHED') &&
        (f.kind !== 'POST' || f.status === 'DRAFT' || f.publishedHash)
      ),
    'T11_MODERATION_FIXTURE_NOT_READY',
  )
  const expected: { stage: string; phase: string; proof?: string }[] = [{
    stage: 'AUTH',
    phase: 'VERIFIED',
    proof: requestHash(JSON.stringify(j.inventory.baseline)),
  }]
  const add = (stage: string, actor: string, action: string, payload: unknown) => {
    expected.push(
      { stage: 'PRE_' + stage, phase: 'VERIFIED' },
      {
        stage,
        phase: 'INTENT',
        proof: requestHash(JSON.stringify({
          actor,
          bodyHash: requestHash(JSON.stringify({ action, payload })),
        })),
      },
      { stage, phase: 'ACK', proof: requestHash(JSON.stringify([{ http: 200, code: null }])) },
      { stage, phase: 'VERIFIED' },
    )
  }
  for (const f of j.inventory.fixtures) {
    const suffix = f.label.toUpperCase().replaceAll('-', '_')
    if (f.kind === 'POST') {
      add('CREATE_' + suffix, f.owner, 'createPost', {
        body: f.body,
        idempotencyKey: f.key,
        tag: 'CONFESSION',
        displayMode: 'ANONYMOUS',
        contactUrl: null,
      })
      if (f.label !== 'draft') add('PUBLISH_' + suffix, f.owner, 'publishPost', { postId: f.id })
    } else {add('CREATE_' + suffix, f.owner, 'createComment', {
        postId: j.inventory.fixtures.find((parent) => parent.label === f.parent)!.id,
        body: f.body,
        idempotencyKey: f.key,
      })}
  }
  expected.push({ stage: 'FIXTURES_READY', phase: 'VERIFIED', proof: requestHash(JSON.stringify(j.last)) })
  check(
    j.events.length === expected.length && j.events.every((event, index) => {
      const proof = expected[index]
      return event.stage === proof.stage && event.phase === proof.phase &&
        (!proof.proof || event.proof === proof.proof) &&
        (!event.stage.startsWith('PRE_') || event.proof === j.events[index - 1].proof)
    }),
    'T11_MODERATION_FIXTURE_HISTORY_INCOMPLETE',
  )
  assertModerationScope(j, j.last)
}

export async function readReadyModerationEvidence(
  directory = new URL('../.temp/t11-moderation/', import.meta.url),
  fixture = moderationFixtureAnchor,
  incident: ReviewedSmokeIncident = reviewedSmokeIncident,
) {
  const smoke = await readReviewedSmokeIncident(directory, incident)
  check(
    ![incident.failed.runId, incident.successful.runId].includes(fixture.runId),
    'T11_MODERATION_DISTINCT_RUN',
  )
  const files = await verifyArtifactChecksums(directory, fixture.runId, fixture.hashes)
  const j = JSON.parse(files.get('journal.json')!.toString('utf8')) as ModerationJournal
  assertReadyModerationFixture(j)
  check(
    j.inventory.runId === fixture.runId && canonical(j.inventory) ===
        canonical(JSON.parse(files.get('json')!.toString('utf8'))) &&
      canonical(j.inventory.actors) === canonical(smoke.successful.inventory.actors),
    'T11_MODERATION_INVENTORY_MISMATCH',
  )
  assertRecoverySnapshot(smoke.failed, j.inventory.baseline)
  return j
}

export function assertModerationGrantSnapshot(
  j: ModerationJournal,
  fresh: ModerationSnapshot,
  roleHash: string,
) {
  parseModerationSnapshot(fresh)
  check(
    fresh.roles.length === 1 && fresh.roles[0].role === 'ADMIN' &&
      fresh.roles[0].actorHash === j.inventory.actors.B && fresh.business.counts.roles === 1 &&
      fresh.business.roleHash === roleHash && /^[a-f0-9]{32}$/.test(roleHash),
    'T11_MODERATION_EXACT_APPROVED_ROLE',
  )
  const normalized = structuredClone(fresh)
  normalized.roles = j.last.roles
  normalized.business.counts.roles = j.last.business.counts.roles
  normalized.business.roleHash = j.last.business.roleHash
  check(canonical(normalized) === canonical(j.last), 'T11_MODERATION_PRE_GRANT_SNAPSHOT_DRIFT')
}

export function createModerationGateStore(
  config: ReturnType<typeof readT11Config>,
  env: NodeJS.ProcessEnv,
  report: (line: string) => void,
  directory = new URL('../.temp/t11-moderation/', import.meta.url),
  fixture = moderationFixtureAnchor,
  incident = reviewedSmokeIncident,
): ModerationStore {
  const roleHash = env.THEOU_T11_APPROVED_ROLE_FINGERPRINT ?? ''
  check(
    config.mode === '--moderate-write' && config.runId === fixture.runId && config.adminActor === 'B' &&
      !env.THEOU_ALLOW_T11_FIXTURE_WRITES && !config.recoveryRunId && /^[a-f0-9]{32}$/.test(roleHash) &&
      canonical(config) === canonical(readT11Config(env, t04ProjectRef, ['--moderate-write', fixture.runId])),
    'T11_MODERATION_EXACT_RUN_B_APPROVAL',
  )
  let acquired = false, verified: ModerationSnapshot | undefined
  const store = fileModerationStore(directory, {
    runId: incident.failed.runId,
    purpose: 'moderate',
    resumeRunId: fixture.runId,
    async verify(original) {
      const smoke = await readReviewedSmokeIncident(directory, incident)
      const ready = await readReadyModerationEvidence(directory, fixture, incident)
      check(
        canonical(original) === canonical(smoke.failed) && config.adminHash === ready.inventory.actors.B,
        'T11_MODERATION_APPROVED_B_HASH',
      )
      acquired = true
    },
  })
  return {
    ...store,
    async load(id) {
      check(acquired && verified && id === fixture.runId, 'T11_MODERATION_FRESH_ROLE_PROOF_REQUIRED')
      const ready = await readReadyModerationEvidence(directory, fixture, incident)
      const journal = await store.load(id)
      check(canonical(journal) === canonical(ready), 'T11_MODERATION_EXTERNAL_CHANGE')
      return journal
    },
    async verifyRecoverySnapshot(fresh) {
      verified = undefined
      check(acquired, 'T11_MODERATION_LOCK_REQUIRED')
      const ready = await readReadyModerationEvidence(directory, fixture, incident)
      assertModerationGrantSnapshot(ready, fresh, roleHash)
      verified = structuredClone(fresh)
      report('PASS: T11_MODERATION_GATE; EXACT_FIXTURES; APPROVED_B_ROLE; PROTECTED_SNAPSHOT_MATCH.')
    },
    async save(journal, actor) {
      check(
        acquired && verified && actor === 'B' && journal.inventory.runId === fixture.runId &&
          canonical(journal.roles) === canonical(verified.roles) &&
          journal.last.business.roleHash === roleHash,
        'T11_MODERATION_FRESH_ROLE_PROOF_REQUIRED',
      )
      await store.save(journal, actor)
    },
    async release() {
      acquired = false
      verified = undefined
      await store.release()
    },
  }
}
