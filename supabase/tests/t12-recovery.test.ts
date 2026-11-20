import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, mkdtemp, readdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { canonical } from '../scripts/t11-cloud-recovery.ts'
import { type ModerationSnapshot } from '../scripts/t11-cloud-inventory.ts'
import { assertNoT12Incidents, t12ReadOnlyIncident } from '../scripts/t12-evidence.ts'
import { identityHash } from '../scripts/t09-cloud-inventory.ts'
import { readT12Compatibility, sha256, t12Origin, t12SnapshotSql } from '../scripts/t12-preflight.ts'
import { t04ProjectRef } from '../scripts/t04-cloud-recovery.ts'
import {
  createT12RecoveryFile,
  readT12RecoveryApproval,
  type RecoveryMode,
  runT12Recovery,
  t12RecoverySqlHash,
  verifyT12ReadOnlyIncident,
} from '../scripts/t12-recovery.ts'

const digest = (v: unknown) => sha256(canonical(v))
const hash = identityHash('synthetic'), id = '11111111-1111-4111-8111-111111111111'
function snapshot(): ModerationSnapshot {
  return {
    business: {
      readOnly: 'on',
      counts: {
        users: 0,
        profiles: 0,
        roles: 0,
        posts: 1,
        comments: 0,
        votes: 0,
        images: 0,
        reports: 0,
        moderation: 2,
        limits: 0,
      },
      authHash: hash,
      profileHash: hash,
      roleHash: identityHash('[]'),
      otherHash: hash,
      owners: [],
      posts: [{
        id,
        authorHash: hash,
        status: 'HIDDEN',
        upvoteCount: 0,
        voteCount: 0,
        commentCount: 0,
        visibleCount: 0,
        protectedHash: hash,
        rowHash: hash,
      }],
      comments: [],
      votes: [],
    },
    security: true,
    storageHash: hash,
    auxHash: hash,
    postProofs: [{ id, keyHash: hash, bodyHash: hash, immutableHash: hash, publishedHash: hash }],
    commentProofs: [],
    roles: [],
    audits: ['22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333'].map((
      auditId,
    ) => ({
      id: auditId,
      actorHash: hash,
      type: 'POST',
      targetId: id,
      reasonHash: hash,
      rowHash: hash,
      action: 'HIDE',
    })),
  }
}

