import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'
import { a, b, cursorSecret, postFixture } from './helpers/post-fixture.ts'
import {
  decodeCommentCursor,
  encodeCommentCursor,
} from '../functions/social-api/modules/comments/comment-cursor.ts'
import { signCursor } from '../functions/social-api/shared/cursor.ts'
import { t04ProjectRef } from '../scripts/t04-cloud-recovery.ts'
import {
  type CommentDeleteJournal,
  type CommentDeleteStore,
  fileCommentDeleteStore,
  prepareDeleteJournal,
  validateDeleteJournal,
} from '../scripts/t08-cloud-delete.ts'
import {
  confirmT08Project,
  digest,
  guardT08Fetch,
  publicComment,
  readT08Config,
  runT08Cloud,
} from '../scripts/t08-cloud-runner.ts'
import {
  type CommentBaseline,
  commentCleanupSql,
  type CommentInventory,
  commentResumeSnapshotSql,
  commentSnapshotSql,
  commentVerificationSql,
  fileCommentInventory,
  readCommentInventory,
  validateCommentInventory,
} from '../scripts/t08-cloud-inventory.ts'

const env = {
  THEOU_ALLOW_AUTH_TESTS: 'theou-dev',
  THEOU_AUTH_SUPABASE_URL: `https://${t04ProjectRef}.supabase.co`,
  THEOU_AUTH_PUBLISHABLE_KEY: 'sb_publishable_offline',
  THEOU_ALLOW_T08_CLOUD_WRITES: 'theou-dev',
  THEOU_T06_EMAIL_A: 'offline-a@ou.edu.vn',
  THEOU_T06_EMAIL_B: 'offline-b@ou.edu.vn',
  THEOU_T06_PASSWORD_A: 'offline A password',
  THEOU_T06_PASSWORD_B: 'offline B password',
}
const token = (id: string) => `eyJhbGciOiJFUzI1NiJ9.${btoa(id)}.offline`
test('T08 CLI projects JSON envelope và live metadata; cache label không thay name/ref', () => {
  const project = {
    id: t04ProjectRef,
    ref: t04ProjectRef,
    name: 'TheOU-dev',
    linked: true,
    status: 'ACTIVE_HEALTHY',
  }
  confirmT08Project({ projects: [project], message: 'safe CLI metadata' })
  for (
    const value of [[project], { projects: [{ ...project, name: 'TheOU' }] }, {
      projects: [{ ...project, ref: 'wrong' }],
    }, { projects: [{ ...project, linked: false }] }]
  ) assert.throws(() => confirmT08Project(value))
})
type Engine = Awaited<ReturnType<typeof postFixture>>
interface Options {
  failSave?: boolean
  privacy?: boolean
  badDeleted?: boolean
  failAuth?: boolean
  drift?: boolean
  failLogout?: boolean
  lostSave?: boolean
  cursorChange?: Record<string, unknown>
  dropDeleteAt?: number
  blockDeleteAt?: number
  delayDelete?: boolean
}
async function harness(f: Engine, options: Options = {}) {
  await f.reset()
  const postA = await f.seed(), postB = await f.seed({ author: b })
  await f.db.query(
    "insert into comments(post_id,author_id,body,idempotency_key) values ($1,$2,'Protected OP offline',$3),($1,$4,'Protected deleted offline',$5)",
    [postA, a, randomUUID(), b, randomUUID()],
  )
  await f.db.query("update comments set status='DELETED' where author_id=$1", [
    b,
  ])
  const logs: string[] = [], actions: string[] = [], writes: string[] = []
  let saved: CommentInventory | undefined,
    saveCount = 0,
    loggedOut = 0,
    snapshots = 0,
    offsetCursors = 0
  const snapshot = async (record?: CommentInventory | null) => {
    await f.db.exec('reset role; begin read only')
    let result: CommentBaseline
    try {
      const row = (await f.db.query<{ snapshot: CommentBaseline; fixtureScopeMatches?: boolean }>(
        record ? commentResumeSnapshotSql(record) : commentSnapshotSql,
      )).rows[0]
      if (record) assert.equal(row.fixtureScopeMatches, true, 'SQL exact fixture scope')
      result = row.snapshot
    } finally {
      await f.db.exec('rollback; set role service_role')
    }
    snapshots++
    if (options.drift && snapshots > 1) {
      result.posts[0].immutableHash = 'f'.repeat(32)
    }
    return result
  }
  const store = {
    async save(record: CommentInventory) {
      if (
        options.failSave ||
        options.lostSave &&
          record.fixtures.some((f) => f.label === 'lost' && f.ids.length)
      ) throw new Error('private disk error')
      validateCommentInventory(record)
      saved = structuredClone(record)
      saveCount++
    },
  }
  const request: typeof fetch = async (input, init) => {
    const url = new URL(String(input)),
      headers = new Headers(init?.headers),
      body = init?.body ? JSON.parse(String(init.body)) : null
    assert.equal(url.origin, env.THEOU_AUTH_SUPABASE_URL)
    assert.equal(headers.get('apikey'), env.THEOU_AUTH_PUBLISHABLE_KEY)
    assert.equal(init?.redirect, 'error')
    assert.equal(init?.credentials, 'omit')
    if (url.pathname === '/auth/v1/token') {
      assert.equal(url.searchParams.get('grant_type'), 'password')
      if (options.failAuth) throw new Error(env.THEOU_T06_PASSWORD_A)
      const id = body.email === env.THEOU_T06_EMAIL_A ? a : b
      return Response.json({
        access_token: token(id),
        refresh_token: 'offline-refresh',
        token_type: 'bearer',
        expires_in: 3600,
        user: {
          id,
          email: body.email,
          email_confirmed_at: '2026-11-01T00:00:00Z',
        },
      })
    }
    if (url.pathname === '/auth/v1/user') {
      const id = headers.get('authorization') === `Bearer ${token(a)}` ? a : b
      return Response.json({
        id,
        email: id === a ? env.THEOU_T06_EMAIL_A : env.THEOU_T06_EMAIL_B,
        email_confirmed_at: '2026-11-01T00:00:00Z',
      })
    }
    if (url.pathname === '/auth/v1/logout') {
      loggedOut++
      return options.failLogout
        ? Response.json({ code: 'unexpected_failure' }, { status: 500 })
        : new Response(null, { status: 204 })
    }
    assert.equal(url.pathname, '/functions/v1/social-api')
    actions.push(body.action)
    if (['createComment', 'deleteComment'].includes(body.action)) {
      assert.ok(saved, 'inventory must exist before first write')
      assert.equal(saved.fixtures.length, 6)
      if (body.action === 'createComment') {
        assert.ok(
          saved.fixtures.some((f) => f.key === body.payload.idempotencyKey),
        )
      } else assert.ok(saved.fixtures.some((f) => f.ids.includes(body.payload.commentId)))
      writes.push(body.action)
    }
    const deleteNumber = body.action === 'deleteComment'
      ? writes.filter((a) => a === 'deleteComment').length
      : 0
    if (deleteNumber && options.blockDeleteAt === deleteNumber) {
      return Response.json({ error: 'offline network failure' }, { status: 503 })
    }
    if (deleteNumber && options.delayDelete) await new Promise((resolve) => setTimeout(resolve, 15))
    f.state.now = Date.now() + 10
    const response = await f.handler(
      new Request(url, { method: 'POST', headers, body: JSON.stringify(body) }),
    )
    if (deleteNumber && options.dropDeleteAt === deleteNumber) {
      await response.body?.cancel()
      return Response.json({ error: 'offline lost ACK' }, { status: 503 })
    }
    if (body.action === 'listComments' && response.status === 200) {
      const r = await response.clone().json()
      if (r.data.nextCursor) {
        const claims = await decodeCommentCursor(
          r.data.nextCursor,
          body.payload.postId,
          cursorSecret,
          f.state.now,
        )
        assert.ok(claims.createdAt.endsWith('+00:00'))
        assert.equal(claims.createdAt.replace('+00:00', 'Z'), r.data.items.at(-1).createdAt)
        offsetCursors++
        if (options.cursorChange) {
          r.data.nextCursor = await signCursor({ ...claims, ...options.cursorChange }, cursorSecret)
          return Response.json(r)
        }
      }
    }
    if (
      (options.privacy || options.badDeleted) &&
      body.action === 'listComments' && response.status === 200
    ) {
      const r = await response.json()
      if (r.data.items.length) {
        if (options.privacy) r.data.items[0].authorId = a
        else r.data.items[0].id = randomUUID()
      }
      return Response.json(r)
    }
    return response
  }
  return {
    logs,
    actions,
    writes,
    snapshot,
    store,
    postA,
    postB,
    get record() {
      return saved!
    },
    get saved() {
      return saveCount
    },
    get loggedOut() {
      return loggedOut
    },
    get offsetCursors() {
      return offsetCursors
    },
    run: (mode: '--smoke' | '--write' = '--smoke', credentials: NodeJS.ProcessEnv = env) =>
      runT08Cloud(
        readT08Config(credentials, t04ProjectRef, [mode]),
        credentials,
        async () => assert.fail('no prompt with fake env'),
        store,
        snapshot,
        (line) => logs.push(line),
        request,
      ),
    resume: (
      record: CommentInventory = saved!,
      credentials: NodeJS.ProcessEnv = env,
      readSnapshot = () => snapshot(record),
    ) =>
      runT08Cloud(
        readT08Config(credentials, t04ProjectRef, ['--resume-read', record.runId]),
        credentials,
        async () => assert.fail('no prompt with fake env'),
        store,
        readSnapshot,
        (line) => logs.push(line),
        request,
        record,
      ),
    resumeDelete: (
      deleteStore: CommentDeleteStore,
      credentials: NodeJS.ProcessEnv = { ...env, THEOU_ALLOW_T08_RESUME_DELETES: 'theou-dev' },
      readSnapshot = (expected: CommentInventory | null | undefined = saved) => snapshot(expected),
    ) =>
      runT08Cloud(
        readT08Config(credentials, t04ProjectRef, ['--resume-delete', saved!.runId]),
        credentials,
        async () => assert.fail('no prompt with fake env'),
        store,
        readSnapshot,
        (line) => logs.push(line),
        request,
        saved!,
        deleteStore,
      ),
  }
}

