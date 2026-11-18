import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'
import { a, b, postFixture, serverKey } from './helpers/post-fixture.ts'
import { t04ProjectRef } from '../scripts/t04-cloud-recovery.ts'
import { type CliExecute } from '../scripts/t08-cloud-cli.ts'
import { approvedVotePost, identityHash } from '../scripts/t09-cloud-inventory.ts'
import { createT10Cli } from '../scripts/t10-cloud-cli.ts'
import {
  guardT10Fetch,
  type MediaNetworkScope,
  readT10Config,
  runT10Cloud,
} from '../scripts/t10-cloud-runner.ts'
import {
  assertMediaScope,
  fileMediaStore,
  mediaBaseline,
  mediaCleanupPlan,
  type MediaJournal,
  type MediaSnapshot,
  mediaSnapshotSql,
  mediaVerificationSql,
  parseMediaSnapshot,
  validateMediaJournal,
} from '../scripts/t10-cloud-inventory.ts'
import { mediaAssets, sha256 } from '../scripts/t10-media-assets.ts'
import { matchesImage } from '../functions/social-api/modules/media/storage.ts'

const env = {
  THEOU_ALLOW_AUTH_TESTS: 'theou-dev',
  THEOU_AUTH_SUPABASE_URL: `https://${t04ProjectRef}.supabase.co`,
  THEOU_AUTH_PUBLISHABLE_KEY: 'sb_publishable_offline',
  THEOU_TEST_SECRET_KEY: 'sb_secret_offline',
  THEOU_ALLOW_T10_DRAFT_WRITES: 'theou-dev',
  THEOU_ALLOW_T10_PUBLISH_WRITES: 'theou-dev',
  THEOU_T10_RETAIN_PUBLISHED_FIXTURE: 'approved',
  THEOU_T06_EMAIL_A: 'offline-a@ou.edu.vn',
  THEOU_T06_EMAIL_B: 'offline-b@ou.edu.vn',
  THEOU_T06_PASSWORD_A: 'offline password A',
  THEOU_T06_PASSWORD_B: 'offline password B',
}
const token = (id: string) => `eyJhbGciOiJFUzI1NiJ9.${btoa(id)}.offline`
type Engine = Awaited<ReturnType<typeof postFixture>>
interface Faults {
  intentIo?: boolean
  ackIo?: boolean
  timeout?: boolean
  drift?: boolean
  invalidObject?: boolean
  missingObject?: boolean
  project?: boolean
}
async function harness(f: Engine, faults: Faults = {}) {
  await f.reset()
  await f.db.exec(`reset role;
    create schema if not exists storage; create schema if not exists supabase_migrations;
    create table if not exists storage.buckets(id text primary key,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create table if not exists storage.objects(name text primary key,bucket_id text,metadata jsonb);
    alter table storage.objects enable row level security;
    create table if not exists supabase_migrations.schema_migrations(version text primary key);
    truncate storage.objects,storage.buckets,supabase_migrations.schema_migrations;
    insert into storage.buckets values('post-media',false,2097152,array['image/jpeg','image/png','image/webp']);
    insert into supabase_migrations.schema_migrations values('20261117155535');
    set role service_role;`)
  await f.seed({ id: approvedVotePost })
  await f.seed({ author: b })
  await f.db.query(
    "insert into comments(post_id,author_id,body,idempotency_key) values($1,$2,'protected OP',$3),($1,$4,'protected visible',$5),($1,$4,'protected deleted',$6)",
    [approvedVotePost, a, randomUUID(), b, randomUUID(), randomUUID()],
  )
  await f.db.query("update comments set status='DELETED' where body='protected deleted'")
  let saved: MediaJournal | undefined, acquired = false, released = false, writes = 0, projects = 0
  const logs: string[] = [], actions: string[] = [], operations: string[] = []
  async function snapshot() {
    await f.db.exec('reset role; begin read only')
    let current: MediaSnapshot
    try {
      current = parseMediaSnapshot(
        (await f.db.query<{ snapshot: MediaSnapshot }>(mediaSnapshotSql)).rows[0].snapshot,
      )
    } finally {
      await f.db.exec('rollback; set role service_role')
    }
    if (faults.drift && writes) current.business.comments[0].rowHash = 'f'.repeat(32)
    return current
  }
  const store = {
    acquire(_id: string, resume: boolean) {
      assert.ok(!acquired || resume)
      acquired = true
      released = false
      return Promise.resolve()
    },
    load() {
      assert.ok(saved)
      return Promise.resolve(structuredClone(saved))
    },
    save(j: MediaJournal) {
      validateMediaJournal(j)
      if (
        faults.intentIo && j.events.at(-1)?.phase === 'INTENT' ||
        faults.ackIo && j.events.at(-1)?.phase === 'ACK'
      ) throw new Error(`IO ${env.THEOU_T06_PASSWORD_A}`)
      saved = structuredClone(j)
      return Promise.resolve()
    },
    release() {
      released = true
      return Promise.resolve()
    },
  }
  function wal() {
    assert.ok(
      saved?.uncertain && saved.events.at(-1)?.phase === 'INTENT',
      'durable INTENT before every mutation',
    )
    writes++
  }
  const request: typeof fetch = async (input, init) => {
    const url = new URL(String(input)), headers = new Headers(init?.headers)
    assert.equal(url.origin, env.THEOU_AUTH_SUPABASE_URL)
    assert.equal(init?.redirect, 'error')
    assert.equal(init?.credentials, 'omit')
    const caller = [a, b].find((id) => headers.get('authorization') === `Bearer ${token(id)}`)
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
    if (url.pathname.startsWith('/storage/v1/')) {
      const privileged = headers.get('apikey') === env.THEOU_TEST_SECRET_KEY
      operations.push(`${init?.method ?? 'GET'}:${url.pathname.split('/').slice(0, 6).join('/')}`)
      assert.notEqual(init?.method, 'DELETE', 'no automatic Storage cleanup')
      if (url.pathname.includes('/upload/sign/')) {
        wal()
        assert.equal(init?.method, 'PUT')
        assert.equal(caller, a)
        const path = url.pathname.split('/post-media/')[1], body = init?.body as FormData
        const blob = [...body.values()].find((v): v is File => v instanceof Blob)!
        f.storage.objects.set(path, blob)
        await f.db.exec('reset role')
        await f.db.query('insert into storage.objects values($1,$2,$3)', [path, 'post-media', {
          size: blob.size,
          mimetype: blob.type,
        }])
        await f.db.exec('set role service_role')
        if (faults.timeout) throw new Error(`${url.href} ${serverKey}`)
        return Response.json({ Key: `post-media/${path}` })
      }
      if (init?.method === 'POST' && url.pathname.startsWith('/storage/v1/object/post-media/')) {
        wal()
        return Response.json({ statusCode: '403', error: 'Unauthorized', message: 'Denied' }, { status: 403 })
      }
      if (url.pathname.includes('/list/')) return Response.json([])
      const path = url.pathname.split('/post-media/')[1]
      const blob = f.storage.objects.get(path)
      if (!privileged && !url.pathname.includes('/object/sign/')) {
        return Response.json({ code: 'NoSuchKey' }, { status: 404 })
      }
      if (faults.missingObject || !blob) return Response.json({ code: 'NoSuchKey' }, { status: 404 })
      if (url.pathname.includes('/info/')) {
        return Response.json({
          name: path,
          bucket_id: 'post-media',
          size: blob.size,
          content_type: faults.invalidObject ? 'text/plain' : blob.type,
        })
      }
      return new Response(blob, { headers: { 'content-type': blob.type } })
    }
    assert.equal(url.pathname, '/functions/v1/social-api')
    assert.equal(headers.get('apikey'), env.THEOU_AUTH_PUBLISHABLE_KEY, 'no privileged business API')
    const body = JSON.parse(String(init?.body))
    actions.push(body.action)
    if (['createPost', 'createImageUpload', 'finalizeImage', 'publishPost'].includes(body.action)) wal()
    f.state.now = Date.now()
    const response = await f.handler(
      f.request(
        body.action,
        body.payload,
        caller ?? null,
        headers.has('authorization') ? { authorization: headers.get('authorization')! } : {},
      ),
    )
    if (faults.timeout && writes && body.action === 'createPost') throw new Error(`${token(a)} ${serverKey}`)
    const data = await response.json()
    // HTTP adapter của engine dùng origin giả riêng; Cloud dùng origin project thật.
    const rewritten = JSON.stringify(data).replaceAll(
      'https://offline.example.invalid',
      env.THEOU_AUTH_SUPABASE_URL,
    )
    return new Response(rewritten, { status: response.status, headers: response.headers })
  }
  return {
    snapshot,
    store,
    logs,
    actions,
    operations,
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
      mode: '--smoke' | '--draft-write' | '--publish-write' = '--draft-write',
      overrides: NodeJS.ProcessEnv = {},
    ) {
      const values = { ...env, ...overrides },
        args = mode === '--publish-write' ? [mode, saved!.inventory.runId] : [mode]
      return runT10Cloud(
        readT10Config(values, t04ProjectRef, args),
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

test('T10 exact ref/URL, default smoke, independent flags and publish retention gate', () => {
  assert.equal(readT10Config(env, t04ProjectRef, []).mode, '--smoke')
  for (
    const [overrides, args] of [
      [{ THEOU_ALLOW_T10_DRAFT_WRITES: '' }, ['--draft-write']],
      [{ THEOU_ALLOW_T10_PUBLISH_WRITES: '' }, ['--publish-write', 'a'.repeat(32)]],
      [{ THEOU_T10_RETAIN_PUBLISHED_FIXTURE: '' }, ['--publish-write', 'a'.repeat(32)]],
      [{ THEOU_TEST_SECRET_KEY: '' }, ['--draft-write']],
      [{ THEOU_AUTH_SUPABASE_URL: 'https://other.supabase.co' }, []],
      [{}, ['--publish-write', '../oops']],
      [{}, ['--write']],
    ] as [NodeJS.ProcessEnv, string[]][]
  ) {
    assert.throws(() =>
      readT10Config({ ...env, ...overrides, THEOU_ALLOW_T09_CLOUD_WRITES: 'theou-dev' }, t04ProjectRef, args)
    )
  }
  assert.throws(() => readT10Config(env, 'wrong-project', []))
})
test('T10 synthetic images reproducible, consistent bytes/MIME/container and no metadata', () => {
  const assets = mediaAssets()
  assert.deepEqual(assets, mediaAssets())
  for (const asset of assets) {
    assert.ok(asset.size < 2097152 && matchesImage(asset.bytes, asset.mime))
    assert.equal(sha256(asset.bytes), asset.hash)
    assert.doesNotMatch(asset.bytes.toString('latin1'), /Exif|GPS|ICC_PROFILE|EXIF|XMP /)
  }
})
test('T10 permission firewall blocks admin/business bypass, raw mutation, forged upload and extra target', async () => {
  const scope: MediaNetworkScope = {
    tokens: new Map([[token(a), 'A']]),
    permits: [],
    upload: null,
    images: [],
    signedReads: new Set(),
  }
  let called = 0
  const request: typeof fetch = () => {
    called++
    return Promise.resolve(new Response(null, { status: 204 }))
  }
  const config = readT10Config(env, t04ProjectRef, [])
  for (
    const [path, method, key, action] of [
      ['/functions/v1/social-api', 'POST', env.THEOU_AUTH_PUBLISHABLE_KEY, 'createPost'],
      ['/functions/v1/social-api', 'POST', env.THEOU_TEST_SECRET_KEY, 'getMe'],
      ['/auth/v1/admin/users', 'POST', env.THEOU_AUTH_PUBLISHABLE_KEY, 'getMe'],
      ['/storage/v1/object/post-media/x', 'DELETE', env.THEOU_AUTH_PUBLISHABLE_KEY, 'getMe'],
      [
        '/storage/v1/object/upload/sign/post-media/x?token=private',
        'PUT',
        env.THEOU_AUTH_PUBLISHABLE_KEY,
        'getMe',
      ],
      ['/rest/v1/posts', 'GET', env.THEOU_AUTH_PUBLISHABLE_KEY, 'getMe'],
    ]
  ) {
    await assert.rejects(
      guardT10Fetch(config, scope, request, env.THEOU_TEST_SECRET_KEY)(config.url + path, {
        method,
        headers: { apikey: key, Authorization: `Bearer ${token(a)}` },
        body: JSON.stringify({ action, payload: {} }),
      }),
    )
  }
  await assert.rejects(
    guardT10Fetch(config, scope, request)('https://other.supabase.co/auth/v1/user', {
      headers: { apikey: config.publishableKey },
    }),
  )
  assert.equal(called, 0)
})
test('T10 runner uses real SDK/HTTP handler and PostgreSQL-compatible SQL, no Cloud', async (t) => {
  const f = await postFixture()
  try {
    await t.test('smoke: no mutation/token/object, baseline unchanged and redacted', async () => {
      const h = await harness(f), before = await h.snapshot()
      await h.run('--smoke')
      assert.equal(h.writes, 0)
      assert.equal(h.saved.status, 'COMPLETED')
      assert.equal(h.released, true)
      assert.deepEqual(await h.snapshot(), before)
      assert.ok(!h.actions.some((a) => /create|finalize|publish|remove|delete|toggle/i.test(a)))
      assert.ok(!f.storage.calls.some((c) => c.operation === 'uploadSign'))
      assert.equal(h.projects, 1)
      for (
        const value of [
          a,
          b,
          env.THEOU_T06_EMAIL_A,
          env.THEOU_T06_PASSWORD_A,
          token(a),
          env.THEOU_TEST_SECRET_KEY,
        ]
      ) assert.ok(!JSON.stringify([h.saved, h.logs]).includes(value))
    })
    await t.test('draft then publish approved existing run: two valid images and exact protected data, no cleanup', async () => {
      const h = await harness(f)
      await h.run()
      assert.equal(h.saved.status, 'AWAITING_PUBLISH_REVIEW')
      assert.equal(h.saved.inventory.images.length, 2)
      const draft = structuredClone(h.saved)
      assert.equal((await h.snapshot()).business.counts.posts, 3)
      assert.equal(h.actions.includes('publishPost'), false)
      assertMediaScope(h.saved.inventory, await h.snapshot())
      for (
        const value of ['offline-upload-token', 'offline-read-token', token(a), env.THEOU_TEST_SECRET_KEY]
      ) assert.ok(!JSON.stringify(h.saved).includes(value))
      await h.run('--publish-write')
      assert.equal(h.saved.inventory.runId, draft.inventory.runId)
      assert.equal(h.saved.inventory.postId, draft.inventory.postId)
      assert.equal(h.saved.status, 'AWAITING_RETENTION_OR_CLEANUP_REVIEW')
      assert.equal(h.actions.filter((a) => a === 'publishPost').length, 1)
      assert.ok(!h.actions.some((a) => /delete|remove/i.test(a)))
      assert.deepEqual(h.saved.inventory.baseline, draft.inventory.baseline)
      assertMediaScope(h.saved.inventory, await h.snapshot())
    })
    for (
      const [name, fault] of Object.entries({
        'INTENT disk failure blocks request': { intentIo: true },
        'ACK disk failure preserves uncertainty': { ackIo: true },
        'unknown commit stops without create retry': { timeout: true },
        'protected drift stops': { drift: true },
        'Storage MIME mismatch stops': { invalidObject: true },
        'missing Storage object stops': { missingObject: true },
        'live project failure before login': { project: true },
      })
    ) {
      await t.test(name, async () => {
        const h = await harness(f, fault)
        await assert.rejects(h.run(), /T10_STOPPED_REVIEW/)
        assert.equal(h.released, false)
        assert.ok(!h.actions.includes('publishPost'))
        if ('intentIo' in fault || 'project' in fault) assert.equal(h.writes, 0)
        if ('timeout' in fault) assert.equal(h.actions.filter((a) => a === 'createPost').length, 1)
        if (h.saved) assert.equal(h.saved.uncertain, true)
        assert.doesNotMatch(h.logs.join('\n'), /offline-upload-token|offline password|sb_secret|SQL stack/)
      })
    }
    await t.test('baseline/parser and exact scope reject unknown rows, role/count/profile/bucket drift', async () => {
      const h = await harness(f), base = await h.snapshot()
      mediaBaseline(base)
      for (
        const mutate of [
          (s: MediaSnapshot) => {
            s.security.private = false
          },
          (s: MediaSnapshot) => {
            s.security.policies = 1
          },
          (s: MediaSnapshot) => {
            s.security.migration = false
          },
          (s: MediaSnapshot) => {
            s.business.counts.users = 3
          },
          (s: MediaSnapshot) => {
            s.objects.push({ path: 'unknown', mime: 'image/png', size: 1, rowHash: 'a'.repeat(32) })
          },
        ]
      ) {
        const bad = structuredClone(base)
        mutate(bad)
        assert.throws(() => mediaBaseline(bad))
      }
      await h.run()
      for (
        const mutate of [
          (s: MediaSnapshot) => {
            s.business.profileHash = 'f'.repeat(32)
          },
          (s: MediaSnapshot) => {
            s.business.roleHash = 'f'.repeat(32)
          },
          (s: MediaSnapshot) => {
            s.business.posts.find((p) => p.id === approvedVotePost)!.rowHash = 'f'.repeat(32)
          },
          (s: MediaSnapshot) => {
            s.business.comments[0].rowHash = 'f'.repeat(32)
          },
          (s: MediaSnapshot) => {
            s.images[0].path = 'posts/foreign/path.png'
          },
          (s: MediaSnapshot) => {
            s.postProofs.find((p) => p.id === h.saved.inventory.postId)!.bodyHash = 'f'.repeat(32)
          },
          (s: MediaSnapshot) => {
            s.business.posts.find((p) => p.id === h.saved.inventory.postId)!.authorHash = identityHash(b)
          },
        ]
      ) {
        const bad = await h.snapshot()
        mutate(bad)
        assert.throws(() => assertMediaScope(h.saved.inventory, bad))
      }
    })
    await t.test('file store: WAL/history/lock, no replay, exact cleanup plan, mismatch and corrupt artifacts', async () => {
      const h = await harness(f)
      await h.run()
      const draft = structuredClone(h.saved), id = draft.inventory.runId
      assert.match(mediaCleanupPlan(draft.inventory), new RegExp(draft.inventory.images[0].id))
      assert.match(mediaCleanupPlan(draft.inventory), /PUBLISHED READY|PENDING|2 giờ|ON DELETE RESTRICT/)
      assert.doesNotMatch(
        mediaVerificationSql(draft.inventory),
        /\b(delete|update|insert|truncate)\s+(from|into|public|storage)/i,
      )
      const folder = await mkdtemp(join(tmpdir(), 'theou-t10-')), directory = pathToFileURL(folder + sep)
      try {
        const store = fileMediaStore(directory)
        await store.acquire(id, false)
        await store.save(draft)
        await store.release()
        assert.deepEqual(await store.load(id), draft)
        const blocked = fileMediaStore(directory)
        await assert.rejects(blocked.acquire(randomUUID().replaceAll('-', ''), false), /UNRESOLVED/)
        await blocked.release()
        const resume = fileMediaStore(directory)
        await resume.acquire(id, true)
        const tampered = structuredClone(draft)
        tampered.inventory.actors.A = identityHash(b)
        await assert.rejects(resume.save(tampered))
        await resume.release()
        const proofPath = new URL(`${id}.json`, directory)
        await writeFile(proofPath, '{}')
        await assert.rejects(fileMediaStore(directory).load(id), /ARTIFACT_MISMATCH/)
        await writeFile(proofPath, JSON.stringify(draft.inventory))
        await writeFile(new URL(`${id}.journal.json`, directory), '{')
        await assert.rejects(fileMediaStore(directory).load(id))
        await assert.rejects(fileMediaStore(directory).load('../no'))
        const lock = new URL('scope.lock', directory)
        await writeFile(lock, 'existing')
        await assert.rejects(fileMediaStore(directory).acquire(id, true))
        assert.equal(await readFile(lock, 'utf8'), 'existing')
        await unlink(lock)
      } finally {
        assert.ok(resolve(folder).startsWith(resolve(tmpdir()) + sep) && folder.includes('theou-t10-'))
        await rm(folder, { recursive: true, force: true })
      }
    })
    await t.test('CLI native argument array, read-only JSON snapshot and safe diagnostics', async () => {
      const h = await harness(f), snapshot = await h.snapshot(), calls: string[][] = []
      const execute: CliExecute = (_file, args, options) => {
        calls.push(args)
        assert.equal(options.windowsHide, true)
        assert.equal(options.timeout, 60_000)
        return Promise.resolve({
          stdout: args[0] === '--version' ? '3.1.0' : JSON.stringify([{ snapshot }]),
          stderr: '',
        })
      }
      const cli = await createT10Cli({ THEOU_SUPABASE_CLI: process.execPath }, execute)
      assert.deepEqual(await cli.snapshot(), snapshot)
      assert.ok(
        calls[1].includes(`--remote=${t04ProjectRef}`) && calls[1].includes('--read-only') &&
          calls[1].at(-1) === mediaSnapshotSql,
      )
      const invalid = await createT10Cli(
        { THEOU_SUPABASE_CLI: process.execPath },
        (_f, args) =>
          Promise.resolve({ stdout: args[0] === '--version' ? '3.1.0' : `private ${token(a)}`, stderr: '' }),
      )
      await assert.rejects(invalid.snapshot(), /T10_CLI.*INVALID_JSON/)
      for (
        const failure of [{ code: 'ETIMEDOUT' }, { code: 'ENOENT' }, {
          stderr: JSON.stringify({ error: { code: 'DbQueryLoginRequiredError' } }),
        }]
      ) {
        const bad = await createT10Cli(
          { THEOU_SUPABASE_CLI: process.execPath },
          (_f, args) =>
            args[0] === '--version'
              ? Promise.resolve({ stdout: '3.1.0', stderr: '' })
              : Promise.reject({ ...failure, stdout: token(a) }),
        )
        await assert.rejects(
          bad.snapshot(),
          (e: Error) => /T10_CLI/.test(e.message) && !e.message.includes(token(a)),
        )
      }
    })
  } finally {
    await f.db.close()
  }
})