const sql = `${t12SnapshotSql(await readT12Compatibility())};\n`
assert.equal(sha256(sql), t12RecoverySqlHash)
async function fixture() {
  const root = pathToFileURL((await mkdtemp(join(tmpdir(), 'theou-r4-'))) + '/')
  const incident = new URL(t12ReadOnlyIncident.path, root)
  await mkdir(new URL('./', incident), { recursive: true })
  await mkdir(new URL('t11-moderation/', root))
  for (let i = 0; i < 19; i++) {
    await writeFile(new URL(`t11-moderation/${i}.txt`, root), 'synthetic retained file')
  }
  const projectProof = digest({ projectVerified: true })
  const original = JSON.stringify({
    version: 1,
    projectRef: t04ProjectRef,
    status: 'UNCERTAIN',
    uncertain: true,
    baseline: null,
    events: [
      { stage: 'PROJECT', phase: 'INTENT', proof: sha256('PROJECT') },
      { stage: 'PROJECT', phase: 'ACK', proof: projectProof },
      { stage: 'PROJECT', phase: 'VERIFIED', proof: projectProof },
      { stage: 'BEFORE', phase: 'INTENT', proof: sha256('BEFORE') },
    ],
  })
  assert.equal(sha256(original), t12ReadOnlyIncident.hash)
  await writeFile(incident, original)
  const directory = new URL(`t12-recovery/${t12ReadOnlyIncident.runId}/`, root)
  const expected = snapshot(), sourceHash = sha256('synthetic reviewed source')
  const calls: string[] = []
  let clock = Date.parse('2026-11-19T00:00:00Z'), evidenceHash = '', receiptHash = ''
  const control = {
    sourceHash,
    proof: () =>
      Promise.resolve<unknown>({
        snapshot: structuredClone(expected),
        compatibility: true,
        existingAuthEligible: true,
      }),
    failWrite: '',
    failAfterWrite: '',
    failInit: false,
    project: () => Promise.resolve(),
  }
  const deps = {
    root,
    sources: () => Promise.resolve({ sourceHash: control.sourceHash, sql }),
    expected: () => Promise.resolve(structuredClone(expected)),
    now: () => clock,
    async write(file: URL, data: unknown) {
      const name = file.pathname.split('/').at(-1)
      if (name === control.failWrite) throw new Error('synthetic private I/O detail')
      await createT12RecoveryFile(file, data)
      if (name === control.failAfterWrite) throw new Error('synthetic private I/O detail')
    },
    cli() {
      if (control.failInit) throw new Error('synthetic private CLI detail')
      return Promise.resolve({
        async project() {
          calls.push('PROJECT')
          await control.project()
        },
        async snapshot() {
          calls.push('SQL')
          return await control.proof()
        },
      })
    },
  }
  const env = (mode: RecoveryMode): NodeJS.ProcessEnv => ({
    THEOU_ALLOW_T12_PREFLIGHT: 'theou-dev',
    THEOU_AUTH_SUPABASE_URL: t12Origin,
    [`THEOU_ALLOW_T12_RECOVERY_${mode.toUpperCase()}`]: 'theou-dev',
    THEOU_T12_RECOVERY_OWNER_REVIEW: 'approved',
    THEOU_T12_RECOVERY_SOURCE_SHA256: sourceHash,
    THEOU_T12_RECOVERY_APPROVAL_REF: `T12-R4-${mode.toUpperCase()}-SYNTHETIC`,
    THEOU_T12_RECOVERY_EVIDENCE_SHA256: evidenceHash,
    THEOU_T12_RECOVERY_RECEIPT_SHA256: receiptHash,
  })
  const run = async (mode: RecoveryMode, patch: NodeJS.ProcessEnv = {}) => {
    const result = await runT12Recovery(mode, { ...env(mode), ...patch }, t04ProjectRef, deps)
    if (mode === 'evidence') evidenceHash = result.artifactHash
    if (mode === 'resolve') receiptHash = result.artifactHash
    return result
  }
  const ready = async () => {
    await run('evidence')
    await run('resolve')
  }
  return {
    root,
    directory,
    incident,
    original,
    expected,
    calls,
    control,
    deps,
    env,
    run,
    ready,
    advance: () => {
      clock += 31 * 60_000
    },
  }
}

test('R4 exact incident, separate approvals, new follow-up journal and unchanged default guard', async () => {
  const f = await fixture()
  await verifyT12ReadOnlyIncident(f.root)
  await assert.rejects(() => assertNoT12Incidents(f.root), /UNKNOWN_MUTATION/)
  await f.ready()
  const result = await f.run('followup')
  assert.notEqual(result.runId, t12ReadOnlyIncident.runId)
  assert.deepEqual(f.calls, ['PROJECT', 'SQL', 'PROJECT', 'SQL', 'SQL'])
  const journal = JSON.parse(
    await readFile(new URL(`t12-e2e/${result.runId}/preflight.journal.json`, f.root), 'utf8'),
  )
  assert.equal(journal.status, 'PREFLIGHT_COMPLETE')
  assert.equal(journal.uncertain, false)
  assert.deepEqual(journal.baseline, f.expected)
  assert.equal(journal.events.length, 9)
  assert.equal(await readFile(f.incident, 'utf8'), f.original)
  await assert.rejects(() => f.run('followup'), /INCOMPLETE_OR_CONSUMED/)
  await assert.rejects(() => assertNoT12Incidents(f.root), /UNKNOWN_MUTATION/)
})

