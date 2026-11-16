import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'
import { createClient } from '@supabase/supabase-js'
import { createSocialApiHandler } from '../functions/social-api/handler.ts'
import { cleanupT04Cloud, readT04CloudConfig, runT04Cloud } from '../scripts/t04-cloud-runner.ts'
import { fileRecoveryStore, fixtureEmail, t04ProjectRef, validateRecovery, type Recovery } from '../scripts/t04-cloud-recovery.ts'

const env = { THEOU_ALLOW_T04_CLOUD_TESTS: 'theou-dev', THEOU_TEST_PROJECT_REF: t04ProjectRef,
  THEOU_TEST_SUPABASE_URL: `https://${t04ProjectRef}.supabase.co`,
  THEOU_TEST_PUBLISHABLE_KEY: 'sb_publishable_offline', THEOU_TEST_SECRET_KEY: 'sb_secret_offline' }
const config = readT04CloudConfig(env, t04ProjectRef)
const originalId = '00000000-0000-4000-8000-000000000001'
interface FakeUser { id: string; email: string; app_metadata: Record<string, unknown>; user_metadata: Record<string, unknown>; email_confirmed_at: string }
interface Row { id: string; nickname: string; status: string; created_at: string; updated_at: string }
interface Options { createFailure?: number; lostCreate?: boolean; deleteFailure?: boolean; rejectBan?: boolean; adminStale?: boolean;
  metadataEscalation?: boolean; raceMismatch?: boolean; profileOverwrite?: boolean; externalDrift?: boolean; saveFailure?: boolean; saveFailureAt?: number; manyUsers?: boolean }