async function resumeHarness(f: Engine) {
  const options: Options = { cursorChange: { v: 2 } }
  const h = await harness(f, options)
  // Dựng run dở chỉ trên DB tạm, dừng trước delete như inventory Cloud hiện tại.
  await assert.rejects(h.run('--write'), /T08_CURSOR_PRIVACY_SHAPE/)
  delete options.cursorChange
  h.actions.length = h.writes.length = h.logs.length = 0
  return { h, options }
}

function memoryDeleteStore(fail?: (journal: CommentDeleteJournal) => boolean) {
  let saved: CommentDeleteJournal | undefined
  return {
    get journal() {
      return saved!
    },
    async begin(record: CommentInventory) {
      assert.equal(saved, undefined, 'R2 already attempted; no automatic replay')
      saved = prepareDeleteJournal(record)
      return structuredClone(saved)
    },
    async save(journal: CommentDeleteJournal) {
      validateDeleteJournal(journal)
      if (fail?.(journal)) throw new Error('offline private disk error')
      saved = structuredClone(journal)
    },
  }
}

test('T08 configuration/fetch guard: exact project/key/mode, independent write consent; smoke never writes or calls admin/raw tables', async () => {
  assert.throws(() =>
    readT08Config({ ...env, THEOU_ALLOW_T08_CLOUD_WRITES: '' }, t04ProjectRef, [
      '--write',
    ])
  )
  assert.throws(() => readT08Config(env, 'wrong', ['--smoke']))
  assert.throws(() =>
    readT08Config(
      { ...env, THEOU_AUTH_PUBLISHABLE_KEY: 'sb_secret_fake' },
      t04ProjectRef,
      ['--smoke'],
    )
  )
  assert.throws(() => readT08Config(env, t04ProjectRef, ['--smoke', '--write']))
  let calls = 0
  const request = guardT08Fetch(
    readT08Config(env, t04ProjectRef, ['--smoke']),
    { fixtures: [], dropKey: null, dropped: false },
    async () => {
      calls++
      return Response.json({})
    },
  )
  for (
    const path of [
      '/rest/v1/comments',
      '/auth/v1/admin/users',
      '/auth/v1/signup',
    ]
  ) {
    await assert.rejects(
      request(env.THEOU_AUTH_SUPABASE_URL + path, {
        method: 'POST',
        headers: { apikey: env.THEOU_AUTH_PUBLISHABLE_KEY },
        body: '{}',
      }),
    )
  }
  for (
    const action of [
      'createComment',
      'deleteComment',
      'createPost',
      'publishPost',
      'updateNickname',
    ]
  ) {
    await assert.rejects(
      request(env.THEOU_AUTH_SUPABASE_URL + '/functions/v1/social-api', {
        method: 'POST',
        headers: { apikey: env.THEOU_AUTH_PUBLISHABLE_KEY },
        body: JSON.stringify({ action, payload: {} }),
      }),
    )
  }
  assert.equal(calls, 0)
})