test('R4 approval/config/project/source mismatches stop before network or receipt', async (t) => {
  for (
    const patch of [
      { THEOU_ALLOW_T12_RECOVERY_EVIDENCE: '' },
      { THEOU_T12_RECOVERY_OWNER_REVIEW: '' },
      { THEOU_ALLOW_T12_PREFLIGHT: '' },
      { THEOU_AUTH_SUPABASE_URL: 'https://invalid.example' },
      { THEOU_ALLOW_T12_AUTH: 'theou-dev' },
      { THEOU_ALLOW_T12_FIXTURES: 'theou-dev' },
      { THEOU_ALLOW_T12_MODERATION: 'theou-dev' },
      { THEOU_ALLOW_T12_ROLE_REVIEW: 'theou-dev' },
      { THEOU_ALLOW_T11_FIXTURE_WRITES: 'theou-dev' },
      { THEOU_T11_SMOKE_RECOVERY_RUN_ID: 'x' },
      { THEOU_ALLOW_T12_RECOVERY_FOLLOWUP: 'theou-dev' },
      { THEOU_T12_RECOVERY_APPROVAL_REF: 'person@example.test' },
      { THEOU_T12_RECOVERY_SOURCE_SHA256: '0'.repeat(64) },
    ]
  ) {
    await t.test(Object.keys(patch)[0], async () => {
      const f = await fixture()
      await assert.rejects(() => f.run('evidence', patch))
      assert.equal(f.calls.length, 0)
      await assert.rejects(() => readdir(f.directory), { code: 'ENOENT' })
    })
  }
  const f = await fixture()
  assert.throws(() => readT12RecoveryApproval('evidence', f.env('evidence'), 'wrong'))
})

test('R4 missing/changed/extra incident, partial journal and lock reject before network', async (t) => {
  for (const kind of ['missing', 'bytes', 'project', 'events', 'extra-run', 'extra-file', 'lock']) {
    await t.test(kind, async () => {
      const f = await fixture()
      if (kind === 'missing') await unlink(f.incident)
      if (kind === 'bytes') await writeFile(f.incident, f.original + '\n')
      if (kind === 'project' || kind === 'events') {
        const j = JSON.parse(f.original)
        if (kind === 'project') j.projectRef = 'wrong'
        else j.events.pop()
        await writeFile(f.incident, JSON.stringify(j))
      }
      if (kind === 'extra-run') await mkdir(new URL('t12-e2e/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/', f.root))
      if (kind === 'extra-file') await writeFile(new URL('preflight.journal.next', f.incident), 'partial')
      if (kind === 'lock') await writeFile(new URL('t11-moderation/theou-dev.lock', f.root), 'other runner')
      await assert.rejects(() => f.run('evidence'))
      assert.equal(f.calls.length, 0)
    })
  }
})

test('R4 full proof required, every security/Auth/role/audit/protected/partial failure blocks resolution', async (t) => {
  const mutations: [string, (proof: ReturnType<typeof fullProof>) => unknown][] = [
    ['partial counts', () => ({ roleCount: 0, auditCount: 2 })],
    ['compatibility', (p) => ({ ...p, compatibility: false })],
    ['Auth', (p) => ({ ...p, existingAuthEligible: false })],
    ['extra private key', (p) => ({ ...p, secret: 'SYNTHETIC_SECRET_SENTINEL' })],
    ['protected same-count drift', (p) => {
      p.snapshot.business.posts[0].rowHash = 'a'.repeat(32)
      return p
    }],
    ['readOnly', (p) => {
      p.snapshot.business.readOnly = 'off' as 'on'
      return p
    }],
    ['security', (p) => {
      p.snapshot.security = false
      return p
    }],
    ['role', (p) => {
      p.snapshot.business.counts.roles = 1
      p.snapshot.roles.push({ actorHash: hash, role: 'ADMIN', rowHash: hash })
      return p
    }],
    ['audit', (p) => {
      p.snapshot.business.counts.moderation = 1
      p.snapshot.audits.pop()
      return p
    }],
    ['null', () => null],
  ]
  function fullProof() {
    return { snapshot: snapshot(), compatibility: true, existingAuthEligible: true }
  }
  for (const [name, mutate] of mutations) {
    await t.test(name, async () => {
      const f = await fixture()
      f.control.proof = () => Promise.resolve(mutate(fullProof()))
      await assert.rejects(() => f.run('evidence'))
      assert.deepEqual(f.calls, ['PROJECT', 'SQL'])
      await assert.rejects(() => f.run('resolve'))
      await assert.rejects(() => f.run('evidence'))
      const ack = await readFile(new URL('sql-ack.json', f.directory), 'utf8')
      assert.doesNotMatch(ack, /SYNTHETIC_SECRET_SENTINEL|snapshot|authorHash/)
    })
  }
})