function fixture(options: Options = {}) {
  const users = new Map<string, FakeUser>([[originalId, { id: originalId, email: 'real-owner@example.invalid',
    app_metadata: {}, user_metadata: {}, email_confirmed_at: '2026-01-01T00:00:00Z' }]])
  if (options.manyUsers) for (let i = 0; i < 210; i++) {
    const id = randomUUID()
    users.set(id, { id, email: `existing-${i}@example.invalid`, app_metadata: {}, user_metadata: {}, email_confirmed_at: 'confirmed' })
  }
  const originalProfile: Row = { id: originalId, nickname: 'Existing-user', status: 'ACTIVE', created_at: 'initial', updated_at: 'initial' }
  const profiles = new Map<string, Row>([[originalId, { ...originalProfile }]])
  const roles = new Set<string>([originalId])
  const tokens = new Map<string, string>()
  const passwords: string[] = []
  const fixtureEmails: string[] = []
  const logs: string[] = []
  const mutations: { method: string; path: string; id: string }[] = []
  let record: Recovery | undefined
  let creates = 0
  let logins = 0
  let saves = 0
  let raceReads = 0
  let raceInvokes = 0
  let releaseRace: () => void = () => {}
  const raceBarrier = new Promise<void>(resolve => { releaseRace = resolve })
  const store = {
    async save(value: Recovery) {
      saves++
      if (options.saveFailure || options.saveFailureAt === saves) throw new Error('raw local I/O secret')
      record = structuredClone(value)
    },
    async remove() { record = undefined },
  }
  function userFor(headers: Headers) { return users.get(tokens.get(headers.get('authorization')?.replace('Bearer ', '') ?? '') ?? '') }
  const jsonError = () => Response.json({ code: 'unexpected_failure', msg: 'raw-secret SQL SELECT' }, { status: 500 })
  let handler: ReturnType<typeof createSocialApiHandler>
  const fetchMock: typeof fetch = async (input, init) => {
    const url = new URL(String(input))
    assert.equal(url.origin, config.url)
    const headers = new Headers(init?.headers)
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : null
    const path = url.pathname
    if (path.startsWith('/auth/v1/admin/')) {
      assert.equal(headers.get('apikey'), config.secretKey)
      if (method === 'GET' && path.endsWith('/users')) {
        const page = Number(url.searchParams.get('page'))
        const size = Number(url.searchParams.get('per_page'))
        return Response.json({ users: [...users.values()].slice((page - 1) * size, page * size) })
      }
      if (method === 'GET') {
        const user = users.get(path.split('/').at(-1)!)
        return user ? Response.json(user) : Response.json({ code: 'user_not_found' }, { status: 404 })
      }
      if (method === 'POST' && path.endsWith('/users')) {
        assert.ok(record, 'manifest phải có trước createUser')
        creates++
        if (options.createFailure === creates) return jsonError()
        const user = { id: randomUUID(), email: body.email, app_metadata: body.app_metadata,
          user_metadata: {}, email_confirmed_at: '2026-11-16T00:00:00Z' }
        assert.equal(body.email_confirm, true)
        assert.match(user.email, /^theou-t04-[a-f0-9]{32}-(banned|admin|race)@ou[.]edu[.]vn$/)
        assert.ok(Buffer.byteLength(body.password) <= 72 && body.password.length >= 32)
        users.set(user.id, user)
        passwords.push(body.password)
        fixtureEmails.push(user.email)
        if (options.lostCreate && creates === 1) throw new Error('raw-secret lost create response')
        return Response.json(user)
      }
      if (method === 'DELETE') {
        const id = path.split('/').at(-1)!
        assert.notEqual(id, originalId)
        assert.ok(record?.fixtures.some(f => f.id === id))
        mutations.push({ method, path, id })
        if (options.deleteFailure) return jsonError()
        const user = users.get(id)
        users.delete(id)
        return Response.json(user)
      }
      assert.fail('Admin endpoint ngoài scope')
    }
    if (path === '/auth/v1/token') {
      assert.equal(headers.get('apikey'), config.publishableKey)
      assert.equal(url.searchParams.get('grant_type'), 'password')
      logins++
      const user = [...users.values()].find(u => u.email === body.email)!
      const token = `offline.${Buffer.from(JSON.stringify({ sub: user.id, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.signature`
      tokens.set(token, user.id)
      return Response.json({ access_token: token, refresh_token: 'offline-refresh', token_type: 'bearer', expires_in: 3600, user })
    }
    if (path === '/auth/v1/user') {
      const user = userFor(headers)
      assert.ok(user)
      if (method === 'PUT') { assert.notEqual(user.id, originalId); user.user_metadata = body.data }
      return Response.json(user)
    }
    if (path === '/auth/v1/logout') return new Response(null, { status: 204 })
    if (path.startsWith('/rest/v1/')) {
      assert.equal(headers.get('apikey'), config.secretKey)
      const table = path.split('/').at(-1)
      assert.ok(table === 'profiles' || table === 'user_roles')
      const column = table === 'profiles' ? 'id' : 'user_id'
      const id = url.searchParams.get(column)?.replace('eq.', '')
      if (method === 'HEAD') {
        const size = table === 'profiles' ? (id ? Number(profiles.has(id)) : profiles.size) : (id ? Number(roles.has(id)) : roles.size)
        return new Response(null, { headers: { 'content-range': `0-0/${size}` } })
      }
      if (method === 'GET') {
        assert.ok(id)
        if (table === 'profiles') {
          const row = profiles.get(id)
          const user = users.get(id)
          if (!row && user?.email.endsWith('-race@ou.edu.vn')) {
            raceReads++
            if (raceReads === 10) releaseRace()
            await raceBarrier
          }
          const found = row ? { ...row, status: options.rejectBan ? 'ACTIVE' : row.status } : null
          return Response.json(headers.get('accept') === 'application/vnd.pgrst.object+json' ? found : found ? [found] : [])
        }
        return Response.json(roles.has(id) && !options.adminStale ? [{ role: 'ADMIN' }] : [])
      }
      const affectedId = method === 'POST' ? (body.id ?? body.user_id) : id
      assert.ok(affectedId && affectedId !== originalId)
      assert.ok(record?.fixtures.some(f => f.id === affectedId), 'mọi write phải thuộc UUID fixture của manifest')
      mutations.push({ method, path, id: affectedId })
      if (method === 'POST') {
        if (table === 'profiles') {
          if (!profiles.has(affectedId)) profiles.set(affectedId, { ...body, status: 'ACTIVE', created_at: 'created', updated_at: 'created' })
          return new Response(null, { status: 201 })
        }
        roles.add(affectedId)
        return new Response(null, { status: 201 })
      }
      if (method === 'PATCH' && table === 'profiles') {
        const row = profiles.get(affectedId)!
        assert.equal(url.searchParams.get('status'), 'eq.ACTIVE')
        Object.assign(row, body, { updated_at: 'banned' })
        return Response.json([{ id: row.id, status: row.status }])
      }
      if (method === 'DELETE') {
        if (table === 'profiles') profiles.delete(affectedId)
        else { assert.equal(url.searchParams.get('role'), 'eq.ADMIN'); roles.delete(affectedId) }
        return new Response(null, { status: 204 })
      }
      assert.fail('DB operation ngoài scope')
    }
    if (path === '/functions/v1/social-api') {
      assert.equal(headers.get('apikey'), config.publishableKey)
      const user = userFor(headers)!
      assert.ok(user && user.id !== originalId)
      if (user.email.endsWith('-race@ou.edu.vn')) raceInvokes++
      const response = await handler(new Request(url, { method, headers, body: init?.body }))
      const value = await response.json()
      if (options.metadataEscalation && user.user_metadata.role === 'ADMIN' && value.data) value.data.isAdmin = true
      if (options.raceMismatch && user.email.endsWith('-race@ou.edu.vn') && value.data) value.data.nickname = `Different-${raceInvokes}-${randomUUID().slice(0, 4)}`
      if (options.profileOverwrite && raceInvokes > 10 && user.email.endsWith('-race@ou.edu.vn')) profiles.get(user.id)!.updated_at = 'changed'
      if (options.externalDrift && raceInvokes > 10) profiles.set('external-added', { ...originalProfile, id: 'external-added' })
      return Response.json(value, { status: response.status })
    }
    assert.fail(`Không được gọi endpoint này: ${path}`)
  }
  const sdk = (key: string) => createClient(config.url, key, { global: { fetch: fetchMock }, auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } })
  handler = createSocialApiHandler({ allowedOrigins: [], createAuthClient: () => sdk(config.publishableKey), createAdminClient: () => sdk(config.secretKey) })
  const report = (line: string) => logs.push(line)
  return { users, profiles, roles, tokens, passwords, mutations, logs, store, fetchMock, report,
    run: () => runT04Cloud(config, store, report, fetchMock), get record() { return record }, get logins() { return logins }, get raceReads() { return raceReads },
    assertOriginal() { assert.deepEqual(profiles.get(originalId), originalProfile); assert.equal(roles.has(originalId), true); assert.equal(users.has(originalId), true) },
    assertSafe() {
      const output = logs.join('\n')
      for (const value of [config.secretKey, config.publishableKey, 'raw-secret', ...passwords, ...tokens.keys(), ...fixtureEmails, ...[...users.values()].map(u => u.email)]) assert.equal(output.includes(value), false)
      if (record) assert.doesNotMatch(JSON.stringify(record), /sb_secret_|access_token|refresh_token|password|raw-secret/)
    } }
}

