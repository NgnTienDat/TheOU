import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'
import { authenticate } from '../functions/social-api/shared/authentication.ts'
import {
  assembleFinalRevoke,
  assertFinalModerationReview,
  finalRevokeVerification,
} from '../scripts/t11-final-revoke-review.ts'
import {
  adminGrantVerification,
  adminUuidPlaceholder,
  assembleAdminGrant,
  emergencyAdminRevoke,
  readyJournalPlaceholder,
  roleFingerprintPlaceholder,
} from '../scripts/t11-admin-grant-review.ts'
import { a, b, postFixture, serverKey } from './helpers/post-fixture.ts'
import { t04ProjectRef } from '../scripts/t04-cloud-recovery.ts'
import { identityHash } from '../scripts/t09-cloud-inventory.ts'
import { type CliExecute } from '../scripts/t08-cloud-cli.ts'
import { createT11Cli } from '../scripts/t11-cloud-cli.ts'
import { verifyT11Feed } from '../scripts/t11-cloud-feed.ts'
import {
  assertModerationGrantSnapshot,
  assertReadyModerationFixture,
  createModerationGateStore,
  readReadyModerationEvidence,
} from '../scripts/t11-moderation-gate.ts'
import {
  assertRecoverySnapshot,
  assertReviewableSmoke,
  createReviewedIncidentStore,
  createSmokeRecoveryStore,
  failedSmokeAnchor,
  readReviewedSmokeIncident,
  type ReviewedSmokeIncident,
  reviewFailedSmoke,
  smokeArtifactSuffixes,
  type SmokeReviewAnchor,
} from '../scripts/t11-cloud-recovery.ts'
import {
  analyzeHideResults,
  guardT11Fetch,
  type ModerationNetworkScope,
  readT11Config,
  requestHash,
  runT11Cloud,
} from '../scripts/t11-cloud-runner.ts'
import {
  assertModerationScope,
  fileModerationStore,
  type ModerationJournal,
  type ModerationSnapshot,
  moderationSnapshotSql,
  type ModerationStore,
  moderationVerificationSql,
  parseModerationSnapshot,
  retainedMediaPost,
  roleReviewSql,
  validateModerationJournal,
} from '../scripts/t11-cloud-inventory.ts'

const env = {
  THEOU_ALLOW_AUTH_TESTS: 'theou-dev',
  THEOU_AUTH_SUPABASE_URL: `https://${t04ProjectRef}.supabase.co`,
  THEOU_AUTH_PUBLISHABLE_KEY: 'sb_publishable_offline',
  THEOU_T06_EMAIL_A: 'offline-a@ou.edu.vn',
  THEOU_T06_EMAIL_B: 'offline-b@ou.edu.vn',
  THEOU_T06_PASSWORD_A: 'offline password A',
  THEOU_T06_PASSWORD_B: 'offline password B',
  THEOU_ALLOW_T11_FIXTURE_WRITES: 'theou-dev',
  THEOU_ALLOW_T11_MODERATION_WRITES: 'theou-dev',
  THEOU_T11_RETAIN_FIXTURES: 'approved',
  THEOU_T11_ADMIN_ACTOR: 'B',
  THEOU_T11_APPROVED_ADMIN_HASH: identityHash(b),
}
const token = (id: string) => `eyJhbGciOiJFUzI1NiJ9.${btoa(id)}.offline`
type Engine = Awaited<ReturnType<typeof postFixture>>
interface Faults {
  oldPosts?: boolean
  dropFeedPost?: boolean
  invalidFeedDto?: boolean
  storageFailure?: boolean
  intentIo?: boolean
  ackIo?: boolean
  timeout?: boolean
  drift?: boolean
  project?: boolean
}
async function harness(f: Engine, faults: Faults = {}) {
  await f.db.exec('rollback')
  await f.reset()
  await f.db.exec(`reset role;
    create schema if not exists storage;create schema if not exists supabase_migrations;
    create table if not exists storage.buckets(id text primary key,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create table if not exists storage.objects(name text primary key,bucket_id text,metadata jsonb);
    alter table storage.objects enable row level security;
    create table if not exists supabase_migrations.schema_migrations(version text primary key);
    truncate storage.objects,storage.buckets,supabase_migrations.schema_migrations,public.moderation_actions;
    insert into storage.buckets values('post-media',false,2097152,array['image/jpeg','image/png','image/webp']);
    insert into supabase_migrations.schema_migrations values('20261118092925');set role service_role;`)
  const time = faults.oldPosts ? new Date(Date.now() - 172_800_000).toISOString() : undefined
  const parent = await f.seed({ time })
  await f.seed({ author: b, time })
  await f.seed({ id: retainedMediaPost, status: 'DRAFT' })
  for (const position of [1, 2]) {
    const id = randomUUID()
    await f.db.query(
      "insert into post_images(id,post_id,storage_path,mime_type,size_bytes,position) values($1,$2,$3,'image/png',74,$4)",
      [id, retainedMediaPost, `posts/${retainedMediaPost}/${id}.png`, position],
    )
    await f.db.query("update post_images set status='READY' where id=$1", [id])
    await f.db.exec('reset role')
    await f.db.query("insert into storage.objects values($1,'post-media',$2)", [
      `posts/${retainedMediaPost}/${id}.png`,
      { size: 74, mimetype: 'image/png' },
    ])
    await f.db.exec('set role service_role')
  }
  await f.db.query("update posts set status='PUBLISHED' where id=$1", [retainedMediaPost])
  await f.db.query(
    "insert into comments(post_id,author_id,body,idempotency_key) values($1,$2,'protected OP',$3),($1,$4,'protected visible',$5),($1,$4,'protected deleted',$6)",
    [parent, a, randomUUID(), b, randomUUID(), randomUUID()],
  )
  await f.db.query("update comments set status='DELETED' where body='protected deleted'")
  if (faults.storageFailure) f.storage.fail = 'readSign'
  let saved: ModerationJournal | undefined, writes = 0, projects = 0, released = false
  const logs: string[] = [], actions: string[] = []
  const feeds: { sort: string; count: number; hasMore: boolean; media: number }[] = []
  async function snapshot() {
    await f.db.exec('reset role;begin read only')
    let value: ModerationSnapshot
    try {
      value = parseModerationSnapshot(
        (await f.db.query<{ snapshot: ModerationSnapshot }>(moderationSnapshotSql)).rows[0].snapshot,
      )
    } finally {
      await f.db.exec('rollback;set role service_role')
    }
    if (faults.drift && writes) value.business.posts.find((p) => p.id === parent)!.rowHash = 'f'.repeat(32)
    return value
  }
  const store: ModerationStore = {
    acquire(_id, resume) {
      if (
        saved && !(resume && saved.status === 'AWAITING_MODERATION_REVIEW' && !saved.uncertain) &&
        saved.status !== 'COMPLETED_SMOKE'
      ) return Promise.reject(new Error('unresolved journal'))
      return Promise.resolve()
    },
    load() {
      assert.ok(saved)
      return Promise.resolve(structuredClone(saved))
    },
    save(j) {
      validateModerationJournal(j)
      if (
        faults.intentIo && j.events.at(-1)?.phase === 'INTENT' ||
        faults.ackIo && j.events.at(-1)?.phase === 'ACK'
      ) return Promise.reject(new Error(env.THEOU_T06_PASSWORD_A))
      saved = structuredClone(j)
      return Promise.resolve()
    },
    release() {
      released = true
      return Promise.resolve()
    },
  }
  const request: typeof fetch = async (input, init) => {
    const url = new URL(String(input)),
      headers = new Headers(init?.headers),
      caller = [a, b].find((id) => headers.get('authorization') === `Bearer ${token(id)}`)
    assert.equal(url.origin, env.THEOU_AUTH_SUPABASE_URL)
    assert.equal(init?.redirect, 'error')
    assert.equal(init?.credentials, 'omit')
    assert.equal(headers.get('apikey'), env.THEOU_AUTH_PUBLISHABLE_KEY)
    if (url.pathname === '/auth/v1/token') {
      const body = JSON.parse(String(init?.body)), id = body.email === env.THEOU_T06_EMAIL_A ? a : b
      return Response.json({
        access_token: token(id),
        refresh_token: 'offline-refresh',
        token_type: 'bearer',
        expires_in: 3600,
        user: { id, email: body.email, email_confirmed_at: '2026-11-01T00:00:00Z' },
      })
    }
    if (url.pathname === '/auth/v1/user') {
      return Response.json({
        id: caller,
        email: caller === a ? env.THEOU_T06_EMAIL_A : env.THEOU_T06_EMAIL_B,
        email_confirmed_at: '2026-11-01T00:00:00Z',
      })
    }
    if (url.pathname === '/auth/v1/logout') return new Response(null, { status: 204 })
    if (url.pathname.startsWith('/rest/')) {
      assert.ok(saved?.uncertain && saved.events.at(-1)?.phase === 'INTENT')
      await f.db.exec('reset role;set role authenticated')
      try {
        const p = JSON.parse(String(init?.body))
        await f.db.query('select public.t11_admin_hide_content($1,$2,$3,$4)', [
          p.p_admin_id,
          p.p_target_type,
          p.p_target_id,
          p.p_reason,
        ])
        assert.fail('RPC must be denied')
      } catch (e) {
        assert.equal((e as { code: string }).code, '42501')
        return Response.json({ code: '42501', message: 'permission denied' }, { status: 403 })
      } finally {
        await f.db.exec('reset role;set role service_role')
      }
    }
    assert.equal(url.pathname, '/functions/v1/social-api')
    const body = JSON.parse(String(init?.body))
    actions.push(body.action)
    if (!['getMe', 'getPost', 'listPosts', 'listComments', '__t04_unknown__'].includes(body.action)) {
      assert.ok(
        saved?.uncertain && saved.events.at(-1)?.phase === 'INTENT',
        'write-ahead INTENT persisted before request',
      )
      writes++
    }
    f.state.now = Date.now()
    const r = await f.handler(
      f.request(
        body.action,
        body.payload,
        caller ?? null,
        headers.has('authorization') ? { authorization: headers.get('authorization')! } : {},
      ),
    )
    if (faults.timeout && body.action === 'createPost') {
      throw new Error(`${token(a)} ${serverKey} ${env.THEOU_T06_PASSWORD_A}`)
    }
    const response = await r.json()
    if (body.action === 'listPosts' && r.status === 200) {
      if (faults.dropFeedPost) {
        response.data.items = response.data.items.filter((p: { id: string }) => p.id !== retainedMediaPost)
      }
      if (faults.invalidFeedDto && response.data.items[0]) response.data.items[0].unexpected = true
    }
    if (body.action === 'listPosts' && r.status === 200) {
      feeds.push({
        sort: body.payload.sort,
        count: response.data.items.length,
        hasMore: response.data.nextCursor !== null,
        media: response.data.items.filter((p: { images: unknown[] }) => p.images.length > 0).length,
      })
    }
    return new Response(
      JSON.stringify(response).replaceAll(
        'https://offline.example.invalid',
        env.THEOU_AUTH_SUPABASE_URL,
      ),
      { status: r.status, headers: r.headers },
    )
  }
  return {
    request,
    snapshot,
    store,
    logs,
    actions,
    feeds,
    faults,
    get saved() {
      return saved!
    },
    get writes() {
      return writes
    },
    get released() {
      return released
    },
    get projects() {
      return projects
    },
    run(
      mode: '--smoke' | '--fixture-write' | '--moderate-write' = '--fixture-write',
      overrides: NodeJS.ProcessEnv = {},
    ) {
      const values = { ...env, ...overrides },
        args = mode === '--moderate-write' ? [mode, saved!.inventory.runId] : [mode]
      return runT11Cloud(
        readT11Config(values, t04ProjectRef, args),
        values,
        () => Promise.reject(new Error('unexpected prompt')),
        store,
        snapshot,
        () => {
          projects++
          if (faults.project) throw new Error('private project')
          return Promise.resolve()
        },
        (line) => logs.push(line),
        request,
      )
    },
  }
}
test('T11 config: exact ref, separate flags, retention/admin review, no arbitrary CLI targets', () => {
  assert.equal(readT11Config(env, t04ProjectRef, []).mode, '--smoke')
  for (
    const [overrides, args] of [
      [{ THEOU_ALLOW_T11_FIXTURE_WRITES: '' }, ['--fixture-write']],
      [{ THEOU_ALLOW_T11_MODERATION_WRITES: '' }, ['--moderate-write', 'a'.repeat(32)]],
      [{ THEOU_T11_RETAIN_FIXTURES: '' }, ['--fixture-write']],
      [{ THEOU_T11_APPROVED_ADMIN_HASH: '' }, ['--moderate-write', 'a'.repeat(32)]],
      [{ THEOU_AUTH_SUPABASE_URL: 'https://other.supabase.co' }, []],
      [{}, ['--moderate-write', '../x']],
      [{}, ['--fixture-write', randomUUID()]],
      [{}, ['--write']],
    ] as [NodeJS.ProcessEnv, string[]][]
  ) assert.throws(() => readT11Config({ ...env, ...overrides }, t04ProjectRef, args))
  assert.throws(() => readT11Config(env, 'other', []))
})

