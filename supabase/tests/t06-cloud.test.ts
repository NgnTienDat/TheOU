import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'
import { guardT06Fetch, publicPost, readT06Config, runT06Cloud } from '../scripts/t06-cloud-runner.ts'
import {
  check,
  cleanupSql,
  filePostInventory,
  type PostInventory,
  validateInventory,
  verificationSql,
} from '../scripts/t06-cloud-inventory.ts'
import { a, b, postFixture } from './helpers/post-fixture.ts'
import { t04ProjectRef } from '../scripts/t04-cloud-recovery.ts'

const env = {
  THEOU_ALLOW_AUTH_TESTS: 'theou-dev',
  THEOU_AUTH_SUPABASE_URL: `https://${t04ProjectRef}.supabase.co`,
  THEOU_AUTH_PUBLISHABLE_KEY: 'sb_publishable_offline',
  THEOU_ALLOW_T06_CLOUD_WRITES: 'theou-dev',
  THEOU_T06_EMAIL_A: 'offline-a@ou.edu.vn',
  THEOU_T06_PASSWORD_A: 'fake password A',
  THEOU_T06_EMAIL_B: 'offline-b+t05@ou.edu.vn',
  THEOU_T06_PASSWORD_B: 'fake password B',
}
const token = (id: string) => `eyJhbGciOiJFUzI1NiJ9.${btoa(id)}.offline`
type Engine = Awaited<ReturnType<typeof postFixture>>
interface Options {
  listFailure?: boolean
  lostCreate?: boolean
  privateDto?: boolean
  invalidSuccess?: boolean
  saveFailure?: boolean
  logoutFailure?: boolean
  emptyCursor?: boolean
}
function harness(f: Engine, options: Options = {}) {
  const logs: string[] = [], calls: { action: string; method: string }[] = []
  let inventory: PostInventory | undefined, saved = 0, lost = false, creates = 0
  const store = {
    save(record: PostInventory) {
      check(!options.saveFailure, 'OFFLINE_INVENTORY_IO')
      validateInventory(record)
      inventory = structuredClone(record)
      saved++
      return Promise.resolve()
    },
  }
  const fetchMock: typeof fetch = async (input, init) => {
    const url = new URL(String(input)),
      headers = new Headers(init?.headers),
      body = init?.body ? JSON.parse(String(init.body)) : null
    assert.equal(url.origin, env.THEOU_AUTH_SUPABASE_URL)
    assert.equal(headers.get('apikey'), env.THEOU_AUTH_PUBLISHABLE_KEY)
    assert.equal(init?.redirect, 'error')
    assert.equal(init?.credentials, 'omit')
    const method = init?.method ?? 'GET'
    if (url.pathname === '/auth/v1/token') {
      assert.equal(method, 'POST')
      assert.equal(url.searchParams.get('grant_type'), 'password')
      const id = body.email === env.THEOU_T06_EMAIL_A ? a : b
      assert.equal(body.password, id === a ? env.THEOU_T06_PASSWORD_A : env.THEOU_T06_PASSWORD_B)
      return Response.json({
        access_token: token(id),
        refresh_token: 'offline-refresh',
        token_type: 'bearer',
        expires_in: 3600,
        user: { id, email: body.email, email_confirmed_at: '2026-11-01T00:00:00Z' },
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
      assert.equal(method, 'POST')
      assert.equal(url.searchParams.get('scope'), 'local')
      return options.logoutFailure
        ? Response.json({ msg: 'offline SDK secret' }, { status: 500 })
        : new Response(null, { status: 204 })
    }
    assert.equal(url.pathname, '/functions/v1/social-api')
    assert.equal(method, 'POST')
    calls.push({ action: body.action, method })
    if (body.action === 'createPost') {
      assert.ok(inventory, 'write-ahead inventory precedes create')
      creates++
    }
    if (options.listFailure && body.action === 'listPosts') {
      return Response.json({
        data: null,
        error: { code: 'INTERNAL_ERROR', message: 'Hệ thống tạm lỗi.', details: null },
        meta: { requestId: randomUUID() },
      }, { status: 500 })
    }
    f.state.now = Date.now()
    const response = await f.handler(new Request(url, { method, headers, body: JSON.stringify(body) }))
    if (options.lostCreate && body.action === 'createPost' && !lost) {
      lost = true
      throw new Error(`lost response ${env.THEOU_T06_PASSWORD_A}`)
    }
    if (options.privateDto && body.action === 'listPosts') {
      const result = await response.json()
      result.data.items = [{ authorId: a }]
      return Response.json(result)
    }
    if (options.emptyCursor && body.action === 'listPosts') {
      const result = await response.json()
      result.data.nextCursor = 'unexpected-cursor'
      return Response.json(result)
    }
    if (options.invalidSuccess && body.action === 'createPost' && body.payload.status === 'PUBLISHED') {
      const changed = { ...body.payload }
      delete changed.status
      return await f.handler(
        new Request(url, { method, headers, body: JSON.stringify({ ...body, payload: changed }) }),
      )
    }
    return response
  }
  return {
    logs,
    calls,
    store,
    fetchMock,
    get record() {
      return inventory
    },
    get saved() {
      return saved
    },
    get creates() {
      return creates
    },
    async run(mode: '--smoke' | '--write' = '--smoke', credentials: NodeJS.ProcessEnv = env) {
      return await runT06Cloud(
        readT06Config(credentials, t04ProjectRef, [mode]),
        credentials,
        () => assert.fail('credentials are fake env; no hidden input'),
        store,
        (line) => logs.push(line),
        fetchMock,
      )
    },
  }
}

test('T06 runner guard: exact ref/URL/publishable, mode rõ ràng và cờ write độc lập', () => {
  for (const args of [[], ['--write', 'extra'], ['--cleanup']]) {
    assert.throws(() => readT06Config(env, t04ProjectRef, args))
  }
  for (
    const changes of [{ THEOU_AUTH_SUPABASE_URL: 'https://wrong.supabase.co' }, {
      THEOU_AUTH_PUBLISHABLE_KEY: 'sb_secret_offline',
    }, { THEOU_ALLOW_AUTH_TESTS: '' }]
  ) {
    assert.throws(() => readT06Config({ ...env, ...changes }, t04ProjectRef, ['--smoke']))
  }
  assert.throws(() => readT06Config(env, 'wrong', ['--smoke']))
  assert.throws(() => readT06Config({ ...env, THEOU_ALLOW_T06_CLOUD_WRITES: '' }, t04ProjectRef, ['--write']))
  assert.equal(
    readT06Config({ ...env, THEOU_ALLOW_T06_CLOUD_WRITES: '' }, t04ProjectRef, ['--smoke']).mode,
    '--smoke',
  )
})
test('guard từng request: không redirect/admin/raw table/target sai và smoke không create/publish', async () => {
  let called = 0
  const config = readT06Config(env, t04ProjectRef, ['--smoke'])
  const fetch = guardT06Fetch(config, () => {
    called++
    return Promise.resolve(Response.json({}))
  })
  const headers = { apikey: config.publishableKey, 'content-type': 'application/json' }
  for (
    const [path, action] of [['/auth/v1/admin/users', 'getMe'], ['/rest/v1/posts', 'getMe'], [
      '/functions/v1/social-api',
      'createPost',
    ], ['/functions/v1/social-api', 'publishPost']]
  ) {
    await assert.rejects(
      fetch(config.url + path, { method: 'POST', headers, body: JSON.stringify({ action, payload: {} }) }),
    )
  }
  await assert.rejects(
    fetch('https://evil.invalid/functions/v1/social-api', { method: 'POST', headers, body: '{}' }),
  )
  assert.equal(called, 0)
})

test('T06 runner + SDK + HTTP/PGlite offline; không phải Cloud', async (t) => {
  const f = await postFixture()
  t.after(() => f.db.close())
  t.beforeEach(() => f.reset())
  await t.test('smoke A/B thật qua SDK giả lập, missing/invalid JWT, list/cursor/NOT_FOUND; tuyệt đối không create hay lưu fixtures', async () => {
    const h = harness(f)
    const record = await h.run()
    assert.equal(record.fixtures.length, 0)
    assert.equal(h.saved, 0)
    assert.equal(h.creates, 0)
    assert.equal((await f.db.query<{ n: number }>('select count(*)::integer n from posts')).rows[0].n, 0)
    assert.ok(h.logs.some((l) => l.includes('SMOKE_COMPLETE_NO_POST_WRITES')))
    assert.ok(h.logs.some((l) => l.includes('T06 --smoke')))
    for (
      const secret of [
        a,
        b,
        env.THEOU_T06_EMAIL_A,
        env.THEOU_T06_EMAIL_B,
        env.THEOU_T06_PASSWORD_A,
        token(a),
        'offline-refresh',
      ]
    ) {
      assert.equal(h.logs.join('\n').includes(secret), false)
    }
  })
  await t.test('smoke INTERNAL_ERROR listPosts dừng trước writes, luôn logout; không giả PASS lỗi mạng/server', async () => {
    const h = harness(f, { listFailure: true })
    await assert.rejects(h.run('--write'), /listPosts_http=500_code=INTERNAL_ERROR/)
    assert.equal(h.creates, 0)
    assert.equal(h.saved, 0)
    assert.equal(h.logs.some((l) => l.includes('PASS: T06')), false)
    assert.ok(h.logs.some((l) => l.includes('logout')))
  })
  await t.test('chặn DTO rò identity ngay smoke và không coi malformed/error như dữ liệu hợp lệ', async () => {
    const h = harness(f, { privateDto: true })
    await assert.rejects(h.run(), /PRIVATE_IDENTITY|POST_DTO/)
    assert.equal(h.creates, 0)
    const empty = harness(f, { emptyCursor: true })
    await assert.rejects(empty.run(), /CURSOR_PRIVACY_SHAPE|EMPTY_PAGE_CURSOR/)
    assert.equal(empty.creates, 0)
  })
  await t.test('write có smoke trước, 5 post hợp lệ, idempotency/concurrency/privacy/pagination, không tự DELETE/profile/user writes', async () => {
    const h = harness(f)
    const record = await h.run('--write')
    assert.equal((await f.db.query<{ n: number }>('select count(*)::integer n from posts')).rows[0].n, 5)
    assert.equal(record.fixtures.filter((f) => f.outcome === 'ack').length, 5)
    assert.equal(record.fixtures.filter((f) => f.outcome === 'rejected').length, 10)
    assert.ok(record.fixtures.every((f) => f.postIds.length <= 1))
    assert.ok(
      h.calls.findIndex((c) => c.action === 'createPost') >
        h.calls.findIndex((c) => c.action === 'listPosts'),
    )
    assert.equal(f.calls.some((c) => c.method === 'DELETE'), false)
    assert.equal(
      f.calls.some((c) => ['profiles', 'user_roles'].includes(c.table) && c.method !== 'GET'),
      false,
    )
    assert.ok(h.logs.some((l) => l.includes('DB_ROW_COUNT_CONCURRENCY')))
    const counts = await f.db.query<{ row_count: number; outcome: string }>(verificationSql(record))
    for (const row of counts.rows) assert.equal(row.row_count, row.outcome === 'ack' ? 1 : 0)
    await f.db.exec(cleanupSql(record))
    assert.equal((await f.db.query<{ n: number }>('select count(*)::integer n from posts')).rows[0].n, 0)
    await f.db.exec(cleanupSql(record))
  })
  await t.test('mất response sau server insert: giữ pending key/body để tìm chính xác, không tự DELETE hoặc mất inventory', async () => {
    const h = harness(f, { lostCreate: true })
    await assert.rejects(h.run('--write'))
    assert.ok(h.record)
    assert.equal(h.record.fixtures[0].outcome, 'pending')
    assert.equal(h.record.fixtures[0].postIds.length, 0)
    const rows = (await f.db.query<{ n: number }>('select count(*)::integer n from posts')).rows[0].n
    assert.equal(rows, 1)
    assert.match(verificationSql(h.record), new RegExp(h.record.fixtures[0].key))
    assert.doesNotMatch(cleanupSql(h.record), /delete from/)
  })
  await t.test('I/O write-ahead lỗi dừng trước create; logout lỗi không PASS toàn runner', async () => {
    const h = harness(f, { saveFailure: true })
    await assert.rejects(h.run('--write'))
    assert.equal(h.creates, 0)
    const logout = harness(f, { logoutFailure: true })
    await assert.rejects(logout.run(), /LOGOUT_OR_INVENTORY/)
    assert.equal(logout.logs.some((l) => l.includes('PASS: T06')), false)
  })
  await t.test('negative create vô tình thành công phải ghi UUID vào inventory trước FAIL', async () => {
    const h = harness(f, { invalidSuccess: true })
    await assert.rejects(h.run('--write'), /CREATE_EXPECTED_DENIAL/)
    const unexpected = h.record!.fixtures.find((f) => f.label === 'invalid-status')
    assert.ok(unexpected?.postIds.length === 1)
    assert.match(cleanupSql(h.record!), new RegExp(unexpected.postIds[0]))
  })
  await t.test('cleanup SQL chặn content/ownership mismatch và dependent data trước mọi DELETE', async () => {
    const h = harness(f)
    const record = await h.run('--write')
    const id = record.fixtures.find((f) => f.label === 'anonymous-main')!.postIds[0]
    await f.db.query('insert into post_votes(post_id,user_id) values($1,$2)', [id, b])
    await assert.rejects(f.db.exec(cleanupSql(record)), /dependent data/)
    await f.db.exec('rollback')
    assert.equal((await f.db.query<{ n: number }>('select count(*)::integer n from posts')).rows[0].n, 5)
    await f.db.query('delete from post_votes where post_id=$1', [id])
    await f.db.query('update posts set body=$1 where id=$2', ['Content ngoài scope', id])
    await assert.rejects(f.db.exec(cleanupSql(record)), /mismatch/)
    await f.db.exec('rollback')
    assert.equal((await f.db.query<{ n: number }>('select count(*)::integer n from posts')).rows[0].n, 5)
  })
  await t.test('A/B trùng nhau bị chặn trước business actions, không tạo/xóa account', async () => {
    const h = harness(f)
    await assert.rejects(
      h.run('--smoke', { ...env, THEOU_T06_EMAIL_B: env.THEOU_T06_EMAIL_A }),
      /ACCOUNTS_MUST_DIFFER/,
    )
    assert.equal(h.calls.length, 0)
  })
})

test('inventory local atomic và SQL chỉ đúng UUID/key/body; không credentials, không delete theo domain/prefix', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'theou-t06-offline-'))
  try {
    const runId = randomUUID().replaceAll('-', '')
    const record: PostInventory = {
      projectRef: t04ProjectRef,
      runId,
      marker: `T06-CLOUD-TEST-${runId}`,
      fixtures: [],
    }
    record.fixtures.push({
      label: 'fixture',
      key: randomUUID(),
      body: record.marker + " quote's",
      postIds: [randomUUID()],
      outcome: 'ack',
    })
    const store = filePostInventory(pathToFileURL(directory + '/'))
    await store.save(record)
    assert.deepEqual(JSON.parse(await readFile(join(directory, runId + '.json'), 'utf8')), record)
    const sql = await readFile(join(directory, runId + '.cleanup.sql'), 'utf8')
    assert.match(sql, /p\.idempotency_key=f\.key/)
    assert.match(sql, /p\.body=f\.body/)
    assert.match(sql, /for update/)
    assert.doesNotMatch(
      sql,
      /auth\.users|delete from public\.(profiles|comments|post_votes)|ilike|cascade|truncate/i,
    )
    for (
      const value of [{ ...record, runId: '../escape' }, { ...record, projectRef: 'wrong' }, {
        ...record,
        password: 'secret',
      }, { ...record, fixtures: [{ ...record.fixtures[0], body: 'outside marker' }] }]
    ) assert.throws(() => validateInventory(value as PostInventory))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
test('runner kiểm tra đúng 12 field PostPublic, không chấp nhận metadata/identity/ảnh và anonymous nickname', () => {
  const post = {
    id: randomUUID(),
    tag: 'CONFESSION',
    body: 'Nội dung offline',
    displayMode: 'ANONYMOUS',
    authorLabel: 'OUer ẩn danh',
    contactUrl: null,
    publishedAt: '2026-11-16T12:00:00.123456Z',
    upvoteCount: 0,
    commentCount: 0,
    hasUpvoted: false,
    isMine: false,
    images: [],
  }
  assert.deepEqual(publicPost(post), post)
  for (
    const extra of [
      { authorId: a },
      { email: env.THEOU_T06_EMAIL_A },
      { idempotencyKey: randomUUID() },
      { metadata: { role: 'ADMIN' } },
      { images: [{ storagePath: 'private' }] },
      { authorLabel: 'Nickname bị lộ' },
      { contactUrl: 'https://zalo.me/offline' },
      { upvoteCount: -1 },
    ]
  ) {
    assert.throws(() => publicPost({ ...post, ...extra }))
  }
})