test('T08 runner SDK + HTTP handler + SQL offline; không phải Cloud concurrency', async (t) => {
  const f = await postFixture()
  t.after(() => f.db.close())
  await t.test('smoke A/B: OP/isMine/privacy/deleted/error/JWT, SQL before/after unchanged; signed cursor NOT TESTED with one visible', async () => {
    const h = await harness(f), before = await h.snapshot()
    await h.run()
    assert.deepEqual(await h.snapshot(), before)
    assert.equal(h.writes.length, 0)
    assert.equal(h.record.fixtures.length, 0)
    assert.equal(h.loggedOut, 2)
    assert.ok(
      h.logs.some((l) => l.startsWith('NOT TESTED: SIGNED_CURSOR_WRONG_POST')),
    )
    for (
      const secret of [
        a,
        b,
        token(a),
        env.THEOU_T06_EMAIL_A,
        env.THEOU_T06_PASSWORD_A,
        'offline-refresh',
      ]
    ) assert.equal(h.logs.join('\n').includes(secret), false)
  })
  await t.test('A/B labels follow existing OP ownership even when T06 credentials are reversed', async () => {
    const h = await harness(f)
    await h.run('--smoke', {
      ...env,
      THEOU_T06_EMAIL_A: env.THEOU_T06_EMAIL_B,
      THEOU_T06_PASSWORD_A: env.THEOU_T06_PASSWORD_B,
      THEOU_T06_EMAIL_B: env.THEOU_T06_EMAIL_A,
      THEOU_T06_PASSWORD_B: env.THEOU_T06_PASSWORD_A,
    })
    assert.equal(h.writes.length, 0)
    assert.ok(h.logs.some((l) => l.includes('TEST_ACTORS_A_OP_AND_B_RESOLVED_FROM_OWNERSHIP')))
  })
  await t.test('controlled write: at most six rows, idempotency/lost ACK/concurrency/ownership/pagination/SQL states; no automatic cleanup', async () => {
    const h = await harness(f)
    await h.run('--write')
    assert.ok(h.offsetCursors > 0, 'signed cursor keeps +00:00 while DTO uses Z, including microseconds')
    assert.equal(h.record.fixtures.length, 6)
    assert.equal(
      h.record.fixtures.filter((f) => f.state === 'DELETED').length,
      2,
    )
    const current = await h.snapshot()
    assert.equal(current.comments.length, 8)
    assert.equal(
      current.comments.filter((c) => c.status === 'VISIBLE').length,
      5,
    )
    assert.ok(h.logs.some((l) => l.includes('REAL_KEYSET_ASC_CURSOR_BINDING')))
    assert.ok(h.logs.some((l) => l.includes('SIMULATED_LOST_ACK')))
    assert.ok(
      h.logs.some((l) => l.includes('OWNER_CROSS_USER_CONCURRENT_DELETE')),
    )
    assert.equal(
      h.actions.some((a) => ['createPost', 'deletePost', 'updateNickname'].includes(a)),
      false,
    )
    const verify = commentVerificationSql(h.record)
    await f.db.exec('reset role; begin read only')
    await f.db.exec(verify)
    await f.db.exec('rollback; set role service_role')
    // Chạy riêng cleanup SQL chỉ trên engine tạm để chứng minh trigger/count và protected rows; runner không gọi nó.
    const cleanup = commentCleanupSql(h.record)
    assert.doesNotMatch(
      cleanup,
      /delete from public.posts|update public.posts/i,
    )
    await f.db.exec(cleanup)
    const after = await h.snapshot()
    assert.equal(after.comments.length, 2)
    for (const p of h.record.baseline.posts) {
      assert.equal(
        after.posts.find((x) => x.id === p.id)?.commentCount,
        p.commentCount,
      )
    }
    for (const c of h.record.baseline.comments) {
      assert.ok(
        after.comments.some((x) => x.id === c.id && x.rowHash === c.rowHash),
      )
    }
    await f.db.exec(cleanup) // Cleanup SQL review-only có thể retry sau đã dọn.
  })
  await t.test('cleanup mismatch/dependency rolls back, cannot touch protected data; unknown ACK requires manual recovery', async () => {
    const h = await harness(f)
    await h.run('--write')
    const r = h.record
    const row = r.fixtures.find((f) => f.state === 'VISIBLE')!
    await f.db.query("update comments set body='changed offline' where id=$1", [
      row.ids[0],
    ])
    await assert.rejects(f.db.exec(commentCleanupSql(r)), /mismatch/)
    await f.db.exec('rollback')
    assert.equal((await h.snapshot()).comments.length, 8)
    await f.db.query('update comments set body=$1 where id=$2', [
      row.body,
      row.ids[0],
    ])
    await f.db.query(
      "insert into reports(reporter_id,target_type,target_id,reason) values($1,'COMMENT',$2,'SPAM')",
      [a, row.ids[0]],
    )
    await assert.rejects(f.db.exec(commentCleanupSql(r)), /dependencies/)
    await f.db.exec('rollback')
    assert.equal((await h.snapshot()).comments.length, 8)
    const unknown = structuredClone(r)
    unknown.fixtures[0].state = 'pending'
    unknown.fixtures[0].ids = []
    assert.match(commentCleanupSql(unknown), /Unresolved inventory/)
    const stolen = structuredClone(r)
    stolen.fixtures[0].ids = [r.baseline.comments[0].id]
    assert.throws(() => commentCleanupSql(stolen), /PROTECTED_ID/)
    await f.db.query('delete from reports where target_id=$1', [row.ids[0]])
  })
  await t.test('cursor UTC normalization never admits identity fields or a mismatched tuple/version/kind/postId', async () => {
    for (
      const cursorChange of [
        { authorId: a },
        { commenterId: b },
        { email: env.THEOU_T06_EMAIL_A },
        { profileId: a },
        { jwt: token(a) },
        { metadata: { role: 'ADMIN' } },
        { v: 2 },
        { kind: 'posts' },
        { postId: randomUUID() },
        { id: randomUUID() },
        { asOf: 'invalid' },
        { createdAt: '2026-11-16T00:00:00.123457+00:00' },
      ]
    ) {
      const h = await harness(f, { cursorChange })
      await assert.rejects(h.run('--write'), /T08_CURSOR_PRIVACY_SHAPE/)
      assert.equal(h.record.fixtures.length, 6)
      assert.ok(h.record.fixtures.every((c) => c.state === 'VISIBLE' && c.ids.length === 1))
      assert.equal(h.actions.includes('deleteComment'), false)
      assert.equal(h.loggedOut, 2)
      assert.equal(h.logs.join('\n').includes(token(a)), false)
      assert.equal(h.logs.join('\n').includes(env.THEOU_T06_EMAIL_A), false)
    }
  })
  await t.test('fail closed on DTO leaks/deleted visibility/baseline drift/Auth failure; no writes', async () => {
    for (
      const options of [{ privacy: true }, { badDeleted: true }, {
        drift: true,
      }, { failAuth: true }]
    ) {
      const h = await harness(f, options)
      await assert.rejects(h.run())
      assert.equal(h.writes.length, 0)
      assert.equal(h.logs.some((l) => l.includes('PASS: T08 --smoke')), false)
      assert.equal(h.logs.join('\n').includes(env.THEOU_T06_PASSWORD_A), false)
    }
  })
  await t.test('I/O before write prevents create; ACK persistence failure retains earlier write-ahead scope; logout failure never PASS', async () => {
    const early = await harness(f, { failSave: true })
    await assert.rejects(early.run('--write'))
    assert.equal(early.writes.length, 0)
    const lost = await harness(f, { lostSave: true })
    await assert.rejects(lost.run('--write'))
    assert.equal(lost.record.fixtures.length, 6)
    assert.ok(lost.record.fixtures.find((f) => f.label === 'lost'))
    const logout = await harness(f, { failLogout: true })
    await assert.rejects(logout.run())
    assert.equal(
      logout.logs.some((l) => l.includes('PASS: T08 --smoke')),
      false,
    )
  })
  await t.test('file inventory contains baseline/hashes/fixture scope, SQL never auto executes and files are atomic', async () => {
    const h = await harness(f)
    await h.run('--write')
    const directory = await mkdtemp(join(tmpdir(), 'theou-t08-'))
    try {
      const store = fileCommentInventory(pathToFileURL(directory + '/'))
      await store.save(h.record)
      const raw = await readFile(
        join(directory, h.record.runId + '.json'),
        'utf8',
      )
      assert.deepEqual(JSON.parse(raw), h.record)
      for (
        const secret of [
          a,
          b,
          token(a),
          env.THEOU_T06_EMAIL_A,
          env.THEOU_T06_PASSWORD_A,
        ]
      ) assert.equal(raw.includes(secret), false)
      assert.match(
        await readFile(
          join(directory, h.record.runId + '.cleanup.sql'),
          'utf8',
        ),
        /Runner NEVER executes DELETE/,
      )
      const tampered = structuredClone(h.record)
      tampered.fixtures[0].authorHash = 'bad'
      assert.throws(() => validateCommentInventory(tampered))
      tampered.fixtures[0].authorHash = digest(a)
      tampered.fixtures[0].body = "' SQL injection"
      assert.throws(() => validateCommentInventory(tampered))
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})

test('CommentPublic exact seven fields rejects owner UUID/metadata/unknown labels', () => {
  const c = {
    id: randomUUID(),
    postId: randomUUID(),
    body: 'offline',
    authorLabel: 'Chủ bài',
    isOriginalPoster: true,
    isMine: false,
    createdAt: '2026-11-17T00:00:00.123456Z',
  }
  assert.deepEqual(publicComment(c), c)
  for (
    const value of [
      { ...c, authorId: a },
      { ...c, email: env.THEOU_T06_EMAIL_A },
      { ...c, userMetadata: {} },
      { ...c, authorLabel: 'Nickname' },
      { ...c, body: '' },
    ]
  ) assert.throws(() => publicComment(value))
})

test('Comment cursor HMAC precedes claims validation; UTC/microseconds, post binding, version/kind, expiry and privacy', async () => {
  const postId = randomUUID(), id = randomUUID()
  const now = Date.parse('2026-11-17T12:00:00Z')
  const tuple = { postId, id, asOf: now, createdAt: '2026-11-17T11:59:59.123456+00:00' }
  const cursor = await encodeCommentCursor(tuple, cursorSecret)
  const claims = await decodeCommentCursor(cursor, postId, cursorSecret, now)
  assert.deepEqual(claims, { v: 1, kind: 'comments', ...tuple })
  assert.deepEqual(Object.keys(claims).sort(), ['asOf', 'createdAt', 'id', 'kind', 'postId', 'v'])
  assert.notEqual(claims.id, a)
  assert.notEqual(claims.postId, a)
  const utc = await encodeCommentCursor(
    { ...tuple, createdAt: tuple.createdAt.replace('+00:00', 'Z') },
    cursorSecret,
  )
  const decoded = await decodeCommentCursor(utc, postId, cursorSecret, now)
  assert.equal(claims.createdAt.replace('+00:00', 'Z'), decoded.createdAt)
  assert.notEqual(claims.createdAt.replace('+00:00', 'Z'), decoded.createdAt.replace('123456', '123457'))
  await decodeCommentCursor(cursor, postId, cursorSecret, now + 900_000)
  await assert.rejects(decodeCommentCursor(cursor, postId, cursorSecret, now + 900_001))
  await assert.rejects(decodeCommentCursor(cursor, randomUUID(), cursorSecret, now))
  const forged = Buffer.from(JSON.stringify({ ...claims, postId: randomUUID() })).toString('base64url') +
    '.' + cursor.split('.')[1]
  await assert.rejects(decodeCommentCursor(forged, postId, cursorSecret, now))
  await assert.rejects(decodeCommentCursor('invalid', postId, cursorSecret, now))
  for (
    const change of [
      { v: 2 },
      { kind: 'posts' },
      { authorId: a },
      { commenterId: b },
      { email: env.THEOU_T06_EMAIL_A },
      { profileId: a },
      { jwt: token(a) },
      { metadata: {} },
      { createdAt: 'invalid' },
      { asOf: now + 60_001 },
    ]
  ) {
    const invalid = await signCursor({ ...claims, ...change }, cursorSecret)
    await assert.rejects(decodeCommentCursor(invalid, postId, cursorSecret, now))
  }
})

test('T08 resume read-only args/network allowlist and inventory loading never permit mutations or path traversal', async () => {
  const runId = 'a'.repeat(32)
  const config = readT08Config({ ...env, THEOU_ALLOW_T08_CLOUD_WRITES: '' }, t04ProjectRef, [
    '--resume-read',
    runId,
  ])
  assert.equal(config.runId, runId)
  for (
    const args of [
      ['--resume-read'],
      ['--resume-read', '../invalid'],
      ['--resume-read', runId, '--write'],
      ['--resume-read', 'A'.repeat(32)],
      ['--resume-read', randomUUID()],
    ]
  ) assert.throws(() => readT08Config(env, t04ProjectRef, args))
  let calls = 0
  const request = guardT08Fetch(config, { fixtures: [], dropKey: null, dropped: false }, async () => {
    calls++
    return Response.json({})
  })
  for (
    const action of [
      'createComment',
      'deleteComment',
      'createPost',
      'publishPost',
      'updateNickname',
      '__t04_unknown__',
    ]
  ) {
    await assert.rejects(
      request(config.url + '/functions/v1/social-api', {
        method: 'POST',
        headers: { apikey: config.publishableKey },
        body: JSON.stringify({ action, payload: {} }),
      }),
      /T08_SMOKE_NO_BUSINESS_WRITES/,
    )
  }
  for (const path of ['/rest/v1/comments', '/auth/v1/admin/users', '/auth/v1/signup', '/auth/v1/otp']) {
    await assert.rejects(
      request(config.url + path, { method: 'POST', headers: { apikey: config.publishableKey }, body: '{}' }),
    )
  }
  assert.equal(calls, 0)
  const directory = await mkdtemp(join(tmpdir(), 'theou-t08-resume-'))
  try {
    const url = pathToFileURL(directory + '/')
    await assert.rejects(readCommentInventory('../invalid', url), /T08_RESUME_RUN_ID/)
    await assert.rejects(readCommentInventory(runId, url), /T08_RESUME_INVENTORY_READ/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('T08 resume existing six fixtures — real handler/SDK/SQL offline, no Cloud', async (t) => {
  const f = await postFixture()
  t.after(() => f.db.close())
  await t.test('resume preserves original inventory/baseline and current rows, signed pagination/privacy/cross-post for A/B reversed', async () => {
    const { h } = await resumeHarness(f)
    const original = structuredClone(h.record), before = await h.snapshot(), saves = h.saved
    const result = await h.resume(h.record, {
      ...env,
      THEOU_ALLOW_T08_CLOUD_WRITES: '',
      THEOU_T06_EMAIL_A: env.THEOU_T06_EMAIL_B,
      THEOU_T06_PASSWORD_A: env.THEOU_T06_PASSWORD_B,
      THEOU_T06_EMAIL_B: env.THEOU_T06_EMAIL_A,
      THEOU_T06_PASSWORD_B: env.THEOU_T06_PASSWORD_A,
    })
    assert.deepEqual(result, original)
    assert.deepEqual(h.record, original)
    assert.equal(h.saved, saves)
    assert.deepEqual(await h.snapshot(), before)
    assert.equal(h.writes.length, 0)
    assert.ok(h.actions.every((a) => ['getMe', 'getPost', 'listComments'].includes(a)))
    assert.equal(h.loggedOut, 4)
    for (
      const stage of [
        'RESUME_A_LIMIT1',
        'RESUME_B_LIMIT1',
        'RESUME_REAL_SIGNED_CURSOR_CROSS_POST_DENIED_400',
        'RESUME_SQL_BEFORE_AFTER_IDENTICAL',
        'T08 --resume-read',
      ]
    ) {
      assert.ok(h.logs.some((line) => line.includes(stage)))
    }
    for (
      const secret of [
        a,
        b,
        token(a),
        token(b),
        env.THEOU_T06_EMAIL_A,
        env.THEOU_T06_PASSWORD_A,
        'Nickname A',
      ]
    ) {
      assert.equal(h.logs.join('\n').includes(secret), false)
    }
    const directory = await mkdtemp(join(tmpdir(), 'theou-t08-resume-'))
    try {
      const url = pathToFileURL(directory + '/')
      await fileCommentInventory(url).save(original)
      const raw = await readFile(join(directory, original.runId + '.json'), 'utf8')
      assert.deepEqual(await readCommentInventory(original.runId, url), original)
      assert.equal(await readFile(join(directory, original.runId + '.json'), 'utf8'), raw)
      const wrongName = 'f'.repeat(32)
      await writeFile(join(directory, wrongName + '.json'), raw)
      await assert.rejects(readCommentInventory(wrongName, url), /T08_RESUME_INVENTORY_RUN_ID/)
      await writeFile(join(directory, wrongName + '.json'), '{broken')
      await assert.rejects(readCommentInventory(wrongName, url), /T08_RESUME_INVENTORY_READ/)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
  await t.test('inventory/fixture drift fails before Auth, never rebaselines or saves', async () => {
    const { h } = await resumeHarness(f), original = structuredClone(h.record), saves = h.saved
    const variants: CommentInventory[] = []
    for (const field of ['key', 'postId', 'body', 'authorHash', 'state', 'ids'] as const) {
      const r = structuredClone(original)
      Object.assign(r.fixtures[0], {
        [field]: field === 'ids'
          ? [randomUUID()]
          : field === 'state'
          ? 'pending'
          : field === 'authorHash'
          ? 'f'.repeat(32)
          : field === 'body'
          ? 'wrong run'
          : randomUUID(),
      })
      variants.push(r)
    }
    const missing = structuredClone(original)
    missing.fixtures.pop()
    variants.push(missing)
    const duplicate = structuredClone(original)
    duplicate.fixtures[0].label = duplicate.fixtures[1].label
    variants.push(duplicate)
    const protectedRow = structuredClone(original)
    protectedRow.baseline.comments[0].rowHash = 'f'.repeat(32)
    variants.push(protectedRow)
    const wrongRun = structuredClone(original)
    wrongRun.runId = 'f'.repeat(32)
    variants.push(wrongRun)
    for (const r of variants) await assert.rejects(h.resume(r))
    assert.equal(h.actions.length, 0)
    assert.equal(h.writes.length, 0)
    assert.equal(h.loggedOut, 2)
    assert.equal(h.saved, saves)
    assert.deepEqual(h.record, original)
  })
  await t.test('resume SQL compares exact fixture UUID/key/body/post/author/status with no mutation', async () => {
    const { h } = await resumeHarness(f)
    const original = structuredClone(h.record)
    const sqlResult = async (record: CommentInventory) => {
      await f.db.exec('reset role; begin read only')
      try {
        return (await f.db.query<{ fixtureScopeMatches: boolean }>(commentResumeSnapshotSql(record))).rows[0]
          .fixtureScopeMatches
      } finally {
        await f.db.exec('rollback; set role service_role')
      }
    }
    assert.equal(await sqlResult(original), true)
    for (
      const change of [
        { ids: [randomUUID()] },
        { key: randomUUID() },
        { postId: h.postB },
        { authorHash: digest(b) },
        { state: 'DELETED' },
        { label: 'changed', body: original.marker + ' changed' },
      ]
    ) {
      const record = structuredClone(original)
      Object.assign(record.fixtures[0], change)
      assert.equal(await sqlResult(record), false)
    }
    assert.equal(h.writes.length, 0)
  })
  await t.test('actual DB drift/missing fixture/protected changes/count mismatch fail before Auth', async () => {
    const { h } = await resumeHarness(f), original = structuredClone(h.record)
    for (
      const change of [
        (s: CommentBaseline) => {
          s.comments = s.comments.filter((c) => c.id !== original.fixtures[0].ids[0])
        },
        (s: CommentBaseline) => {
          s.comments.find((c) => c.id === original.fixtures[0].ids[0])!.id = randomUUID()
        },
        (s: CommentBaseline) => {
          s.comments.find((c) => c.id === original.fixtures[0].ids[0])!.bodyHash = 'f'.repeat(32)
        },
        (s: CommentBaseline) => {
          s.comments.find((c) => c.id === original.baseline.comments[0].id)!.rowHash = 'f'.repeat(32)
        },
        (s: CommentBaseline) => {
          s.posts[0].immutableHash = 'f'.repeat(32)
        },
        (s: CommentBaseline) => {
          s.posts[0].commentCount++
        },
        (s: CommentBaseline) => {
          s.profileHash = 'f'.repeat(32)
        },
      ]
    ) {
      const snapshot = await h.snapshot()
      change(snapshot)
      await assert.rejects(h.resume(original, env, async () => snapshot))
    }
    assert.equal(h.actions.length, 0)
    assert.equal(h.loggedOut, 2)
    assert.equal(h.writes.length, 0)
  })
  await t.test('privacy leaks, cursor tuple mismatch and after-read DB drift stop resume without modifying inventory', async () => {
    for (const fault of ['privacy', 'cursor', 'drift'] as const) {
      const { h, options } = await resumeHarness(f), saves = h.saved
      if (fault === 'privacy') options.privacy = true
      if (fault === 'cursor') options.cursorChange = { createdAt: '2026-11-16T00:00:00.123457+00:00' }
      let snapshots = 0
      await assert.rejects(h.resume(h.record, env, async () => {
        const s = await h.snapshot()
        if (fault === 'drift' && ++snapshots > 1) {
          s.comments.find((c) => c.id === h.record.fixtures[0].ids[0])!.rowHash = 'f'.repeat(32)
        }
        return s
      }))
      assert.equal(h.saved, saves)
      assert.equal(h.writes.length, 0)
      assert.equal(h.loggedOut, 4)
      assert.ok(h.record.fixtures.every((c) => c.state === 'VISIBLE'))
    }
  })
})

test('T08 R2 riêng flag và exact UUID network scope, không mở create hoặc dữ liệu cũ', async () => {
  const runId = 'a'.repeat(32)
  assert.throws(() => readT08Config(env, t04ProjectRef, ['--resume-delete', runId]), /APPROVAL_REQUIRED/)
  const config = readT08Config(
    { ...env, THEOU_ALLOW_T08_CLOUD_WRITES: '', THEOU_ALLOW_T08_RESUME_DELETES: 'theou-dev' },
    t04ProjectRef,
    ['--resume-delete', runId],
  )
  assert.throws(() =>
    readT08Config({ ...env, THEOU_ALLOW_T08_RESUME_DELETES: 'TheOU-dev' }, t04ProjectRef, [
      '--resume-delete',
      runId,
    ])
  )
  const fixtures = ['retry', 'parallel-b', 'same-key-race'].map((label) => ({
    label,
    ids: [randomUUID()],
    key: randomUUID(),
    body: '',
    postId: randomUUID(),
    authorHash: digest(a),
    state: 'VISIBLE' as const,
  }))
  let calls = 0
  const guard = guardT08Fetch(config, { fixtures, dropped: false, dropKey: null }, async () => {
    calls++
    return Response.json({})
  })
  const send = (action: string, payload: unknown) =>
    guard(config.url + '/functions/v1/social-api', {
      method: 'POST',
      headers: { apikey: config.publishableKey },
      body: JSON.stringify({ action, payload }),
    })
  for (const f of fixtures.slice(0, 2)) await send('deleteComment', { commentId: f.ids[0] })
  for (
    const payload of [
      { commentId: fixtures[2].ids[0] },
      { commentId: randomUUID() },
      { commentId: fixtures[0].ids[0], authorId: a },
      {},
      null,
    ]
  ) {
    await assert.rejects(send('deleteComment', payload), /T08_R2_DELETE_UUID_SCOPE/)
  }
  for (const action of ['createComment', 'createPost', 'publishPost', 'updateNickname', '__t04_unknown__']) {
    await assert.rejects(
      send(action, { commentId: fixtures[0].ids[0], idempotencyKey: fixtures[0].key }),
      /T08_R2_DELETE_UUID_SCOPE/,
    )
  }
  for (const path of ['/rest/v1/comments', '/auth/v1/admin/users', '/auth/v1/signup', '/auth/v1/otp']) {
    await assert.rejects(
      guard(config.url + path, { method: 'POST', headers: { apikey: config.publishableKey } }),
    )
  }
  assert.equal(calls, 2)
})

test('T08 R2 local only — controlled deletes, checkpoint/recovery, no Cloud', async (t) => {
  const f = await postFixture()
  t.after(() => f.db.close())
  await t.test('cross-owner 404, concurrent 3x, own/replay single delta; preserve R1 and all other comments', async () => {
    const { h, options } = await resumeHarness(f)
    options.delayDelete = true
    const store = memoryDeleteStore(),
      original = structuredClone(h.record),
      before = await h.snapshot(),
      saves = h.saved
    await h.resumeDelete(store)
    assert.deepEqual(h.record, original)
    assert.equal(h.saved, saves)
    assert.equal(store.journal.status, 'COMPLETED')
    assert.equal(store.journal.uncertain, false)
    assert.equal(h.writes.length, 7)
    assert.ok(h.writes.every((action) => action === 'deleteComment'))
    assert.equal(store.journal.events.filter((e) => e.stage === 'RACE_RETRY' && e.phase === 'ACK').length, 3)
    for (const stage of ['CROSS_B_RETRY', 'CROSS_A_PARALLEL_B'] as const) {
      assert.ok(
        store.journal.events.some((e) =>
          e.stage === stage && e.phase === 'ACK' && e.code === 'NOT_FOUND' && e.http === 404
        ),
      )
      const s = store.journal.events.find((e) =>
        e.stage === stage && e.phase === 'VERIFIED'
      )!.observation!.snapshot
      assert.equal(s.comments.filter((c) => c.status === 'VISIBLE').length, 7)
    }
    const after = await h.snapshot()
    assert.equal(after.comments.length, 8)
    assert.equal(after.comments.filter((c) => c.status === 'VISIBLE').length, 5)
    assert.equal(after.comments.filter((c) => c.status === 'DELETED').length, 3)
    const race = store.journal.events.find((e) => e.stage === 'RACE_RETRY' && e.phase === 'VERIFIED')!
      .observation!
    assert.equal(race.snapshot.comments.filter((c) => c.status === 'VISIBLE').length, 6)
    assert.equal(race.snapshot.posts.find((p) => p.id === h.postA)!.commentCount, 6)
    assert.equal(after.posts.find((p) => p.id === h.postA)!.commentCount, 5)
    assert.ok(after.posts.every((p) => p.commentCount >= 0 && p.commentCount === p.visibleCount))
    const changedIds = original.fixtures.filter((c) => ['retry', 'parallel-b'].includes(c.label)).flatMap((
      c,
    ) => c.ids)
    for (const c of before.comments.filter((c) => !changedIds.includes(c.id))) {
      assert.deepEqual(after.comments.find((r) => r.id === c.id), c)
    }
    assert.equal(h.loggedOut, 4)
    assert.ok(h.logs.some((line) => line.startsWith('PASS: T08 --resume-delete')))
    for (const secret of [a, b, token(a), env.THEOU_T06_EMAIL_A, env.THEOU_T06_PASSWORD_A]) {
      assert.equal(h.logs.join('\n').includes(secret), false)
    }
  })
  await t.test('lost concurrent ACK waits all requests, observes DB, stops before next batch, blocks re-execution', async () => {
    const { h, options } = await resumeHarness(f)
    options.dropDeleteAt = 3
    options.delayDelete = true
    const store = memoryDeleteStore()
    await assert.rejects(h.resumeDelete(store), /T08_R2_REQUEST_UNRESOLVED_NO_REPLAY/)
    assert.equal(h.writes.length, 5)
    assert.equal(store.journal.status, 'FAILED')
    assert.equal(store.journal.uncertain, true)
    const recovery = store.journal.events.findLast((e) => e.stage === 'RECOVERY' && e.observation)!
      .observation!
    assert.equal(recovery.inventory.fixtures.find((c) => c.label === 'retry')!.state, 'DELETED')
    assert.equal(recovery.inventory.fixtures.find((c) => c.label === 'parallel-b')!.state, 'VISIBLE')
    assert.equal(recovery.snapshot.comments.filter((c) => c.status === 'VISIBLE').length, 6)
    const writes = h.writes.length
    await assert.rejects(h.resumeDelete(store))
    assert.equal(h.writes.length, writes)
    assert.ok(h.record.fixtures.every((c) => c.state === 'VISIBLE'))
  })
  await t.test('own delete timeout before/after server commit yields actual partial states; never auto replay', async () => {
    for (const fault of ['blockDeleteAt', 'dropDeleteAt'] as const) {
      const { h, options } = await resumeHarness(f)
      options[fault] = 6
      const store = memoryDeleteStore()
      await assert.rejects(h.resumeDelete(store))
      assert.equal(h.writes.length, 6)
      const recovery = store.journal.events.findLast((e) => e.stage === 'RECOVERY' && e.observation)!
        .observation!
      assert.equal(
        recovery.inventory.fixtures.find((c) => c.label === 'parallel-b')!.state,
        fault === 'dropDeleteAt' ? 'DELETED' : 'VISIBLE',
      )
      assert.equal(
        recovery.snapshot.comments.filter((c) => c.status === 'VISIBLE').length,
        fault === 'dropDeleteAt' ? 5 : 6,
      )
      assert.equal(store.journal.status, 'FAILED')
      assert.equal(store.journal.uncertain, true)
      assert.equal(h.loggedOut, 4)
    }
  })
  await t.test('checkpoint I/O before send or after ACK stops mutations; recovery uses observed SQL without overwriting original', async () => {
    for (const phase of ['INTENT', 'ACK'] as const) {
      const { h } = await resumeHarness(f)
      let failed = false
      const store = memoryDeleteStore((j) => {
        if (!failed && j.events.some((e) => e.stage === 'RACE_RETRY' && e.phase === phase)) {
          failed = true
          return true
        }
        return false
      })
      await assert.rejects(h.resumeDelete(store))
      assert.equal(h.writes.length, phase === 'INTENT' ? 2 : 5)
      assert.equal(store.journal.status, 'FAILED')
      assert.ok(store.journal.events.some((e) => e.stage === 'RECOVERY' && e.phase === 'VERIFIED'))
      assert.ok(h.record.fixtures.every((c) => c.state === 'VISIBLE'))
    }
  })
  await t.test('baseline drift and denied journal begin stop before mutation; existing R2 never silently resets', async () => {
    const { h } = await resumeHarness(f)
    const store = memoryDeleteStore()
    const changed = await h.snapshot()
    changed.posts[0].immutableHash = 'f'.repeat(32)
    await assert.rejects(
      h.resumeDelete(store, { ...env, THEOU_ALLOW_T08_RESUME_DELETES: 'theou-dev' }, async () => changed),
    )
    assert.equal(h.writes.length, 0)
    assert.equal(store.journal, undefined)
    const blocked: CommentDeleteStore = {
      async begin() {
        throw new Error('existing journal')
      },
      async save() {
        assert.fail('must not save')
      },
    }
    await assert.rejects(h.resumeDelete(blocked))
    assert.equal(h.writes.length, 0)
  })
  await t.test('separate atomic artifacts preserve original; EEXIST prevents new attempts, completed SQL uses actual DELETED states', async () => {
    const { h } = await resumeHarness(f)
    const directory = await mkdtemp(join(tmpdir(), 'theou-t08-r2-'))
    const url = pathToFileURL(directory + '/')
    try {
      await fileCommentInventory(url).save(h.record)
      const original = await Promise.all(
        ['json', 'verify.sql', 'cleanup.sql'].map((s) =>
          readFile(join(directory, h.record.runId + '.' + s), 'utf8')
        ),
      )
      const store = fileCommentDeleteStore(url)
      await h.resumeDelete(store)
      for (const [i, s] of ['json', 'verify.sql', 'cleanup.sql'].entries()) {
        assert.equal(await readFile(join(directory, h.record.runId + '.' + s), 'utf8'), original[i])
      }
      const ledger = JSON.parse(
        await readFile(join(directory, h.record.runId + '.r2.json'), 'utf8'),
      ) as CommentDeleteJournal
      validateDeleteJournal(ledger)
      assert.equal(ledger.status, 'COMPLETED')
      const verified = JSON.parse(
        await readFile(join(directory, h.record.runId + '.r2.verified.json'), 'utf8'),
      ) as CommentInventory
      assert.equal(verified.fixtures.filter((f) => f.state === 'DELETED').length, 2)
      assert.deepEqual(verified.baseline, h.record.baseline)
      assert.equal(
        await readFile(join(directory, h.record.runId + '.r2.verify.sql'), 'utf8'),
        commentVerificationSql(verified),
      )
      assert.equal(
        await readFile(join(directory, h.record.runId + '.r2.cleanup.sql'), 'utf8'),
        commentCleanupSql(verified),
      )
      await assert.rejects(fileCommentDeleteStore(url).begin(h.record), /EEXIST/)
      const tampered = structuredClone(ledger)
      tampered.original.baseline.users++
      assert.throws(() => validateDeleteJournal(tampered), /JOURNAL_SCOPE/)
      await assert.rejects(store.save(tampered))
      const text = JSON.stringify(ledger)
      for (const secret of [a, b, token(a), env.THEOU_T06_EMAIL_A, env.THEOU_T06_PASSWORD_A]) {
        assert.equal(text.includes(secret), false)
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
  await t.test('failed file journal retains observed partial outcome and never emits cleanup approval/artifact', async () => {
    const { h, options } = await resumeHarness(f)
    options.dropDeleteAt = 6
    const directory = await mkdtemp(join(tmpdir(), 'theou-t08-r2-failed-'))
    try {
      const url = pathToFileURL(directory + '/')
      await assert.rejects(h.resumeDelete(fileCommentDeleteStore(url)))
      const ledger = JSON.parse(
        await readFile(join(directory, h.record.runId + '.r2.json'), 'utf8'),
      ) as CommentDeleteJournal
      assert.equal(ledger.status, 'FAILED')
      assert.equal(ledger.uncertain, true)
      const actual = ledger.events.findLast((e) => e.observation)!.observation!.inventory
      assert.equal(actual.fixtures.filter((c) => c.state === 'DELETED').length, 2)
      assert.equal(
        await readFile(join(directory, h.record.runId + '.r2.verify.sql'), 'utf8'),
        commentVerificationSql(actual),
      )
      await assert.rejects(readFile(join(directory, h.record.runId + '.r2.cleanup.sql')), /ENOENT/)
      await assert.rejects(readFile(join(directory, h.record.runId + '.r2.verified.json')), /ENOENT/)
      await assert.rejects(fileCommentDeleteStore(url).begin(h.record), /EEXIST/)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