test('T04 guard cố định ref/URL/link, cờ riêng, không phụ thuộc Gmail hoặc cờ T02', () => {
  assert.deepEqual(readT04CloudConfig({ ...env, THEOU_OU_HOOK_ENABLED: 'true' }, t04ProjectRef), config)
  assert.throws(() => readT04CloudConfig({ ...env, THEOU_ALLOW_T04_CLOUD_TESTS: '' }, t04ProjectRef))
  assert.throws(() => readT04CloudConfig({ ...env, THEOU_TEST_SECRET_KEY: 'ey.invalid' }, t04ProjectRef))
  for (const ref of ['a'.repeat(20), 'z'.repeat(20)]) assert.throws(() => readT04CloudConfig({ ...env, THEOU_TEST_PROJECT_REF: ref, THEOU_TEST_SUPABASE_URL: `https://${ref}.supabase.co` }, ref))
  for (const url of [`${config.url}/path`, config.url.replace('https:', 'http:')]) assert.throws(() => readT04CloudConfig({ ...env, THEOU_TEST_SUPABASE_URL: url }, t04ProjectRef))
  assert.throws(() => readT04CloudConfig(env, 'wrong-ref'))
})

test('T04 offline: ba scenario qua SDK/HTTP handler thật, race 10 requests và cleanup giữ baseline', async () => {
  const f = fixture()
  try { await f.run() } catch { assert.fail(f.logs.join('\n')) }
  assert.equal(f.logins, 3, 'mỗi fixture chỉ login một lần, không thay JWT khi đổi quyền')
  assert.equal(f.raceReads, 10, '10 handler cùng đọc snapshot chưa có profile trong mock')
  assert.equal(f.users.size, 1)
  assert.equal(f.profiles.size, 1)
  assert.equal(f.roles.size, 1)
  assert.equal(f.record, undefined)
  assert.equal(f.logs.filter(l => l.startsWith('PASS:')).length, 5)
  f.assertOriginal(); f.assertSafe()
})

test('T04 không PASS khi BANNED, ADMIN, metadata hoặc race bị regression; vẫn cleanup', async () => {
  for (const options of [{ rejectBan: true }, { adminStale: true }, { metadataEscalation: true }, { raceMismatch: true }, { profileOverwrite: true }]) {
    const f = fixture(options)
    await assert.rejects(f.run(), /T04_SCENARIO_OR_LOGOUT/)
    assert.equal(f.users.size, 1)
    assert.equal(f.record, undefined)
    assert.equal(f.logs.some(l => l.startsWith('PASS: T04-B.7')), false)
    f.assertOriginal(); f.assertSafe()
  }
})

test('T04 createUser lỗi giữa chừng vẫn cleanup đúng UUID đã tạo', async () => {
  const f = fixture({ createFailure: 2 })
  await assert.rejects(f.run(), /T04_SCENARIO_OR_LOGOUT/)
  assert.equal(f.users.size, 1)
  assert.equal(f.record, undefined)
  f.assertOriginal(); f.assertSafe()
})

test('T04 baseline Auth phân trang đầy đủ, không giả số đếm từ page đầu', async () => {
  const f = fixture({ manyUsers: true })
  await f.run()
  assert.equal(f.users.size, 211)
  assert.match(f.logs[0], /users=211/)
  f.assertOriginal(); f.assertSafe()
})