test('R4 timeout/project failure and unknown response have no retry or resolution', async (t) => {
  for (const phase of ['PROJECT', 'SQL']) {
    await t.test(phase, async () => {
      const f = await fixture()
      const fail = () => Promise.reject(new Error('SYNTHETIC_TOKEN_TIMEOUT'))
      if (phase === 'PROJECT') f.control.project = fail
      else f.control.proof = fail
      await assert.rejects(() => f.run('evidence'))
      const before = [...f.calls]
      await assert.rejects(() => f.run('evidence'))
      await assert.rejects(() => f.run('resolve'))
      assert.deepEqual(f.calls, before)
      for (const name of await readdir(f.directory)) {
        assert.doesNotMatch(await readFile(new URL(name, f.directory), 'utf8'), /SYNTHETIC_TOKEN_TIMEOUT/)
      }
    })
  }
})

test('R4 durable exclusive artifacts: I/O before INTENT/ACK prevents next network operation', async (t) => {
  for (
    const [name, count] of [['attempt.json', 0], ['project-ack.json', 1], ['sql-intent.json', 1], [
      'sql-ack.json',
      2,
    ], ['evidence.json', 2]] as const
  ) {
    await t.test(name, async () => {
      const f = await fixture()
      f.control.failWrite = name
      await assert.rejects(() => f.run('evidence'))
      assert.equal(f.calls.length, count)
      f.control.failWrite = ''
      await assert.rejects(() => f.run('evidence'))
      await assert.rejects(() => f.run('resolve'))
      assert.equal(f.calls.length, count)
    })
  }
  const f = await fixture(), file = new URL('exclusive.json', f.root)
  await createT12RecoveryFile(file, { synthetic: true })
  const bytes = await readFile(file)
  await assert.rejects(() => createT12RecoveryFile(file, { synthetic: false }), { code: 'EEXIST' })
  assert.deepEqual(await readFile(file), bytes)
})

test('R4 evidence/receipt approval hash mismatch, missing evidence, checksum and chain drift reject', async (t) => {
  for (const kind of ['approval', 'missing', 'checksum', 'chain', 'extra', 'expired', 'source']) {
    await t.test(kind, async () => {
      const f = await fixture()
      await f.run('evidence')
      if (kind === 'missing') {
        await unlink(new URL('sql-ack.json', f.directory))
      }
      if (kind === 'checksum') await writeFile(new URL('evidence.json', f.directory), '{}')
      if (kind === 'chain') {
        await unlink(new URL('project-ack.json', f.directory))
        await createT12RecoveryFile(new URL('project-ack.json', f.directory), {
          attemptHash: '0'.repeat(64),
          projectVerified: true,
        })
      }
      if (kind === 'extra') await writeFile(new URL('unreviewed.json', f.directory), '{}')
      if (kind === 'expired') f.advance()
      if (kind === 'source') f.control.sourceHash = '0'.repeat(64)
      await assert.rejects(() =>
        f.run('resolve', kind === 'approval' ? { THEOU_T12_RECOVERY_EVIDENCE_SHA256: '0'.repeat(64) } : {})
      )
      assert.equal(f.calls.length, 2)
      await assert.rejects(() => readFile(new URL('resolution.json', f.directory)), { code: 'ENOENT' })
    })
  }
})