test('T11 R2/R3: pinned smoke recovery, incident closure and separate fixture gate', async (t) => {
  const f = await postFixture()
  const folder = await mkdtemp(join(tmpdir(), 'theou-t11-recovery-'))
  const dir = pathToFileURL(folder + sep)
  const stores: ModerationStore[] = []
  try {
    const h = await harness(f, { dropFeedPost: true })
    await assert.rejects(h.run('--smoke'), /T11_FEED_COUNT/)
    const j = structuredClone(h.saved)
    // Giả lập đúng schema legacy, không đọc artifacts hay dữ liệu Cloud thật trong tests.
    for (const s of [j.inventory.baseline, j.last]) {
      for (const proof of s.postProofs) delete proof.publishedAt
    }
    for (const event of j.events) {
      if (event.phase === 'VERIFIED') event.proof = requestHash(JSON.stringify(j.last))
    }
    const id = j.inventory.runId
    const disk = fileModerationStore(dir)
    stores.push(disk)
    await disk.acquire(id, false)
    await disk.save(j, 'B')
    await disk.release()
    const originals = Object.fromEntries(
      await Promise.all(
        smokeArtifactSuffixes.map(async (
          suffix,
        ) => [suffix, await readFile(join(folder, `${id}.${suffix}`), 'utf8')]),
      ),
    ) as Record<typeof smokeArtifactSuffixes[number], string>
    const anchor: SmokeReviewAnchor = {
      runId: id,
      mode: '--smoke',
      failureCode: 'T11_FEED_COUNT',
      hashes: Object.fromEntries(
        smokeArtifactSuffixes.map((suffix) => [suffix, requestHash(originals[suffix])]),
      ) as SmokeReviewAnchor['hashes'],
    }
    const values = {
      ...env,
      THEOU_ALLOW_T11_FIXTURE_WRITES: '',
      THEOU_ALLOW_T11_MODERATION_WRITES: '',
      THEOU_T11_SMOKE_RECOVERY_RUN_ID: id,
    }
    const config = readT11Config(values, t04ProjectRef, ['--review-failed-smoke', id])
    const logs: string[] = []
    let projects = 0, snapshots = 0
    let fresh = await h.snapshot()
    const cli = {
      project: () => {
        projects++
        return Promise.resolve()
      },
      snapshot: () => {
        snapshots++
        return Promise.resolve(structuredClone(fresh))
      },
    }
    const makeStore = (mode: '--smoke' | '--review-failed-smoke' = '--review-failed-smoke') => {
      const current = readT11Config(values, t04ProjectRef, mode === '--smoke' ? [mode] : [mode, id])
      const store = createSmokeRecoveryStore(current, values, cli, (s) => logs.push(s), dir, anchor)
      stores.push(store)
      return store
    }
    const sidecarPath = join(folder, `${id}.smoke-review.json`)
    await t.test('eligibility rejects business/unknown intent, missing ACK, wrong mode/ref/id/failure and denial proof', () => {
      assertReviewableSmoke(j, anchor)
      const mutations: ((copy: ModerationJournal) => void)[] = [
        (c) => c.events.push({ stage: 'CREATE_POST', phase: 'INTENT', proof: 'a'.repeat(64) }),
        (c) => {
          c.events[2].stage = 'UNKNOWN_MUTATION'
        },
        (c) => {
          c.events.splice(3, 1)
        },
        (c) => {
          c.events[3].proof = requestHash('not a denial')
        },
        (c) => {
          c.events[0].proof = requestHash('unknown snapshot')
        },
        (c) => {
          c.inventory.projectRef = 'wrong' as typeof t04ProjectRef
        },
        (c) => {
          c.inventory.runId = '0'.repeat(32)
        },
      ]
      for (const mutate of mutations) {
        const copy = structuredClone(j)
        mutate(copy)
        assert.throws(() => assertReviewableSmoke(copy, anchor), /T11_/)
      }
      assert.throws(() => assertReviewableSmoke(j, { ...anchor, mode: '--fixture-write' as never }))
      assert.throws(() => assertReviewableSmoke(j, { ...anchor, failureCode: 'UNKNOWN' as never }))
      assert.throws(() => assertReviewableSmoke(j, failedSmokeAnchor))
    })
    await t.test('full fingerprints reject role/audit/protected rows/Storage/profile/count drift', () => {
      assertRecoverySnapshot(j, fresh)
      for (
        const mutate of [
          (s: ModerationSnapshot) => {
            s.business.profileHash = 'a'.repeat(32)
          },
          (s: ModerationSnapshot) => {
            s.business.posts[0].rowHash = 'a'.repeat(32)
          },
          (s: ModerationSnapshot) => {
            s.business.comments[0].rowHash = 'a'.repeat(32)
          },
          (s: ModerationSnapshot) => {
            s.storageHash = 'a'.repeat(32)
          },
          (s: ModerationSnapshot) => {
            s.auxHash = 'a'.repeat(32)
          },
          (s: ModerationSnapshot) => {
            s.roles.push({ actorHash: identityHash(a), role: 'ADMIN', rowHash: 'a'.repeat(32) })
          },
          (s: ModerationSnapshot) => {
            s.business.counts.moderation++
          },
          (s: ModerationSnapshot) => {
            s.business.posts[0].commentCount++
          },
        ]
      ) {
        const copy = structuredClone(fresh)
        mutate(copy)
        assert.throws(() => assertRecoverySnapshot(j, copy), /T11_|T09_/)
      }
    })
    await t.test('exact run approval and empty write flags required; write modes never receive recovery exception', async () => {
      for (
        const extra of [
          { THEOU_T11_SMOKE_RECOVERY_RUN_ID: '' },
          { THEOU_T11_SMOKE_RECOVERY_RUN_ID: '0'.repeat(32) },
          { THEOU_ALLOW_T11_FIXTURE_WRITES: 'theou-dev' },
          { THEOU_ALLOW_T11_MODERATION_WRITES: 'theou-dev' },
        ]
      ) assert.throws(() => readT11Config({ ...values, ...extra }, t04ProjectRef, [config.mode, id]))
      for (const mode of ['--fixture-write', '--moderate-write']) {
        assert.throws(() =>
          readT11Config(
            { ...env, THEOU_T11_SMOKE_RECOVERY_RUN_ID: id },
            t04ProjectRef,
            mode === '--moderate-write' ? [mode, id] : [mode],
          )
        )
        const store = makeStore('--smoke')
        await assert.rejects(store.acquire('e'.repeat(32), false, mode), /T11_RECOVERY_SMOKE_ONLY/)
      }
      await assert.rejects(
        runT11Cloud(
          config,
          values,
          () => Promise.resolve('unexpected'),
          makeStore(),
          cli.snapshot,
          cli.project,
          () => {},
        ),
        /T11_REVIEW_REQUIRES_READ_ONLY_DISPATCH/,
      )
    })
    await t.test('lock, other unresolved run, artifact/journal tampering and SQL failure never create a sidecar', async () => {
      await writeFile(join(folder, 'theou-dev.lock'), 'offline process')
      await assert.rejects(reviewFailedSmoke(config, makeStore()), /T11_LOCAL_SCOPE_LOCK/)
      assert.equal(await readFile(join(folder, 'theou-dev.lock'), 'utf8'), 'offline process')
      await unlink(join(folder, 'theou-dev.lock'))
      const otherId = 'f'.repeat(32)
      const other = structuredClone(j)
      other.inventory.runId = otherId
      await writeFile(join(folder, `${otherId}.journal.json`), JSON.stringify(other))
      await writeFile(join(folder, `${otherId}.json`), JSON.stringify(other.inventory))
      await assert.rejects(reviewFailedSmoke(config, makeStore()), /T11_UNRESOLVED_JOURNAL/)
      await unlink(join(folder, `${otherId}.journal.json`))
      await unlink(join(folder, `${otherId}.json`))
      for (const suffix of smokeArtifactSuffixes) {
        await writeFile(join(folder, `${id}.${suffix}`), originals[suffix] + '\n')
        await assert.rejects(reviewFailedSmoke(config, makeStore()), /T11_RECOVERY_ARTIFACT_SHA/)
        await writeFile(join(folder, `${id}.${suffix}`), originals[suffix])
      }
      assert.equal(projects, 0)
      const baseline = fresh
      fresh = structuredClone(fresh)
      fresh.business.posts[0].rowHash = 'b'.repeat(32)
      await assert.rejects(reviewFailedSmoke(config, makeStore()), /T11_RECOVERY_FRESH_FINGERPRINT_DRIFT/)
      fresh = baseline
      const broken = createSmokeRecoveryStore(
        config,
        values,
        {
          project: cli.project,
          snapshot: () => Promise.reject(new Error('offline SQL failure')),
        },
        () => {},
        dir,
        anchor,
      )
      stores.push(broken)
      await assert.rejects(reviewFailedSmoke(config, broken), /offline SQL failure/)
      await assert.rejects(readFile(sidecarPath), { code: 'ENOENT' })
    })
    await t.test('review runs fresh SQL without Auth; atomic sidecar has no private records and cannot overwrite', async () => {
      const beforeActions = [...h.actions], before = await h.snapshot()
      const store = makeStore()
      await reviewFailedSmoke(config, store)
      assert.ok(projects > 0 && snapshots > 0)
      assert.deepEqual(h.actions, beforeActions)
      assert.deepEqual(await h.snapshot(), before)
      const text = await readFile(sidecarPath, 'utf8'), sidecar = JSON.parse(text)
      assert.equal(sidecar.status, 'REVIEWED_NO_BUSINESS_WRITES')
      assert.equal(sidecar.originalMode, '--smoke')
      assert.deepEqual(sidecar.originalChecksums, anchor.hashes)
      for (
        const secret of [
          a,
          b,
          token(a),
          env.THEOU_T06_EMAIL_A,
          env.THEOU_T06_PASSWORD_A,
          serverKey,
          'protected OP',
          'storage_path',
          'signedUrl',
        ]
      ) assert.ok(!text.includes(secret))
      await assert.rejects(reviewFailedSmoke(config, makeStore()), /T11_RECOVERY_SIDECAR_EXISTS/)
      assert.equal(await readFile(sidecarPath, 'utf8'), text)
      await assert.rejects(store.save(j, 'B'), /T11_RECOVERY_ORIGINAL_IMMUTABLE/)
    })
    await t.test('invalid/missing sidecar, later drift or changed artifacts block smoke before login', async () => {
      const text = await readFile(sidecarPath, 'utf8')
      for (
        const change of [
          (s: Record<string, unknown>) => {
            s.status = 'approved'
          },
          (s: Record<string, unknown>) => {
            s.originalRunId = 'e'.repeat(32)
          },
          (s: Record<string, unknown>) => {
            s.decision = 'WRITE_APPROVED'
          },
          (s: Record<string, unknown>) => {
            s.originalChecksums = {}
          },
          (s: Record<string, unknown>) => {
            s.extra = 'unknown'
          },
          (s: Record<string, unknown>) => {
            s.reviewedAt = 'invalid'
          },
        ]
      ) {
        const sidecar = JSON.parse(text)
        change(sidecar)
        await writeFile(sidecarPath, JSON.stringify(sidecar))
        const retry = makeStore('--smoke')
        await assert.rejects(retry.acquire('e'.repeat(32), false, '--smoke'), /T11_RECOVERY_INVALID_SIDECAR/)
        await retry.release()
      }
      await unlink(sidecarPath)
      const missing = makeStore('--smoke')
      await assert.rejects(missing.acquire('e'.repeat(32), false, '--smoke'), { code: 'ENOENT' })
      await missing.release()
      await writeFile(sidecarPath, text)
      const retry = makeStore('--smoke')
      await retry.acquire('e'.repeat(32), false, '--smoke')
      const drift = structuredClone(fresh)
      drift.business.profileHash = 'b'.repeat(32)
      await assert.rejects(retry.verifyRecoverySnapshot!(drift), /T11_RECOVERY_FRESH_FINGERPRINT_DRIFT/)
      await writeFile(join(folder, `${id}.verify.sql`), originals['verify.sql'] + '\n')
      await assert.rejects(retry.verifyRecoverySnapshot!(fresh), /T11_RECOVERY_ARTIFACT_SHA/)
      await writeFile(join(folder, `${id}.verify.sql`), originals['verify.sql'])
      await retry.release()
    })
    await t.test('real offline HTTP smoke gets a new journal; original and sidecar bytes retained; write gate remains closed', async () => {
      const sidecar = await readFile(sidecarPath, 'utf8')
      h.faults.dropFeedPost = false
      const retryConfig = readT11Config(values, t04ProjectRef, ['--smoke'])
      const retry = makeStore('--smoke')
      const checkedStore: ModerationStore = {
        ...retry,
        async save(value, actor) {
          await retry.save(value, actor)
          await h.store.save(value, actor)
        },
      }
      await runT11Cloud(
        retryConfig,
        values,
        () => Promise.reject(new Error('unexpected prompt')),
        checkedStore,
        h.snapshot,
        cli.project,
        (s) => logs.push(s),
        h.request,
      )
      const { readdir } = await import('node:fs/promises')
      const names = await readdir(folder)
      const journalName = names.find((n) => n.endsWith('.journal.json') && !n.startsWith(id))!
      assert.ok(journalName)
      const newJournal = JSON.parse(await readFile(join(folder, journalName), 'utf8')) as ModerationJournal
      validateModerationJournal(newJournal)
      assert.equal(newJournal.status, 'COMPLETED_SMOKE')
      assert.equal(newJournal.uncertain, false)
      assert.notEqual(newJournal.inventory.runId, id)
      assert.equal(newJournal.inventory.fixtures.length, 0)
      for (const suffix of smokeArtifactSuffixes) {
        assert.equal(await readFile(join(folder, `${id}.${suffix}`), 'utf8'), originals[suffix])
      }
      assert.equal(await readFile(sidecarPath, 'utf8'), sidecar)
      assertRecoverySnapshot(j, await h.snapshot())
      const blocked = fileModerationStore(dir)
      stores.push(blocked)
      await assert.rejects(
        blocked.acquire('d'.repeat(32), false, '--fixture-write'),
        /T11_UNRESOLVED_JOURNAL/,
      )
      await blocked.release()
    })
    const { readdir } = await import('node:fs/promises')
    const names = await readdir(folder)
    const successId = names.find((n) => n.endsWith('.journal.json') && !n.startsWith(id))!.slice(0, 32)
    const successfulFiles = Object.fromEntries(
      await Promise.all(
        smokeArtifactSuffixes.map(async (
          suffix,
        ) => [suffix, await readFile(join(folder, `${successId}.${suffix}`), 'utf8')]),
      ),
    ) as Record<typeof smokeArtifactSuffixes[number], string>
    const sidecarText = await readFile(sidecarPath, 'utf8')
    const incident: ReviewedSmokeIncident = {
      failed: anchor,
      sidecarHash: requestHash(sidecarText),
      successful: {
        runId: successId,
        hashes: Object.fromEntries(
          smokeArtifactSuffixes.map((suffix) => [suffix, requestHash(successfulFiles[suffix])]),
        ) as SmokeReviewAnchor['hashes'],
      },
    }
    const fixtureEnv = {
      ...values,
      THEOU_T11_SMOKE_RECOVERY_RUN_ID: '',
      THEOU_ALLOW_T11_FIXTURE_WRITES: 'theou-dev',
    }
    const fixtureConfig = readT11Config(fixtureEnv, t04ProjectRef, ['--fixture-write'])
    const gate = () => {
      const store = createReviewedIncidentStore(fixtureConfig, fixtureEnv, (s) => logs.push(s), dir, incident)
      stores.push(store)
      return store
    }
    await t.test('R3 valid reviewed incident closes only its blocker; local evidence read creates no records or artifacts', async () => {
      const actions = [...h.actions], files = await readdir(folder), before = await h.snapshot()
      const evidence = await readReviewedSmokeIncident(dir, incident)
      assert.equal(evidence.failed.status, 'UNCERTAIN')
      assert.equal(evidence.successful.status, 'COMPLETED_SMOKE')
      const store = gate()
      try {
        await store.acquire('a'.repeat(32), false, '--fixture-write')
        const pending = structuredClone(j)
        pending.inventory.runId = 'a'.repeat(32)
        await assert.rejects(store.save(pending, 'B'), /T11_INCIDENT_FRESH_PREFLIGHT_REQUIRED/)
        await store.verifyRecoverySnapshot!(await h.snapshot())
      } finally {
        await store.release()
      }
      assert.deepEqual(h.actions, actions)
      assert.deepEqual(await h.snapshot(), before)
      assert.deepEqual(await readdir(folder), files)
    })
    await t.test('R3 missing/invalid/tampered sidecar fails, even a re-pinned invalid record is rejected by R2 schema', async () => {
      try {
        for (const text of [sidecarText + '\n', '{}']) {
          await writeFile(sidecarPath, text)
          await assert.rejects(readReviewedSmokeIncident(dir, incident), /T11_INCIDENT_SIDECAR_SHA/)
        }
        await assert.rejects(
          readReviewedSmokeIncident(dir, { ...incident, sidecarHash: requestHash('{}') }),
          /T11_RECOVERY_INVALID_SIDECAR/,
        )
        await unlink(sidecarPath)
        await assert.rejects(readReviewedSmokeIncident(dir, incident), { code: 'ENOENT' })
      } finally {
        await writeFile(sidecarPath, sidecarText)
      }
    })
    await t.test('R3 missing successful retry, non-completed retry, pending/unknown/business intent or missing ACK block closure', async () => {
      const path = join(folder, `${successId}.journal.json`)
      await unlink(path)
      await assert.rejects(readReviewedSmokeIncident(dir, incident), { code: 'ENOENT' })
      await writeFile(path, successfulFiles['journal.json'])
      const mutations: ((value: ModerationJournal) => void)[] = [
        (value) => {
          value.status = 'UNCERTAIN'
          value.uncertain = true
        },
        (value) => {
          value.events[2].stage = 'CREATE_POST'
        },
        (value) => {
          value.events[2].stage = 'UNKNOWN_MUTATION'
        },
        (value) => {
          value.events.splice(3, 1)
        },
        (value) => {
          value.events.push({ stage: 'CREATE_COMMENT', phase: 'INTENT', proof: 'a'.repeat(64) })
        },
      ]
      for (const mutate of mutations) {
        const value = JSON.parse(successfulFiles['journal.json']) as ModerationJournal
        mutate(value)
        const text = JSON.stringify(value)
        await writeFile(path, text)
        const changed = structuredClone(incident)
        changed.successful.hashes['journal.json'] = requestHash(text)
        await assert.rejects(readReviewedSmokeIncident(dir, changed), /T11_/)
      }
      await writeFile(path, successfulFiles['journal.json'])
    })
    await t.test('R3 checksum drift in any original/retry artifact or sidecar blocks acquire without touching business data', async () => {
      const actions = [...h.actions], before = await h.snapshot()
      for (const [run, savedFiles] of [[id, originals], [successId, successfulFiles]] as const) {
        for (const suffix of smokeArtifactSuffixes) {
          await writeFile(join(folder, `${run}.${suffix}`), savedFiles[suffix] + '\n')
          const store = gate()
          try {
            await assert.rejects(
              store.acquire('a'.repeat(32), false, '--fixture-write'),
              /T11_RECOVERY_ARTIFACT_SHA/,
            )
          } finally {
            await store.release()
          }
          await writeFile(join(folder, `${run}.${suffix}`), savedFiles[suffix])
        }
      }
      assert.deepEqual(h.actions, actions)
      assert.deepEqual(await h.snapshot(), before)
    })
    await t.test('R3 other unresolved journal or active lock blocks fixture gate and cannot be cleared by closure', async () => {
      await writeFile(join(folder, 'theou-dev.lock'), 'another offline process')
      const locked = gate()
      await assert.rejects(locked.acquire('a'.repeat(32), false, '--fixture-write'), /T11_LOCAL_SCOPE_LOCK/)
      await locked.release()
      assert.equal(await readFile(join(folder, 'theou-dev.lock'), 'utf8'), 'another offline process')
      await unlink(join(folder, 'theou-dev.lock'))
      const other = structuredClone(j), otherId = 'c'.repeat(32)
      other.inventory.runId = otherId
      await writeFile(join(folder, `${otherId}.journal.json`), JSON.stringify(other))
      await writeFile(join(folder, `${otherId}.json`), JSON.stringify(other.inventory))
      const blocked = gate()
      try {
        await assert.rejects(
          blocked.acquire('a'.repeat(32), false, '--fixture-write'),
          /T11_UNRESOLVED_JOURNAL/,
        )
      } finally {
        await blocked.release()
      }
      await unlink(join(folder, `${otherId}.journal.json`))
      await unlink(join(folder, `${otherId}.json`))
    })
    await t.test('R3 separate write/retention/project approvals required; smoke/review/moderate cannot use fixture exception', async () => {
      for (
        const overrides of [
          { THEOU_ALLOW_T11_FIXTURE_WRITES: '' },
          { THEOU_T11_RETAIN_FIXTURES: '' },
          { THEOU_ALLOW_T11_MODERATION_WRITES: 'theou-dev' },
          { THEOU_T11_SMOKE_RECOVERY_RUN_ID: id },
          { THEOU_AUTH_SUPABASE_URL: 'https://another.supabase.co' },
        ]
      ) {
        assert.throws(() =>
          createReviewedIncidentStore(
            fixtureConfig,
            { ...fixtureEnv, ...overrides },
            () => {},
            dir,
            incident,
          ), /T11_|project|TheOU/)
      }
      for (const mode of ['--smoke', '--review-failed-smoke', '--moderate-write']) {
        assert.throws(
          () =>
            createReviewedIncidentStore(
              { ...fixtureConfig, mode: mode as typeof fixtureConfig.mode },
              fixtureEnv,
              () => {},
              dir,
              incident,
            ),
          /T11_INCIDENT_FIXTURE_APPROVAL_ONLY/,
        )
        const store = gate()
        await assert.rejects(store.acquire('a'.repeat(32), false, mode), /T11_RECOVERY_SMOKE_ONLY/)
      }
      const store = gate()
      try {
        await assert.rejects(
          store.acquire(successId, false, '--fixture-write'),
          /T11_RESUME_FILE_OR_RUN_EXISTS/,
        )
      } finally {
        await store.release()
      }
    })
    await t.test('R3 fresh protected/role/audit/Storage drift and artifact change before login block all fixture API requests', async () => {
      for (
        const mutate of [
          (s: ModerationSnapshot) => {
            s.business.posts[0].rowHash = 'b'.repeat(32)
          },
          (s: ModerationSnapshot) => {
            s.business.profileHash = 'b'.repeat(32)
          },
          (s: ModerationSnapshot) => {
            s.storageHash = 'b'.repeat(32)
          },
          (s: ModerationSnapshot) => {
            s.business.counts.moderation++
          },
          (s: ModerationSnapshot) => {
            s.roles.push({ actorHash: identityHash(b), role: 'ADMIN', rowHash: 'b'.repeat(32) })
          },
        ]
      ) {
        const actions = [...h.actions], drift = await h.snapshot()
        mutate(drift)
        await assert.rejects(
          runT11Cloud(
            fixtureConfig,
            fixtureEnv,
            () => Promise.reject(new Error('must not ask credentials')),
            gate(),
            () => Promise.resolve(drift),
            () => Promise.resolve(),
            (s) => logs.push(s),
            h.request,
          ),
          /T11_|T09_/,
        )
        assert.deepEqual(h.actions, actions)
      }
      const store = gate()
      try {
        await store.acquire('a'.repeat(32), false, '--fixture-write')
        await writeFile(sidecarPath, sidecarText + '\n')
        await assert.rejects(store.verifyRecoverySnapshot!(await h.snapshot()), /T11_INCIDENT_SIDECAR_SHA/)
      } finally {
        await store.release()
        await writeFile(sidecarPath, sidecarText)
      }
    })
    await t.test('R3 actual offline fixture runner retains protected evidence, creates a new fixture journal and still cannot open moderation', async () => {
      const store = gate()
      const checkedStore: ModerationStore = {
        ...store,
        async save(value, actor) {
          await store.save(value, actor)
          await h.store.save(value, actor)
        },
      }
      await runT11Cloud(
        fixtureConfig,
        fixtureEnv,
        () => Promise.reject(new Error('unexpected prompt')),
        checkedStore,
        h.snapshot,
        () => Promise.resolve(),
        (s) => logs.push(s),
        h.request,
      )
      assert.equal(h.saved.status, 'AWAITING_MODERATION_REVIEW')
      assert.equal(h.saved.uncertain, false)
      assert.equal(h.saved.inventory.fixtures.length, 8)
      assert.equal(h.saved.audits.length, 0)
      assert.equal(h.saved.roles.length, 0)
      assert.notEqual(h.saved.inventory.runId, id)
      assert.notEqual(h.saved.inventory.runId, successId)
      for (const [run, savedFiles] of [[id, originals], [successId, successfulFiles]] as const) {
        for (const suffix of smokeArtifactSuffixes) {
          assert.equal(await readFile(join(folder, `${run}.${suffix}`), 'utf8'), savedFiles[suffix])
        }
      }
      assert.equal(await readFile(sidecarPath, 'utf8'), sidecarText)
      const moderate = fileModerationStore(dir)
      stores.push(moderate)
      try {
        await assert.rejects(
          moderate.acquire(h.saved.inventory.runId, true, '--moderate-write'),
          /T11_UNRESOLVED_JOURNAL/,
        )
      } finally {
        await moderate.release()
      }
    })
    const fixtureJournal = structuredClone(h.saved), fixtureId = fixtureJournal.inventory.runId
    const fixtureFiles = Object.fromEntries(
      await Promise.all(
        smokeArtifactSuffixes.map(async (
          suffix,
        ) => [suffix, await readFile(join(folder, `${fixtureId}.${suffix}`), 'utf8')]),
      ),
    ) as Record<typeof smokeArtifactSuffixes[number], string>
    const fixtureAnchor = {
      runId: fixtureId,
      hashes: Object.fromEntries(
        smokeArtifactSuffixes.map((suffix) => [suffix, requestHash(fixtureFiles[suffix])]),
      ) as SmokeReviewAnchor['hashes'],
    }
    const precondition = await readFile(
      new URL('../scripts/t11-admin-grant-precondition.sql', import.meta.url),
      'utf8',
    )
    const grant = assembleAdminGrant(fixtureJournal, fixtureFiles['grant-review.sql'], precondition)
    const withActor = (sql: string, actor: string) => sql.replace(adminUuidPlaceholder, () => actor)
    await f.db.exec(
      'reset role;alter table auth.users add column email text;alter table auth.users add column email_confirmed_at timestamptz;alter table auth.users add column is_anonymous boolean default false',
    )
    await f.db.query("update auth.users set email=$1,email_confirmed_at='2026-11-01Z' where id=$2", [
      env.THEOU_T06_EMAIL_A,
      a,
    ])
    await f.db.query("update auth.users set email=$1,email_confirmed_at='2026-11-01Z' where id=$2", [
      env.THEOU_T06_EMAIL_B,
      b,
    ])
    await f.db.exec('set role service_role')
    await t.test('B1 assembled transaction preserves original DO and locks; Auth SQL matches authenticate email rules', async () => {
      const original = fixtureFiles['grant-review.sql']
      assert.equal(grant.match(/^begin;$/gm)?.length, 1)
      assert.equal(grant.match(/^commit;$/gm)?.length, 1)
      assert.equal(grant.match(/insert into public\.user_roles/gi)?.length, 1)
      assert.equal(grant.match(/<EXACT_ACTOR_B_UUID>/g)?.length, 1)
      assert.equal(grant.slice(grant.indexOf('do $review$')), original.slice(original.indexOf('do $review$')))
      const locks = original.match(/lock table[\s\S]*?share row exclusive mode;/)![0]
      assert.ok(grant.includes(locks))
      assert.ok(grant.indexOf(locks) < grant.indexOf('do $auth_review$'))
      assert.ok(grant.indexOf('do $auth_review$') < grant.indexOf('do $review$'))
      assert.throws(() => assembleAdminGrant(fixtureJournal, original + '-- drift', precondition))
      const emails = [
        env.THEOU_T06_EMAIL_B,
        'Student+alias@OU.EDU.VN',
        "a!#$%&'*+/=?^_`{|}~-@ou.edu.vn",
        'a.b@ou.edu.vn',
        'a'.repeat(64) + '@ou.edu.vn',
        '.a@ou.edu.vn',
        'a.@ou.edu.vn',
        'a..b@ou.edu.vn',
        'a@sub.ou.edu.vn',
        'a@ou.edu.vn.invalid',
        'a@ou.edu.vn\n',
        ' a@ou.edu.vn',
        'a b@ou.edu.vn',
        'a'.repeat(65) + '@ou.edu.vn',
        'a'.repeat(255) + '@ou.edu.vn',
        'á@ou.edu.vn',
        'K@ou.edu.vn',
        'ſ@ou.edu.vn',
        'a\\b@ou.edu.vn',
        'a@ou.edu.vn\u00a0',
        '"a"@ou.edu.vn',
        '',
      ]
      await f.db.exec('reset role')
      try {
        for (const email of emails) {
          const createAuth = (() => ({
            auth: {
              getUser: () =>
                Promise.resolve({
                  error: null,
                  data: { user: { id: b, email, email_confirmed_at: '2026-11-01T00:00:00Z' } },
                }),
            },
          })) as unknown as Parameters<typeof authenticate>[1]
          const accepted = await authenticate(
            new Request('https://offline.invalid', { headers: { authorization: 'Bearer a.b.c' } }),
            createAuth,
          ).then(() => true, () => false)
          await f.db.exec('begin')
          try {
            await f.db.query('update auth.users set email=$1 where id=$2', [email, b])
            const sqlAccepted = await f.db.exec(
              `set local theou.t11_admin_id='${b}';\n${precondition}`,
            ).then(() => true, () => false)
            assert.equal(sqlAccepted, accepted, 'Auth SQL/email acceptance parity')
          } finally {
            await f.db.exec('rollback')
          }
        }
      } finally {
        await f.db.exec('set role service_role')
      }
    })
    await t.test('B1 grant rollback covers profile, snapshot, existing role, anonymous and nonfinite confirmation; safe verification detects drift', async () => {
      await f.db.exec('reset role')
      const before = await h.snapshot()
      const inject = (statement: string) =>
        withActor(grant, b).replace(
          'do $auth_review$',
          () => statement + '\ndo $auth_review$',
        )
      for (
        const statement of [
          `update public.profiles set status='BANNED' where id='${b}';`,
          "update public.posts set body=body||' drift';",
          `insert into public.user_roles(user_id,role) values('${b}','ADMIN');`,
          `update auth.users set is_anonymous=true where id='${b}';`,
          `update auth.users set email_confirmed_at='infinity' where id='${b}';`,
        ]
      ) {
        await f.db.exec('reset role')
        await assert.rejects(f.db.exec(inject(statement)))
        await f.db.exec('rollback;set role service_role')
        assert.deepEqual(await h.snapshot(), before)
      }
      await f.db.exec('reset role')
      const verify = async (after: boolean, journal = fixtureJournal) => {
        const results = await f.db.exec(adminGrantVerification(journal, after))
        const rows = results.flatMap((r) => r.rows) as Record<string, unknown>[]
        assert.equal(rows.length, 1)
        assert.deepEqual(Object.keys(rows[0]).sort(), [
          'protected_snapshot_matches',
          'read_only',
          'role_count',
          'role_fingerprint',
          'role_scope_matches',
        ])
        return rows[0]
      }
      assert.equal((await verify(false)).protected_snapshot_matches, true)
      assert.equal((await verify(false)).role_scope_matches, true)
      assert.equal((await verify(true)).role_scope_matches, false)
      const drift = structuredClone(fixtureJournal)
      drift.last.storageHash = 'f'.repeat(32)
      assert.equal((await verify(false, drift)).protected_snapshot_matches, false)
      await f.db.exec('set role service_role')
    })
    await t.test('C3 ready fixture history has exact owners, parents and settled intents; missing ACK, unknown stage and fixture drift fail', async () => {
      assert.equal((await readReadyModerationEvidence(dir, fixtureAnchor, incident)).events.length, 50)
      for (
        const mutate of [
          (value: ModerationJournal) => {
            value.events.splice(3, 1)
          },
          (value: ModerationJournal) => {
            value.events[2].stage = 'UNKNOWN_MUTATION'
          },
          (value: ModerationJournal) => {
            value.events[2].proof = 'f'.repeat(64)
          },
          (value: ModerationJournal) => {
            value.inventory.fixtures[0].status = 'HIDDEN'
          },
          (value: ModerationJournal) => {
            value.inventory.fixtures[5].parent = 'race'
          },
          (value: ModerationJournal) => {
            value.inventory.fixtures[0].owner = 'B'
          },
          (value: ModerationJournal) => {
            value.status = 'UNCERTAIN'
            value.uncertain = true
          },
        ]
      ) {
        const value = structuredClone(fixtureJournal)
        mutate(value)
        assert.throws(() => assertReadyModerationFixture(value), /T11_/)
      }
    })
    await t.test('C3 grant copy requires exact B, confirmed OU Auth and ACTIVE; every denial rolls back without provisioning', async () => {
      const rejectGrant = async (sql: string) => {
        await f.db.exec('reset role')
        try {
          await assert.rejects(f.db.exec(sql))
        } finally {
          await f.db.exec('rollback;set role service_role')
        }
        assert.equal((await h.snapshot()).roles.length, 0)
      }
      await rejectGrant(grant)
      await rejectGrant(withActor(grant, a))
      await f.db.exec('reset role')
      await f.db.query('update auth.users set email_confirmed_at=null where id=$1', [b])
      await rejectGrant(withActor(grant, b))
      await f.db.exec('reset role')
      await f.db.query(
        "update auth.users set email='offline@example.invalid',email_confirmed_at='2026-11-01Z' where id=$1",
        [b],
      )
      await rejectGrant(withActor(grant, b))
      await f.db.exec('reset role')
      await f.db.query('update auth.users set email=$1 where id=$2', [env.THEOU_T06_EMAIL_B, b])
      await f.db.exec('begin')
      try {
        await f.db.query("update public.profiles set status='BANNED' where id=$1", [b])
        await assert.rejects(f.db.exec(`set local theou.t11_admin_id='${b}';\n${precondition}`))
      } finally {
        await f.db.exec('rollback')
      }
      await f.db.exec('set role service_role')
      const before = await h.snapshot()
      await f.db.exec('reset role')
      await f.db.exec(withActor(grant, b))
      const verification = (await f.db.exec(adminGrantVerification(fixtureJournal, true)))
        .flatMap((r) => r.rows) as Record<string, unknown>[]
      assert.equal(verification[0].role_scope_matches, true)
      assert.equal(verification[0].protected_snapshot_matches, true)
      assert.equal(verification[0].read_only, true)
      assert.equal(verification[0].role_count, 1)
      await f.db.exec('set role service_role')
      assert.equal((await h.snapshot()).roles.length, 1)
      await f.db.exec('reset role')
      await assert.rejects(f.db.exec(withActor(grant, b)))
      await f.db.exec('rollback;set role service_role')
      const after = await h.snapshot()
      assert.equal(after.business.profileHash, before.business.profileHash)
      assert.equal(after.business.authHash, before.business.authHash)
      assert.equal(after.roles[0].actorHash, identityHash(b))
      await assert.rejects(
        f.db.query("insert into public.user_roles(user_id,role) values($1,'ADMIN')", [b]),
        (error: { code?: string }) => error.code === '23505',
      )
      await assert.rejects(
        f.db.query("insert into public.user_roles(user_id,role) values($1,'ADMIN')", [randomUUID()]),
        (error: { code?: string }) => error.code === '23503',
      )
    })
    const granted = await h.snapshot()
    const readySha = requestHash(JSON.stringify(fixtureJournal))
    const emergency = emergencyAdminRevoke(fixtureJournal, readySha)
    const approvedRevoke = () =>
      emergency
        .replace(adminUuidPlaceholder, () => b)
        .replace(roleFingerprintPlaceholder, () => granted.business.roleHash)
        .replace(readyJournalPlaceholder, () => readySha)
    const rejectRevoke = async (sql: string) => {
      await f.db.exec('reset role')
      try {
        await assert.rejects(f.db.exec(sql), /T11 emergency revoke/)
      } finally {
        await f.db.exec('rollback;set role service_role')
      }
      assert.deepEqual(await h.snapshot(), granted)
    }
    await t.test('B2 emergency preparation requires settled pre-moderation journal; one transaction and one exact role DELETE', () => {
      assert.equal(emergency.match(/^begin;$/gm)?.length, 1)
      assert.equal(emergency.match(/^commit;$/gm)?.length, 1)
      assert.equal(emergency.match(/delete from public\.user_roles/gi)?.length, 1)
      assert.ok(emergency.includes("where user_id=approved_admin_id and role='ADMIN'"))
      assert.equal(emergency.match(/\b(?:insert into|update|delete from) public\./gi)?.length, 1)
      assert.ok(emergency.includes(grant.match(/lock table[\s\S]*?share row exclusive mode;/)![0]))
      for (
        const mutation of [
          (j: ModerationJournal) => {
            j.status = 'RUNNING'
            j.uncertain = true
          },
          (j: ModerationJournal) => {
            j.events.push({ ...j.events[2] })
          },
          (j: ModerationJournal) => {
            j.events.splice(3, 1)
          },
        ]
      ) {
        const j = structuredClone(fixtureJournal)
        mutation(j)
        assert.throws(() => emergencyAdminRevoke(j, readySha))
      }
      assert.throws(() => emergencyAdminRevoke(fixtureJournal, 'unknown'))
    })
    await t.test('B2 wrong actor, missing/excess/replaced role, role metadata/fingerprint drift and missing review all roll back', async () => {
      await rejectRevoke(approvedRevoke().replace(`t11_admin_id='${b}'`, () => `t11_admin_id='${a}'`))
      await rejectRevoke(approvedRevoke().replace(readySha, () => 'f'.repeat(64)))
      await rejectRevoke(approvedRevoke().replace(granted.business.roleHash, () => 'f'.repeat(32)))
      await rejectRevoke(emergency.replace(adminUuidPlaceholder, () => b))
      for (
        const statement of [
          `delete from public.user_roles where user_id='${b}';`,
          `insert into public.user_roles(user_id,role) values('${a}','ADMIN');`,
          `delete from public.user_roles where user_id='${b}';insert into public.user_roles(user_id,role) values('${a}','ADMIN');`,
          `delete from public.user_roles where user_id='${b}';insert into public.user_roles(user_id,role,created_at) values('${b}','ADMIN',now()-interval '1 day');`,
        ]
      ) {
        await rejectRevoke(
          approvedRevoke().replace('do $emergency_revoke$', () => statement + '\ndo $emergency_revoke$'),
        )
      }
    })
    await t.test('B2 audit/protected drift deny revoke; failure after DELETE restores the original role atomically', async () => {
      const target = fixtureJournal.inventory.fixtures[0].id
      for (
        const statement of [
          `insert into public.moderation_actions(admin_id,target_type,target_id,action,reason) values('${b}','POST','${target}','HIDE','offline audit');`,
          `update public.posts set body=body||' drift' where id='${target}';`,
          `update public.profiles set nickname='OUer-drift' where id='${b}';`,
        ]
      ) {
        await rejectRevoke(
          approvedRevoke().replace('do $emergency_revoke$', () => statement + '\ndo $emergency_revoke$'),
        )
      }
      await rejectRevoke(
        approvedRevoke().replace(
          "if n<>1 then raise exception 'T11 emergency revoke expected exactly one row'; end if;",
          () =>
            `if n<>1 then raise exception 'T11 emergency revoke expected exactly one row'; end if;
          insert into public.user_roles(user_id,role) values('${a}','ADMIN');`,
        ),
      )
    })
    await t.test('B2 valid revoke restores exact pre-grant snapshot; duplicate execution fails without changing business data', async () => {
      await f.db.exec('reset role')
      const role = (await f.db.query<{ created_at: string; granted_by: string | null }>(
        'select created_at::text,granted_by from public.user_roles where user_id=$1',
        [b],
      )).rows[0]
      try {
        await f.db.exec(approvedRevoke())
        assert.deepEqual(await h.snapshot(), fixtureJournal.last)
        await f.db.exec('reset role')
        await assert.rejects(f.db.exec(approvedRevoke()), /role scope or fingerprint drift/)
        await f.db.exec('rollback;set role service_role')
        assert.deepEqual(await h.snapshot(), fixtureJournal.last)
      } finally {
        // Chỉ khôi phục synthetic role để các regression C3 tiếp tục dùng đúng fingerprint cũ.
        await f.db.exec('rollback;reset role')
        if (!(await f.db.query('select 1 from public.user_roles where user_id=$1', [b])).rows.length) {
          await f.db.query(
            "insert into public.user_roles(user_id,role,created_at,granted_by) values($1,'ADMIN',$2,$3)",
            [b, role.created_at, role.granted_by],
          )
        }
        await f.db.exec('set role service_role')
      }
      assert.deepEqual(await h.snapshot(), granted)
    })
    const moderationEnv = {
      ...fixtureEnv,
      THEOU_ALLOW_T11_FIXTURE_WRITES: '',
      THEOU_ALLOW_T11_MODERATION_WRITES: 'theou-dev',
      THEOU_T11_APPROVED_ROLE_FINGERPRINT: granted.business.roleHash,
    }
    const moderationConfig = readT11Config(moderationEnv, t04ProjectRef, ['--moderate-write', fixtureId])
    const moderationGate = () => {
      const store = createModerationGateStore(
        moderationConfig,
        moderationEnv,
        (s) => logs.push(s),
        dir,
        fixtureAnchor,
        incident,
      )
      stores.push(store)
      return store
    }
    await t.test('C3 exact run, B, retention, role fingerprint and separate moderation flag required; other modes cannot borrow exception', async () => {
      for (
        const override of [
          { THEOU_ALLOW_T11_MODERATION_WRITES: '' },
          { THEOU_ALLOW_T11_FIXTURE_WRITES: 'theou-dev' },
          { THEOU_T11_RETAIN_FIXTURES: '' },
          { THEOU_T11_ADMIN_ACTOR: 'A' },
          { THEOU_T11_APPROVED_ROLE_FINGERPRINT: '' },
          { THEOU_AUTH_SUPABASE_URL: 'https://wrong.supabase.co' },
        ]
      ) {
        assert.throws(() =>
          createModerationGateStore(
            moderationConfig,
            { ...moderationEnv, ...override },
            () => {},
            dir,
            fixtureAnchor,
            incident,
          )
        )
      }
      for (
        const config of [
          { ...moderationConfig, runId: id },
          { ...moderationConfig, mode: '--fixture-write' as const },
        ]
      ) {
        assert.throws(() =>
          createModerationGateStore(config, moderationEnv, () => {}, dir, fixtureAnchor, incident)
        )
      }
      const store = moderationGate()
      await assert.rejects(store.acquire(fixtureId, false, '--fixture-write'), /T11_RECOVERY_SMOKE_ONLY/)
    })
    await t.test('C3 only one approved B role delta allowed; full role fingerprint and protected fixture/Storage/audit drift reject', async () => {
      assertModerationGrantSnapshot(
        fixtureJournal,
        granted,
        moderationEnv.THEOU_T11_APPROVED_ROLE_FINGERPRINT,
      )
      for (
        const mutate of [
          (s: ModerationSnapshot) => {
            s.roles[0].actorHash = identityHash(a)
          },
          (s: ModerationSnapshot) => {
            s.business.roleHash = 'e'.repeat(32)
          },
          (s: ModerationSnapshot) => {
            s.roles.push({ ...s.roles[0], actorHash: identityHash(a) })
            s.business.counts.roles++
          },
          (s: ModerationSnapshot) => {
            s.business.posts.find((p) => p.id === fixtureJournal.inventory.fixtures[0].id)!.rowHash = 'e'
              .repeat(32)
          },
          (s: ModerationSnapshot) => {
            s.business.profileHash = 'e'.repeat(32)
          },
          (s: ModerationSnapshot) => {
            s.storageHash = 'e'.repeat(32)
          },
          (s: ModerationSnapshot) => {
            s.business.counts.moderation++
          },
        ]
      ) {
        const drift = structuredClone(granted)
        mutate(drift)
        assert.throws(
          () =>
            assertModerationGrantSnapshot(
              fixtureJournal,
              drift,
              moderationEnv.THEOU_T11_APPROVED_ROLE_FINGERPRINT,
            ),
          /T11_/,
        )
      }
      const store = moderationGate()
      try {
        await store.acquire(fixtureId, true, '--moderate-write')
        await assert.rejects(store.load(fixtureId), /T11_MODERATION_FRESH_ROLE_PROOF_REQUIRED/)
        await store.verifyRecoverySnapshot!(granted)
        const value = await store.load(fixtureId)
        value.roles = structuredClone(granted.roles)
        value.last = structuredClone(granted)
        value.last.business.roleHash = 'e'.repeat(32)
        await assert.rejects(store.save(value, 'B'), /T11_MODERATION_FRESH_ROLE_PROOF_REQUIRED/)
      } finally {
        await store.release()
      }
    })
    await t.test('C3 protected targets and create/publish are denied before fetch even with a forged local permit', async () => {
      let sent = false
      const protectedPost = fixtureJournal.inventory.baseline.business.posts[0].id
      for (
        const [action, payload] of [
          ['adminHideContent', { targetType: 'POST', targetId: protectedPost, reason: 'test' }],
          ['deletePost', { postId: protectedPost }],
          ['createPost', {}],
          ['publishPost', { postId: fixtureJournal.inventory.fixtures[0].id }],
        ] as const
      ) {
        const body = JSON.stringify({ action, payload })
        const scope: ModerationNetworkScope = {
          tokens: new Map([[token(b), 'B']]),
          permits: [{ actor: 'B', hash: requestHash(body) }],
          inventory: fixtureJournal.inventory,
          probeId: randomUUID(),
        }
        const guard = guardT11Fetch(moderationConfig, scope, () => {
          sent = true
          return Promise.resolve(new Response())
        })
        await assert.rejects(
          guard(moderationConfig.url + '/functions/v1/social-api', {
            method: 'POST',
            headers: { apikey: moderationConfig.publishableKey, authorization: `Bearer ${token(b)}` },
            body,
          }),
          /T11_MODERATION_EXACT_FIXTURE_ONLY/,
        )
      }
      assert.equal(sent, false)
    })
    await t.test('C3 scope lock, extra unresolved journal and fixture hash drift prevent acquire without replay', async () => {
      await writeFile(join(folder, 'theou-dev.lock'), 'another process')
      const locked = moderationGate()
      await assert.rejects(locked.acquire(fixtureId, true, '--moderate-write'), /T11_LOCAL_SCOPE_LOCK/)
      await locked.release()
      await unlink(join(folder, 'theou-dev.lock'))
      const extra = structuredClone(j), extraId = 'd'.repeat(32)
      extra.inventory.runId = extraId
      await writeFile(join(folder, `${extraId}.journal.json`), JSON.stringify(extra))
      await writeFile(join(folder, `${extraId}.json`), JSON.stringify(extra.inventory))
      const blocked = moderationGate()
      try {
        await assert.rejects(blocked.acquire(fixtureId, true, '--moderate-write'), /T11_UNRESOLVED_JOURNAL/)
      } finally {
        await blocked.release()
      }
      await unlink(join(folder, `${extraId}.journal.json`))
      await unlink(join(folder, `${extraId}.json`))
      for (const suffix of smokeArtifactSuffixes) {
        await writeFile(join(folder, `${fixtureId}.${suffix}`), fixtureFiles[suffix] + '\n')
        await assert.rejects(
          readReadyModerationEvidence(dir, fixtureAnchor, incident),
          /T11_RECOVERY_ARTIFACT_SHA/,
        )
        await writeFile(join(folder, `${fixtureId}.${suffix}`), fixtureFiles[suffix])
      }
    })
    await t.test('C3 crash/lost ACK before or after SQL success leaves durable INTENT and blocks a second moderate phase', async () => {
      for (const committed of [false, true]) {
        const store = moderationGate()
        try {
          await store.acquire(fixtureId, true, '--moderate-write')
          await store.verifyRecoverySnapshot!(granted)
          const pending = await store.load(fixtureId)
          pending.roles = structuredClone(granted.roles)
          pending.last = structuredClone(granted)
          pending.status = 'RUNNING'
          pending.uncertain = true
          pending.events.push({
            stage: 'POST_HIDE_CONCURRENT',
            phase: 'INTENT',
            proof: requestHash('offline lost ACK'),
          })
          await store.save(pending, 'B')
          if (committed) {
            await f.db.exec('begin')
            try {
              const target = pending.inventory.fixtures.find((value) => value.label === 'post-hide')!
              const response = await f.handler(f.request('adminHideContent', {
                targetType: 'POST',
                targetId: target.id,
                reason: `T11 controlled moderation ${fixtureId} post-hide`,
              }, b))
              assert.equal(response.status, 200)
              assert.equal(
                (await f.db.query<{ n: number }>('select count(*)::integer as n from moderation_actions'))
                  .rows[0].n,
                1,
              )
              // Bỏ ACK; rollback chỉ để reset engine test, không phải recovery logic của runner.
            } finally {
              await f.db.exec('rollback')
            }
          }
        } finally {
          await store.release()
        }
        const retry = moderationGate()
        try {
          await assert.rejects(retry.acquire(fixtureId, true, '--moderate-write'), /T11_UNRESOLVED_JOURNAL/)
        } finally {
          await retry.release()
        }
        // Chỉ restore artifacts synthetic trong tmp để kiểm thử case độc lập tiếp theo.
        for (const suffix of smokeArtifactSuffixes) {
          await writeFile(join(folder, `${fixtureId}.${suffix}`), fixtureFiles[suffix])
        }
      }
    })
    await t.test('C3 actual offline gate runs full moderation once, checks atomic audit/counts and never creates another fixture', async () => {
      const store = moderationGate(), actionsBefore = h.actions.length
      const checked: ModerationStore = {
        ...store,
        async save(value, actor) {
          await store.save(value, actor)
          await h.store.save(value, actor)
        },
      }
      await runT11Cloud(
        moderationConfig,
        moderationEnv,
        () => Promise.reject(new Error('unexpected prompt')),
        checked,
        h.snapshot,
        () => Promise.resolve(),
        (s) => logs.push(s),
        h.request,
      )
      assert.equal(h.saved.status, 'AWAITING_RETENTION_AND_ROLE_REVIEW')
      assert.equal(h.saved.uncertain, false)
      assert.ok([2, 3].includes(h.saved.audits.length))
      assert.equal(h.saved.last.business.counts.posts, 8)
      assert.equal(h.saved.last.business.counts.comments, 6)
      assert.ok(!h.actions.slice(actionsBefore).includes('createPost'))
      assert.ok(!h.actions.slice(actionsBefore).includes('publishPost'))
      assertModerationScope(h.saved, await h.snapshot())
      const retry = moderationGate()
      try {
        await assert.rejects(retry.acquire(fixtureId, true, '--moderate-write'), /T11_UNRESOLVED_JOURNAL/)
      } finally {
        await retry.release()
      }
      for (const [run, files] of [[id, originals], [successId, successfulFiles]] as const) {
        for (const suffix of smokeArtifactSuffixes) {
          assert.equal(await readFile(join(folder, `${run}.${suffix}`), 'utf8'), files[suffix])
        }
      }
      assert.equal(await readFile(sidecarPath, 'utf8'), sidecarText)
    })
    await t.test('C4 final history validates settled batches, intent/ACK/checkpoint proofs, race state and exact protected fixture/audit/role scope', () => {
      const final = structuredClone(h.saved)
      assert.deepEqual(assertFinalModerationReview(final, fixtureJournal, granted.business.roleHash), {
        batches: 21,
        intents: 24,
        opaqueIntents: 2,
      })
      for (
        const mutate of [
          (j: ModerationJournal) => {
            j.uncertain = true
          },
          (j: ModerationJournal) => {
            j.events.splice(j.events.findIndex((e) => e.stage === 'OWNER_DELETE' && e.phase === 'ACK'), 1)
          },
          (j: ModerationJournal) => {
            j.events.find((e) => e.stage === 'OWNER_DELETE' && e.phase === 'INTENT')!.proof = 'f'.repeat(64)
          },
          (j: ModerationJournal) => {
            j.events.find((e) => e.stage === 'OWNER_ADMIN_RACE' && e.phase === 'ACK')!.proof = requestHash(
              JSON.stringify([{ http: 200, code: null }, { http: 200, code: null }]),
            )
          },
          (j: ModerationJournal) => {
            j.events.find((e) => e.stage === 'OWNER_REPLAY' && e.phase === 'VERIFIED')!.proof = 'f'.repeat(64)
          },
          (j: ModerationJournal) => {
            j.inventory.fixtures[5].parent = 'race'
          },
          (j: ModerationJournal) => {
            j.inventory.fixtures[0].owner = 'B'
          },
          (j: ModerationJournal) => {
            j.last.business.roleHash = 'f'.repeat(32)
          },
          (j: ModerationJournal) => {
            j.last.business.posts[0].commentCount++
          },
          (j: ModerationJournal) => {
            j.last.business.profileHash = 'f'.repeat(32)
          },
          (j: ModerationJournal) => {
            j.audits[0].reasonHash = 'f'.repeat(32)
            j.last.audits = j.audits
          },
          (j: ModerationJournal) => {
            j.audits[0].actorHash = identityHash(a)
            j.last.audits = j.audits
          },
        ]
      ) {
        const value = structuredClone(final)
        mutate(value)
        assert.throws(
          () => assertFinalModerationReview(value, fixtureJournal, granted.business.roleHash),
          /T11_|COUNT/,
        )
      }
      assert.throws(() => assertFinalModerationReview(final, fixtureJournal, 'f'.repeat(32)))
    })
    await t.test('C4 hardened final revoke preserves original DO; wrong identity/drift/postcondition roll back, valid revoke retains all audits/content and duplicate fails', async () => {
      const final = structuredClone(h.saved), before = await h.snapshot()
      const original = roleReviewSql(final, 'B', true), sql = assembleFinalRevoke(final, original)
      assert.ok(sql.includes(original.slice(original.indexOf('do $review$'), original.indexOf('commit;'))))
      assert.equal(sql.match(/^begin;$/gm)?.length, 1)
      assert.equal(sql.match(/^commit;$/gm)?.length, 1)
      assert.equal(sql.match(/delete from public\.user_roles/gi)?.length, 1)
      assert.throws(() => assembleFinalRevoke(final, original + '-- drift'))
      const exact = sql.replace(adminUuidPlaceholder, () => b)
      const reject = async (value: string) => {
        await f.db.exec('reset role')
        await assert.rejects(f.db.exec(value), /T11/)
        await f.db.exec('rollback;set role service_role')
        assert.deepEqual(await h.snapshot(), before)
      }
      await reject(sql.replace(adminUuidPlaceholder, () => a))
      await reject(
        exact.replace('do $review$', () => "update public.posts set body=body||' drift';\ndo $review$"),
      )
      await reject(
        exact.replace(
          'do $final_revoke_postcondition$',
          () =>
            `insert into public.user_roles(user_id,role) values('${a}','ADMIN');\ndo $final_revoke_postcondition$`,
        ),
      )
      await f.db.exec('reset role')
      await f.db.exec(exact)
      const after = await h.snapshot(), expected = structuredClone(before)
      expected.roles = []
      expected.business.counts.roles = 0
      expected.business.roleHash = identityHash('[]')
      assert.deepEqual(after, expected)
      assert.deepEqual(after.audits, final.audits)
      await f.db.exec('reset role')
      const proof = (await f.db.exec(finalRevokeVerification(final))).flatMap((r) => r.rows) as Record<
        string,
        unknown
      >[]
      assert.equal(proof[0].final_snapshot_matches, true)
      assert.equal(proof[0].role_count, 0)
      assert.equal(proof[0].audit_count, final.audits.length)
      assert.equal(proof[0].read_only, true)
      await assert.rejects(f.db.exec(exact), /T11 snapshot\/audit\/role drift/)
      await f.db.exec('rollback;set role service_role')
      assert.deepEqual(await h.snapshot(), expected)
    })
  } finally {
    for (const store of stores) await store.release()
    await f.db.close()
    assert.ok(resolve(folder).startsWith(resolve(tmpdir()) + sep) && folder.includes('theou-t11-recovery-'))
    await rm(folder, { recursive: true, force: true })
  }
})
test('T11 outcome analysis rejects duplicate success, no-op lies, network/server and unknown errors', () => {
  analyzeHideResults([{ status: 200, code: null }, { status: 409, code: 'CONFLICT' }])
  for (
    const r of [[{ status: 200, code: null }, { status: 200, code: null }], [{ status: 500, code: null }, {
      status: 409,
      code: 'CONFLICT',
    }], [{ status: 200, code: null }, { status: 403, code: 'FORBIDDEN' }]]
  ) assert.throws(() => analyzeHideResults(r))
})
test('T11 runner HTTP + real SQL/trigger/RPC local; no live Cloud', async (t) => {
  const f = await postFixture()
  try {
    await t.test('smoke only denial probes/read; business snapshot identical, no fixture/audit/role or cleanup', async () => {
      const h = await harness(f), before = await h.snapshot()
      await h.run('--smoke')
      assert.deepEqual(await h.snapshot(), before)
      assert.equal(h.saved.status, 'COMPLETED_SMOKE')
      assert.equal(h.saved.inventory.fixtures.length, 0)
      assert.ok(h.released)
      assert.equal(h.projects, 1)
      assert.ok(
        !h.actions.some((a) =>
          ['createPost', 'publishPost', 'createComment', 'deletePost', 'deleteComment'].includes(a)
        ),
      )
    })
    await t.test('NEW returns three including media; HOT correctly excludes two posts older than24h', async () => {
      const h = await harness(f, { oldPosts: true }), before = await h.snapshot()
      await h.run('--smoke')
      assert.deepEqual(h.feeds.map((p) => [p.sort, p.count, p.media]), [['NEW', 3, 1], ['HOT', 1, 1], [
        'NEW',
        3,
        1,
      ], ['HOT', 1, 1]])
      assert.deepEqual(await h.snapshot(), before)
    })
    await t.test('Feed paginates size1 with real cursor, exact3 IDs/media and NEW/HOT tuples', async () => {
      const h = await harness(f), s = await h.snapshot(), pages: { sort: string; more: boolean }[] = []
      const call = async (
        payload: { sort: 'NEW' | 'HOT'; tag: null; cursor: string | null; limit: number },
      ) => {
        f.state.now = Date.now()
        const r = await f.handler(f.request('listPosts', payload, a)), body = await r.json()
        pages.push({ sort: payload.sort, more: body.data?.nextCursor !== null })
        return { data: body.data, status: r.status, code: body.error?.code ?? null }
      }
      await verifyT11Feed(s, { label: 'A', hash: identityHash(a) }, call, (line) => h.logs.push(line), 1)
      assert.deepEqual(pages, [
        { sort: 'NEW', more: true },
        { sort: 'NEW', more: true },
        { sort: 'NEW', more: false },
        { sort: 'HOT', more: true },
        { sort: 'HOT', more: true },
        { sort: 'HOT', more: false },
      ])
      assert.deepEqual(await h.snapshot(), s)
    })
    await t.test('HTTP server clock permits empty HOT after24h and fails closed at ambiguous24h boundary', async () => {
      const h = await harness(f), s = await h.snapshot(), logs: string[] = []
      const verify = (clock: () => number) =>
        verifyT11Feed(s, { label: 'A', hash: identityHash(a) }, async (payload) => {
          f.state.now = clock()
          const r = await f.handler(f.request('listPosts', payload, a)), body = await r.json()
          return {
            data: body.data,
            status: r.status,
            code: body.error?.code ?? null,
            serverTime: f.state.now,
          }
        }, (line) => logs.push(line))
      await verify(() => Date.now() + 172_800_000)
      assert.ok(
        logs.some((l) =>
          l.includes('sort=HOT') && l.includes('expected=0') && l.includes('actual=0') &&
          l.includes('clock=http_date')
        ),
      )
      const boundary = Date.parse(s.postProofs.find((p) => p.id === retainedMediaPost)!.publishedAt!) +
        86_400_000
      await assert.rejects(verify(() => boundary), /T11_FEED_HOT_BOUNDARY_REVIEW/)
    })
    await t.test('Dropping third media post still FAILS count; smoke leaves no fixtures/role/audit and blocks journal retry', async () => {
      const h = await harness(f, { dropFeedPost: true }), before = await h.snapshot()
      await assert.rejects(h.run('--smoke'), /T11_FEED_COUNT/)
      assert.equal(h.saved.status, 'UNCERTAIN')
      assert.equal(h.saved.uncertain, true)
      assert.equal(h.saved.inventory.fixtures.length, 0)
      assert.equal(h.saved.audits.length, 0)
      assert.equal(h.saved.roles.length, 0)
      assert.ok(h.released)
      assert.deepEqual(await h.snapshot(), before)
      assert.ok(
        h.logs.some((l) =>
          l.includes('sort=NEW') && l.includes('expected=3') && l.includes('actual=2') &&
          l.includes('http=200')
        ),
      )
      const folder = await mkdtemp(join(tmpdir(), 'theou-t11-feed-')),
        dir = pathToFileURL(folder + sep),
        store = fileModerationStore(dir)
      try {
        await store.acquire(h.saved.inventory.runId, false)
        await store.save(h.saved, 'B')
        await store.release()
        const blocked = fileModerationStore(dir)
        await assert.rejects(blocked.acquire('e'.repeat(32), false), /T11_UNRESOLVED_JOURNAL/)
        await blocked.release()
      } finally {
        await store.release()
        assert.ok(resolve(folder).startsWith(resolve(tmpdir()) + sep) && folder.includes('theou-t11-feed-'))
        await rm(folder, { recursive: true, force: true })
      }
    })
    await t.test('DTO and signed URL errors remain FAIL with safe metadata; no fallback dropping media', async () => {
      for (const fault of [{ invalidFeedDto: true }, { storageFailure: true }]) {
        const h = await harness(f, fault), before = await h.snapshot()
        await assert.rejects(h.run('--smoke'), fault.invalidFeedDto ? /T11_FEED_DTO/ : /T11_FEED_HTTP/)
        assert.deepEqual(await h.snapshot(), before)
        const text = h.logs.join('\n')
        for (
          const secret of [
            a,
            b,
            env.THEOU_T06_EMAIL_A,
            env.THEOU_T06_PASSWORD_A,
            token(a),
            serverKey,
            'signedUrl',
            '/storage/v1/',
            'Nội dung offline',
          ]
        ) assert.ok(!text.includes(secret))
        if (fault.storageFailure) assert.ok(text.includes('http=422') && text.includes('code=UPLOAD_ERROR'))
      }
    })
    await t.test('Feed rejects hasMore extra field, empty-more page, truncated/duplicate/cyclic cursor and unknown keys safely', async () => {
      const h = await harness(f), s = await h.snapshot()
      for (const mode of ['extra', 'empty-more', 'truncate', 'duplicate', 'cycle'] as const) {
        const logs: string[] = []
        let firstCursor: string | null = null, calls = 0
        await assert.rejects(
          verifyT11Feed(
            s,
            { label: 'A', hash: identityHash(a) },
            async (payload) => {
              f.state.now = Date.now()
              const r = await f.handler(f.request('listPosts', payload, a)), body = await r.json()
              calls++
              firstCursor ??= body.data.nextCursor
              if (mode === 'extra') {
                body.data.hasMore = true
              }
              if (mode === 'empty-more') body.data.items = []
              if (mode === 'truncate') body.data.nextCursor = null
              if (mode === 'duplicate' && calls === 2) {
                body.data.items = [{
                  ...body.data.items[0],
                  id: s.business.posts.find((p) => p.id !== body.data.items[0].id)!.id,
                }]
              }
              if (mode === 'cycle' && calls === 2) body.data.nextCursor = firstCursor
              return { data: body.data, status: r.status, code: null }
            },
            (line) => logs.push(line),
            1,
          ),
          /T11_FEED_/,
        )
        assert.ok(logs.some((line) => line.startsWith('FAIL: T11_FEED')))
        assert.ok(!logs.join('\n').includes(String(firstCursor)))
      }
    })
    await t.test('Legacy journals remain readable without publishedAt but cannot bypass existing uncertain guard', async () => {
      const h = await harness(f)
      await h.run('--smoke')
      const old = structuredClone(h.saved)
      for (const s of [old.inventory.baseline, old.last]) for (const p of s.postProofs) delete p.publishedAt
      validateModerationJournal(old)
      const logs: string[] = []
      await assert.rejects(
        verifyT11Feed(
          old.last,
          { label: 'A', hash: identityHash(a) },
          () => Promise.reject(new Error('must not request without SQL timestamp')),
          (line) => logs.push(line),
        ),
        /T11_FEED_SQL_TIMESTAMP/,
      )
    })
    await t.test('fixture phase stops before moderation, preserves exact protected data and Storage', async () => {
      const h = await harness(f)
      await h.run()
      assert.equal(h.saved.status, 'AWAITING_MODERATION_REVIEW')
      assert.equal(h.saved.uncertain, false)
      assert.equal(h.saved.inventory.fixtures.length, 8)
      assert.equal(h.saved.last.business.counts.posts, 8)
      assert.equal(h.saved.last.business.counts.comments, 6)
      assert.equal(h.saved.last.audits.length, 0)
      assert.equal(h.saved.last.roles.length, 0)
      assert.ok(!h.actions.includes('adminHideContent') && !h.actions.includes('deletePost'))
      assertModerationScope(h.saved, await h.snapshot())
    })
    await t.test('missing/wrong approved ADMIN blocks resume before business changes', async () => {
      const h = await harness(f)
      await h.run()
      const writes = h.writes
      await assert.rejects(h.run('--moderate-write'), /T11_EXACT_APPROVED_ADMIN_ROLE/)
      assert.equal(h.writes, writes)
    })
    await t.test('complete moderation matrix uses exact fixtures; SQL proves audit/counts; grant/revoke review is separate', async () => {
      const h = await harness(f)
      await h.run()
      const fixtureJournal = structuredClone(h.saved), grant = roleReviewSql(h.saved, 'B', false)
      assert.ok(!grant.includes(b))
      assert.ok(grant.includes('insert into public.user_roles'))
      assert.ok(!grant.includes('delete from public.moderation_actions'))
      await f.db.exec('reset role')
      await f.db.exec(
        grant.replace(
          '-- Insert the exact SET LOCAL here after reviewing actor and connected project.',
          `set local theou.t11_admin_id='${b}';`,
        ),
      )
      await f.db.exec('set role service_role')
      await h.run('--moderate-write')
      assert.equal(h.saved.status, 'AWAITING_RETENTION_AND_ROLE_REVIEW')
      assert.equal(h.saved.uncertain, false)
      assert.ok([2, 3].includes(h.saved.last.audits.length))
      assert.equal(h.saved.last.business.counts.posts, 8)
      assert.equal(h.saved.last.business.counts.comments, 6)
      assert.equal(h.saved.last.storageHash, fixtureJournal.last.storageHash)
      assertModerationScope(h.saved, await h.snapshot())
      const owner = h.saved.inventory.fixtures.find((x) => x.label === 'owner')!,
        post = h.saved.inventory.fixtures.find((x) => x.label === 'post-hide')!,
        comment = h.saved.inventory.fixtures.find((x) => x.label === 'comment-hide')!
      assert.equal(owner.status, 'DELETED')
      assert.equal(post.status, 'HIDDEN')
      assert.equal(comment.status, 'HIDDEN')
      const verify = moderationVerificationSql(h.saved.inventory)
      assert.ok(verify.includes('exact_rows') && verify.includes('c.post_id='))
      const revoke = roleReviewSql(h.saved, 'B', true)
      assert.ok(
        revoke.includes("delete from public.user_roles where user_id=approved_admin_id and role='ADMIN'"),
      )
      assert.ok(!revoke.includes(b))
      await f.db.exec('reset role')
      await f.db.exec(
        revoke.replace(
          '-- Insert the exact SET LOCAL here after reviewing actor and connected project.',
          `set local theou.t11_admin_id='${b}';`,
        ),
      )
      await f.db.exec('set role service_role')
      assert.equal((await f.db.query('select * from user_roles')).rows.length, 0)
      assert.equal((await f.db.query('select * from moderation_actions')).rows.length, h.saved.audits.length)
      const text = JSON.stringify(h.saved) + h.logs.join('\n')
      for (const secret of [a, b, env.THEOU_T06_EMAIL_A, env.THEOU_T06_PASSWORD_A, token(a), serverKey]) {
        assert.ok(!text.includes(secret))
      }
    })
    await t.test('timeout after server commit keeps unknown UUID/INTENT and blocks batch retry', async () => {
      const h = await harness(f, { timeout: true })
      await assert.rejects(h.run(), /T11_/)
      assert.equal(h.saved.uncertain, true)
      assert.equal(h.saved.status, 'UNCERTAIN')
      assert.equal(h.saved.inventory.fixtures[0].id, null)
      assert.equal((await h.snapshot()).business.counts.posts, 4)
      const writes = h.writes
      await assert.rejects(h.run())
      assert.equal(h.writes, writes)
      assert.ok(h.released)
    })
    await t.test('intent I/O, ACK I/O, protected drift and live project failure stop; never auto cleanup', async () => {
      for (const faults of [{ intentIo: true }, { ackIo: true }, { drift: true }, { project: true }]) {
        const h = await harness(f, faults)
        await assert.rejects(h.run())
        assert.ok(h.released)
        if (faults.intentIo || faults.project) assert.equal(h.writes, 0)
        assert.ok(!h.actions.includes('deletePost') && !h.actions.includes('adminHideContent'))
      }
    })
    await t.test('inventory target/owner/key/body/fingerprint/audit tampering fails closed', async () => {
      const h = await harness(f)
      await h.run()
      const current = await h.snapshot()
      for (
        const edit of [
          (j: ModerationJournal) => {
            j.inventory.fixtures[0].id = retainedMediaPost
          },
          (j: ModerationJournal) => {
            j.inventory.fixtures[0].owner = 'B'
          },
          (j: ModerationJournal) => {
            j.inventory.fixtures[0].key = randomUUID()
          },
          (j: ModerationJournal) => {
            j.inventory.fixtures[0].body = 'other'
          },
          (j: ModerationJournal) => {
            j.inventory.fixtures[0].immutableHash = 'f'.repeat(32)
          },
        ]
      ) {
        const j = structuredClone(h.saved)
        edit(j)
        assert.throws(() => assertModerationScope(j, current))
      }
      const changed = structuredClone(current)
      changed.business.posts.find((p) => p.id === h.saved.inventory.baseline.business.posts[0].id)!.rowHash =
        'f'.repeat(32)
      assert.throws(() => assertModerationScope(h.saved, changed))
      changed.storageHash = 'f'.repeat(32)
      assert.throws(() => assertModerationScope(h.saved, changed))
      const audit = structuredClone(current)
      audit.audits.push({
        id: randomUUID(),
        actorHash: identityHash(b),
        targetId: h.saved.inventory.fixtures[0].id!,
        type: 'POST',
        reasonHash: 'a'.repeat(32),
        rowHash: 'b'.repeat(32),
        action: 'HIDE',
      })
      audit.business.counts.moderation = 1
      assert.throws(() => assertModerationScope(h.saved, audit))
    })
    await t.test('network guard rejects arbitrary targets, cross-phase writes, raw admin/table/Storage and missing durable permit', async () => {
      const h = await harness(f)
      await h.run()
      let reached = 0
      const config = readT11Config(env, t04ProjectRef, ['--moderate-write', h.saved.inventory.runId]),
        scope: ModerationNetworkScope = {
          tokens: new Map([[token(a), 'A']]),
          permits: [],
          inventory: h.saved.inventory,
          probeId: randomUUID(),
        }
      const guard = guardT11Fetch(config, scope, () => {
        reached++
        return Promise.resolve(Response.json({}))
      })
      const headers = { apikey: env.THEOU_AUTH_PUBLISHABLE_KEY, authorization: `Bearer ${token(a)}` }
      for (const path of ['/auth/v1/admin/users', '/rest/v1/user_roles', '/storage/v1/object/post-media/x']) {
        await assert.rejects(guard(config.url + path, { method: 'POST', headers, body: '{}' }))
      }
      const body = JSON.stringify({
        action: 'adminHideContent',
        payload: { targetType: 'POST', targetId: retainedMediaPost, reason: 'x' },
      })
      await assert.rejects(guard(config.url + '/functions/v1/social-api', { method: 'POST', headers, body }))
      scope.permits.push({ actor: 'A', hash: requestHash(body) })
      await assert.rejects(guard(config.url + '/functions/v1/social-api', { method: 'POST', headers, body }))
      assert.equal(reached, 0)
    })
    await t.test('file store persists INTENT before artifacts, blocks unresolved/crashed journals and holds project lock', async () => {
      const h = await harness(f)
      await h.run()
      const folder = await mkdtemp(join(tmpdir(), 'theou-t11-')),
        dir = pathToFileURL(folder + sep),
        id = h.saved.inventory.runId
      const store = fileModerationStore(dir), other = fileModerationStore(dir)
      try {
        await store.acquire(id, false)
        await store.save(h.saved, 'B')
        await assert.rejects(other.acquire('b'.repeat(32), false), /T11_LOCAL_SCOPE_LOCK/)
        assert.equal(JSON.parse(await readFile(join(folder, id + '.json'), 'utf8')).runId, id)
        await store.release()
        await other.acquire(id, true)
        assert.deepEqual(await other.load(id), h.saved)
        await other.release()
        const blocked = fileModerationStore(dir)
        await assert.rejects(blocked.acquire('c'.repeat(32), false), /T11_UNRESOLVED_JOURNAL/)
        await blocked.release()
        const resume = fileModerationStore(dir)
        await resume.acquire(id, true)
        const j = await resume.load(id)
        j.uncertain = true
        j.status = 'UNCERTAIN'
        j.events.push({ stage: 'TEST_INTENT', phase: 'INTENT', proof: 'a'.repeat(64) })
        await resume.save(j, 'B')
        await resume.release()
        const retry = fileModerationStore(dir)
        await assert.rejects(retry.acquire(id, true), /T11_UNRESOLVED_JOURNAL/)
        await retry.release()
        await writeFile(join(folder, id + '.json'), '{}')
        const broken = fileModerationStore(dir)
        await assert.rejects(broken.acquire(id, true), /T11_ARTIFACT_MISMATCH/)
        await broken.release()
        await unlink(join(folder, id + '.journal.json'))
        const orphan = fileModerationStore(dir)
        await assert.rejects(orphan.acquire(id, true), /T11_ORPHAN_ARTIFACT/)
        await orphan.release()
      } finally {
        await store.release()
        await other.release()
        assert.ok(resolve(folder).startsWith(resolve(tmpdir()) + sep) && folder.includes('theou-t11-'))
        await rm(folder, { recursive: true, force: true })
      }
    })
    await t.test('CLI keeps native argv/read-only/exact ref; diagnostics never include raw output or credentials', async () => {
      const h = await harness(f), snapshot = await h.snapshot(), calls: string[][] = []
      const execute: CliExecute = (_file, args, options) => {
        calls.push(args)
        assert.equal(options.windowsHide, true)
        assert.equal(options.timeout, 60000)
        return Promise.resolve({
          stdout: args[0] === '--version' ? '3.1.0' : JSON.stringify(
            args[0] === 'projects'
              ? [{
                id: t04ProjectRef,
                ref: t04ProjectRef,
                name: 'TheOU-dev',
                linked: true,
                status: 'ACTIVE_HEALTHY',
              }]
              : [{ snapshot }],
          ),
          stderr: '',
        })
      }
      const cli = await createT11Cli({ THEOU_SUPABASE_CLI: process.execPath }, execute)
      await cli.project()
      assert.deepEqual(await cli.snapshot(), snapshot)
      assert.ok(
        calls[2].includes('--read-only') && calls[2].includes(`--remote=${t04ProjectRef}`) &&
          calls[2].at(-1) === moderationSnapshotSql,
      )
      for (
        const failure of [
          { code: 'ENOENT' },
          { code: 'ETIMEDOUT' },
          { stderr: JSON.stringify({ error: { code: '42501' } }) },
          { stderr: JSON.stringify({ error: { code: '42601' } }) },
          { stderr: JSON.stringify({ error: { code: 'DbQueryLoginRequiredError' } }) },
        ]
      ) {
        const bad = await createT11Cli(
          { THEOU_SUPABASE_CLI: process.execPath },
          (_f, args) =>
            args[0] === '--version'
              ? Promise.resolve({ stdout: '3.1.0', stderr: '' })
              : Promise.reject({ ...failure, stdout: token(a) }),
        )
        await assert.rejects(
          bad.snapshot(),
          (e: Error) => /T11_CLI/.test(e.message) && !e.message.includes(token(a)),
        )
      }
    })
  } finally {
    await f.db.close()
  }
})