test('T04 save sau createUser thất bại: write-ahead manifest vẫn đủ để cleanup', async () => {
  const f = fixture({ saveFailureAt: 2 })
  await assert.rejects(f.run(), /T04_SCENARIO_OR_LOGOUT/)
  assert.equal(f.users.size, 1)
  assert.equal(f.record, undefined)
  f.assertOriginal(); f.assertSafe()
})

test('T04 mất response createUser: recovery tìm đúng email + app marker, không chạm user có sẵn', async () => {
  const f = fixture({ lostCreate: true })
  await assert.rejects(f.run(), /T04_SCENARIO_OR_LOGOUT/)
  assert.equal(f.users.size, 1)
  assert.equal(f.record, undefined)
  f.assertOriginal(); f.assertSafe()
})

test('T04 cleanup fail giữ recovery; chạy cleanup-only idempotent không tạo/login thêm', async () => {
  const options = { deleteFailure: true }
  const f = fixture(options)
  await assert.rejects(f.run(), /CLEANUP_OR_BASELINE/)
  assert.ok(f.record)
  assert.equal(f.users.size, 4)
  assert.match(f.logs.join('\n'), /--cleanup [a-f0-9]{32}/)
  const record = structuredClone(f.record)
  options.deleteFailure = false
  await cleanupT04Cloud(config, record, f.store, f.report, f.fetchMock)
  await cleanupT04Cloud(config, record, { ...f.store, async remove() {} }, f.report, f.fetchMock)
  assert.equal(f.users.size, 1)
  assert.equal(f.logins, 3)
  f.assertOriginal(); f.assertSafe()
})

test('T04 cleanup từ chối manifest chỉ vào account thật hoặc marker sai trước mọi DELETE', async () => {
  const f = fixture({ deleteFailure: true })
  await assert.rejects(f.run())
  const record = structuredClone(f.record!)
  const before = f.mutations.length
  record.fixtures[0].id = originalId
  await assert.rejects(cleanupT04Cloud(config, record, f.store, f.report, f.fetchMock), /CLEANUP_OWNERSHIP|CLEANUP_AMBIGUOUS_USER/)
  assert.equal(f.mutations.length, before)
  const own = structuredClone(f.record!)
  f.users.get(own.fixtures[0].id!)!.app_metadata = {}
  await assert.rejects(cleanupT04Cloud(config, own, f.store, f.report, f.fetchMock), /CLEANUP_OWNERSHIP/)
  assert.equal(f.mutations.length, before)
  f.assertOriginal(); f.assertSafe()
})

test('T04 baseline drift không được PASS hoặc xóa dữ liệu người khác để bù số đếm', async () => {
  const f = fixture({ externalDrift: true })
  await assert.rejects(f.run(), /CLEANUP_OR_BASELINE/)
  assert.equal(f.users.size, 1)
  assert.equal(f.profiles.has('external-added'), true)
  assert.ok(f.record)
  f.assertOriginal(); f.assertSafe()
})

test('T04 không ghi Cloud nếu manifest recovery không ghi được', async () => {
  const f = fixture({ saveFailure: true })
  await assert.rejects(f.run())
  assert.equal(f.mutations.length, 0)
  assert.equal(f.users.size, 1)
  f.assertOriginal(); f.assertSafe()
})

test('recovery file chỉ chứa UUID/email fixture/counts, chặn traversal, wrong-ref và field bí mật', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'theou-t04-offline-'))
  try {
    const store = fileRecoveryStore(pathToFileURL(`${directory}/`))
    const runId = 'a'.repeat(32)
    const record: Recovery = { projectRef: t04ProjectRef, runId, baseline: { users: 1, profiles: 1, roles: 0 },
      fixtures: (['banned', 'admin', 'race'] as const).map(role => ({ role, email: fixtureEmail(runId, role), id: null })) }
    await store.save(record)
    record.fixtures[0].id = randomUUID()
    await store.save(record)
    assert.deepEqual(await store.read(runId), record)
    await assert.rejects(store.read('../elsewhere'))
    assert.throws(() => validateRecovery({ ...record, projectRef: 'other' }))
    assert.throws(() => validateRecovery({ ...record, secretKey: 'fake' }))
    assert.throws(() => validateRecovery({ ...record, fixtures: [{ ...record.fixtures[0], email: 'real@example.invalid' }, ...record.fixtures.slice(1)] }))
    const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
    assert.equal(packageJson.scripts['test:t04-cloud'], 'node --env-file=.env.test.local scripts/t04-cloud.ts')
    await store.remove(runId)
  } finally {
    assert.equal(dirname(directory), tmpdir())
    assert.match(basename(directory), /^theou-t04-offline-/)
    await rm(directory, { recursive: true, force: true })
  }
})