test('R4 altered/missing/reused receipt cannot trigger follow-up; second resolve also blocked', async (t) => {
  for (const kind of ['approval', 'missing', 'checksum', 'valid-checksum-drift', 'expired']) {
    await t.test(kind, async () => {
      const f = await fixture()
      await f.ready()
      const receipt = new URL('resolution.json', f.directory)
      if (kind === 'missing') {
        await unlink(receipt)
      }
      if (kind === 'checksum') await writeFile(receipt, '{}')
      if (kind === 'valid-checksum-drift') {
        const { data } = JSON.parse(await readFile(receipt, 'utf8'))
        data.provenance = 'FABRICATED_ORIGINAL_HTTP_PROOF'
        await unlink(receipt)
        await createT12RecoveryFile(receipt, data)
      }
      if (kind === 'expired') f.advance()
      await assert.rejects(() =>
        f.run('followup', kind === 'approval' ? { THEOU_T12_RECOVERY_RECEIPT_SHA256: '0'.repeat(64) } : {})
      )
      await assert.rejects(() => f.run('resolve'))
      assert.equal(f.calls.length, 2)
    })
  }
})

test('R4 claim before CLI/network survives crash and post-write I/O failure; never replay', async (t) => {
  for (const kind of ['claim-before-write', 'claim-after-write', 'after-claim-crash']) {
    await t.test(kind, async () => {
      const f = await fixture()
      await f.ready()
      if (kind === 'claim-before-write') {
        f.control.failWrite = 'consumption.json'
      }
      if (kind === 'claim-after-write') f.control.failAfterWrite = 'consumption.json'
      if (kind === 'after-claim-crash') f.control.failInit = true
      await assert.rejects(() => f.run('followup'))
      assert.equal(f.calls.length, 2)
      f.control.failWrite = ''
      f.control.failAfterWrite = ''
      f.control.failInit = false
      if (kind !== 'claim-before-write') {
        await assert.rejects(() => f.run('followup'))
        assert.equal(f.calls.length, 2)
      }
    })
  }
})

test('R4 follow-up BEFORE/AFTER drift or timeout leaves new UNCERTAIN and consumed receipt', async (t) => {
  for (const phase of ['BEFORE', 'AFTER']) {
    for (const fault of ['drift', 'timeout']) {
      await t.test(`${phase}/${fault}`, async () => {
        const f = await fixture()
        await f.ready()
        let reads = 0
        f.control.proof = () => {
          reads++
          const p = { snapshot: structuredClone(f.expected), compatibility: true, existingAuthEligible: true }
          if (reads === (phase === 'BEFORE' ? 1 : 2)) {
            if (fault === 'timeout') return Promise.reject(new Error('synthetic unknown response'))
            p.snapshot.storageHash = 'b'.repeat(32)
          }
          return Promise.resolve(p)
        }
        await assert.rejects(() => f.run('followup'))
        const { data: claim } = JSON.parse(await readFile(new URL('consumption.json', f.directory), 'utf8'))
        const journal = JSON.parse(
          await readFile(new URL(`t12-e2e/${claim.runId}/preflight.journal.json`, f.root), 'utf8'),
        )
        assert.equal(journal.status, 'UNCERTAIN')
        assert.equal(journal.uncertain, true)
        assert.equal(journal.events.at(-1).phase, 'INTENT')
        const before = [...f.calls]
        await assert.rejects(() => f.run('followup'))
        assert.deepEqual(f.calls, before)
        assert.equal(await readFile(f.incident, 'utf8'), f.original)
      })
    }
  }
})

test('R4 concurrent attempts: shared project lock allows one evidence acquisition and one consumption', async () => {
  const f = await fixture()
  const first = await Promise.allSettled([f.run('evidence'), f.run('evidence')])
  assert.equal(first.filter((r) => r.status === 'fulfilled').length, 1)
  assert.deepEqual(f.calls, ['PROJECT', 'SQL'])
  await f.run('resolve')
  const second = await Promise.allSettled([f.run('followup'), f.run('followup')])
  assert.equal(second.filter((r) => r.status === 'fulfilled').length, 1)
  assert.deepEqual(f.calls, ['PROJECT', 'SQL', 'PROJECT', 'SQL', 'SQL'])
})

test('R4 metadata only, provenance honest, no full snapshot/private response persisted in sidecars', async () => {
  const f = await fixture()
  await f.ready()
  for (const name of await readdir(f.directory)) {
    const body = await readFile(new URL(name, f.directory), 'utf8')
    assert.doesNotMatch(
      body,
      /authorHash|targetId|bodyHash|"snapshot"|email|password|access_token|refresh_token|signedUrl|@/,
    )
    assert.ok(!body.includes(id))
  }
  const receipt = await readFile(new URL('resolution.json', f.directory), 'utf8')
  assert.match(receipt, /ORIGINAL_HTTP_TRACE_AND_FULL_PROOF_NOT_PERSISTED/)
  assert.equal(await readFile(f.incident, 'utf8'), f.original)
})

test('R4 journal ACK I/O failure stops follow-up, preserves pending INTENT and one-use claim', async () => {
  const f = await fixture()
  await f.ready()
  f.control.project = async () => {
    const { data } = JSON.parse(await readFile(new URL('consumption.json', f.directory), 'utf8'))
    await writeFile(new URL(`t12-e2e/${data.runId}/preflight.journal.next`, f.root), 'synthetic failed I/O')
  }
  await assert.rejects(() => f.run('followup'))
  assert.deepEqual(f.calls, ['PROJECT', 'SQL', 'PROJECT'])
  const { data } = JSON.parse(await readFile(new URL('consumption.json', f.directory), 'utf8'))
  const journal = JSON.parse(
    await readFile(new URL(`t12-e2e/${data.runId}/preflight.journal.json`, f.root), 'utf8'),
  )
  assert.equal(journal.events.at(-1).phase, 'INTENT')
  assert.equal(journal.uncertain, true)
  await assert.rejects(() => f.run('followup'))
  assert.deepEqual(f.calls, ['PROJECT', 'SQL', 'PROJECT'])
})

test('R4 resolution INTENT prevents regenerating receipt after I/O failure or deletion', async () => {
  const f = await fixture()
  await f.run('evidence')
  f.control.failWrite = 'resolution.json'
  await assert.rejects(() => f.run('resolve'))
  f.control.failWrite = ''
  await assert.rejects(() => f.run('resolve'))
  await assert.rejects(() => f.run('followup'))
  assert.equal(f.calls.length, 2)
})

test('R4 in-flight source/evidence drift and unrelated unresolved incident stop the next request', async (t) => {
  for (const kind of ['source', 'evidence', 'extra-incident']) {
    await t.test(kind, async () => {
      const f = await fixture()
      f.control.project = async () => {
        if (kind === 'source') f.control.sourceHash = 'f'.repeat(64)
        if (kind === 'evidence') {
          await writeFile(new URL('attempt.json', f.directory), 'altered')
        }
        if (kind === 'extra-incident') {
          await mkdir(new URL('another-phase/', f.root))
          await writeFile(
            new URL('another-phase/incident.journal.json', f.root),
            JSON.stringify({ uncertain: true }),
          )
        }
      }
      await assert.rejects(() => f.run('evidence'))
      assert.deepEqual(f.calls, ['PROJECT'])
      await assert.rejects(() => f.run('resolve'))
    })
  }
})
