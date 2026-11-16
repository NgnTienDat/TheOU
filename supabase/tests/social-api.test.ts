import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { createClient, type User } from '@supabase/supabase-js'
import { createSocialApiHandler } from '../functions/social-api/handler.ts'
import { createSupabaseClients, readAllowedOrigins } from '../functions/social-api/shared/clients.ts'
import type { Profile } from '../functions/social-api/modules/profile/get-me.ts'

// Chỉ dữ liệu giả; fetch bên dưới không bao giờ truy cập mạng.
const userId = '00000000-0000-4000-8000-000000000001'
const otherId = '00000000-0000-4000-8000-000000000002'
const email = 'offline.student@ou.edu.vn'
const token = 'eyJhbGciOiJFUzI1NiJ9.offline.signature'
const publishableKey = 'sb_publishable_offline_only'
const serviceKey = 'offline_server_key_never_return'
const origin = 'http://localhost:5173'
const sensitive = `${email} ${userId} ${token} ${serviceKey} SELECT * FROM auth.users password_hash`

interface Reply { status: number; body: unknown }
interface Options {
  user?: Partial<User> | null
  authReply?: Reply
  authThrows?: boolean
  profile?: Profile | null
  profileReply?: Reply
  insertReply?: Reply
  roleReply?: Reply
  updateReply?: Reply
  banAtUpdate?: boolean
  admin?: boolean
  concurrentProfile?: Profile
  invisibleAfterInsert?: boolean
}

function fixture(options: Options = {}) {
  let profile = options.profile === undefined ? { nickname: 'OUer-offline', status: 'ACTIVE' as const } : options.profile
  let authCalls = 0
  let adminClients = 0
  let insertCalls = 0
  let isAdmin = options.admin ?? false
  const databaseCalls: { method: string; table: string; body: unknown }[] = []
  const user = options.user === null ? null : {
    id: userId, email, email_confirmed_at: '2026-11-01T00:00:00Z',
    user_metadata: { role: 'ADMIN', status: 'ACTIVE', userId: otherId },
    ...options.user,
  }
  function reply(value: Reply): Response {
    return Response.json(value.body, { status: value.status })
  }
  const fetchMock: typeof fetch = async (input, init) => {
    const url = new URL(String(input))
    const headers = new Headers(init?.headers)
    const method = init?.method ?? 'GET'
    if (url.pathname === '/auth/v1/user') {
      authCalls++
      assert.equal(method, 'GET')
      assert.equal(headers.get('apikey'), publishableKey)
      assert.equal(headers.get('authorization'), `Bearer ${token}`)
      if (options.authThrows) throw new TypeError(sensitive)
      return reply(options.authReply ?? { status: 200, body: user })
    }
    assert.equal(url.origin, 'https://offline.example.invalid')
    assert.equal(headers.get('apikey'), serviceKey)
    assert.equal(headers.get('authorization'), `Bearer ${serviceKey}`)
    assert.equal(authCalls > 0, true, 'không query DB trước Auth')
    const table = url.pathname.replace('/rest/v1/', '')
    const body: unknown = init?.body ? JSON.parse(String(init.body)) : null
    databaseCalls.push({ method, table, body })
    if (table === 'profiles') {
      if (method === 'PATCH') {
        assert.equal(url.searchParams.get('id'), `eq.${userId}`)
        assert.equal(url.searchParams.get('status'), 'eq.ACTIVE')
        assert.equal(url.searchParams.get('select'), 'nickname')
        assert.deepEqual(Object.keys(body as object), ['nickname'])
        if (options.updateReply) return reply(options.updateReply)
        if (options.banAtUpdate || !profile) return reply({ status: 200, body: [] })
        profile = { ...profile, nickname: (body as { nickname: string }).nickname }
        return reply({ status: 200, body: [{ nickname: profile.nickname }] })
      }
      if (method === 'GET') {
        assert.equal(url.searchParams.get('select'), 'nickname,status')
        assert.equal(url.searchParams.get('id'), `eq.${userId}`)
        return reply(options.profileReply ?? { status: 200, body: profile ? [profile] : [] })
      }
      assert.equal(method, 'POST')
      assert.equal(url.searchParams.get('on_conflict'), 'id')
      assert.match(headers.get('prefer') ?? '', /resolution=ignore-duplicates/)
      assert.doesNotMatch(headers.get('prefer') ?? '', /merge-duplicates/)
      assert.deepEqual(Object.keys(body as object).sort(), ['id', 'nickname'])
      const row = body as { id: string; nickname: string }
      assert.equal(row.id, userId)
      assert.match(row.nickname, /^OUer-[1-9][0-9]{3}$/)
      insertCalls++
      if (options.insertReply) return reply(options.insertReply)
      if (!options.invisibleAfterInsert) {
        // Mô phỏng atomic INSERT ON CONFLICT DO NOTHING, không ghi đè hàng thắng race.
        profile ??= options.concurrentProfile ?? { nickname: row.nickname, status: 'ACTIVE' }
      }
      return new Response(null, { status: 201 })
    }
    assert.equal(table, 'user_roles')
    assert.equal(method, 'GET')
    assert.equal(profile?.status, 'ACTIVE', 'BANNED không được đọc quyền admin')
    assert.equal(url.searchParams.get('select'), 'role')
    assert.equal(url.searchParams.get('user_id'), `eq.${userId}`)
    assert.equal(url.searchParams.get('role'), 'eq.ADMIN')
    return reply(options.roleReply ?? { status: 200, body: isAdmin ? [{ role: 'ADMIN' }] : [] })
  }
  const create = (key: string) => createClient('https://offline.example.invalid', key, {
    global: { fetch: fetchMock },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  })
  const handler = createSocialApiHandler({
    createAuthClient: () => create(publishableKey),
    createAdminClient: () => { adminClients++; return create(serviceKey) },
    allowedOrigins: [origin, 'http://127.0.0.1:5173'],
  })
  return {
    handler, databaseCalls,
    get authCalls() { return authCalls },
    get adminClients() { return adminClients },
    get insertCalls() { return insertCalls },
    get profile() { return profile },
    set profile(value: Profile | null) { profile = value },
    set admin(value: boolean) { isAdmin = value },
  }
}

function request(body: unknown = { action: 'getMe', payload: {} }, headers: Record<string, string> = {}) {
  return new Request('https://offline.example.invalid/functions/v1/social-api', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', origin, ...headers },
    body: JSON.stringify(body),
  })
}

async function expectFailure(response: Response, status: number, code: string) {
  assert.equal(response.status, status)
  const body = await response.json()
  assert.deepEqual(Object.keys(body).sort(), ['data', 'error', 'meta'])
  assert.equal(body.data, null)
  assert.deepEqual(Object.keys(body.error).sort(), ['code', 'details', 'message'])
  assert.equal(body.error.code, code)
  assert.equal(body.error.details, null)
  assert.match(body.meta.requestId, /^[0-9a-f-]{36}$/)
  const serialized = JSON.stringify(body)
  for (const value of [email, userId, otherId, token, serviceKey, 'SELECT', 'password_hash', 'stack']) {
    assert.equal(serialized.includes(value), false, `không lộ ${value}`)
  }
  assert.equal(response.headers.get('cache-control'), 'no-store')
  return body
}

test('getMe: Auth xác minh OU confirmed + ACTIVE, allowlist DTO và masked email', async () => {
  const f = fixture()
  const response = await f.handler(request())
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('access-control-allow-origin'), origin)
  const body = await response.json()
  assert.deepEqual(body.data, { nickname: 'OUer-offline', emailMasked: '***@ou.edu.vn', isAdmin: false })
  assert.equal(body.error, null)
  assert.deepEqual(Object.keys(body.meta), ['requestId'])
  assert.deepEqual(Object.keys(body).sort(), ['data', 'error', 'meta'])
  for (const value of [email, userId, otherId, token, serviceKey, 'user_metadata', 'status']) {
    assert.equal(JSON.stringify(body).includes(value), false)
  }
  assert.equal(f.authCalls, 1)
  assert.equal(f.adminClients, 1)
  assert.equal(f.insertCalls, 0)
})

test('updateNickname: trim Unicode, đúng chính chủ, không đổi status/role và DTO chỉ nickname', async () => {
  const f = fixture()
  const response = await f.handler(request({ action: 'updateNickname', payload: { nickname: '  OUer mới 👋  ' } }))
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.deepEqual(body.data, { nickname: 'OUer mới 👋' })
  assert.equal(body.error, null)
  assert.deepEqual(f.profile, { nickname: 'OUer mới 👋', status: 'ACTIVE' })
  assert.equal(f.databaseCalls.filter(call => call.method === 'PATCH').length, 1)
  assert.equal(JSON.stringify(body).includes(userId), false)
  assert.equal(JSON.stringify(body).includes(email), false)
})

test('updateNickname: input sai/URL/control/giả userId hoặc quyền bị từ chối trước DB', async () => {
  for (const payload of [
    {}, { nickname: 5 }, { nickname: 'ab' }, { nickname: 'a'.repeat(31) },
    { nickname: 'https://evil.invalid' }, { nickname: 'www.evil.invalid' }, { nickname: 'evil.com' },
    { nickname: 'OU\nTest' }, { nickname: '\tOUer\t' }, { nickname: 'OU\u200bTest' },
    { nickname: 'OUer', userId: otherId }, { nickname: 'OUer', status: 'ACTIVE' }, { nickname: 'OUer', role: 'ADMIN' },
  ]) {
    const f = fixture()
    await expectFailure(await f.handler(request({ action: 'updateNickname', payload })), 400, 'VALIDATION_ERROR')
    assert.equal(f.adminClients, 0)
  }
  const f = fixture()
  assert.equal((await f.handler(request({ action: 'updateNickname', payload: { nickname: '👋'.repeat(30) } }))).status, 200)
})

test('updateNickname: guard JWT/OU/confirmed/BANNED và race ban, lỗi DB không rò dữ liệu', async () => {
  for (const options of [
    { profile: { nickname: 'OUer', status: 'BANNED' as const } },
    { user: { email: 'offline@example.invalid' } }, { user: { email_confirmed_at: undefined } },
    { banAtUpdate: true },
  ]) {
    const f = fixture(options)
    await expectFailure(await f.handler(request({ action: 'updateNickname', payload: { nickname: 'Tên mới' } })), 403, 'FORBIDDEN')
    assert.ok(f.databaseCalls.every(call => call.method !== 'PATCH') || options.banAtUpdate)
  }
  const missing = fixture()
  await expectFailure(await missing.handler(request({ action: 'updateNickname', payload: { nickname: 'Tên mới' } }, { authorization: '' })), 401, 'UNAUTHENTICATED')
  assert.equal(missing.adminClients, 0)
  const error = fixture({ updateReply: { status: 500, body: { message: sensitive } } })
  await expectFailure(await error.handler(request({ action: 'updateNickname', payload: { nickname: 'Tên mới' } })), 500, 'INTERNAL_ERROR')
})

test('JWT thiếu/sai cú pháp/key API không đi tới Auth hoặc DB', async () => {
  for (const authorization of ['', 'Basic abc', 'Bearer invalid', `Bearer ${publishableKey}`, 'Bearer a.b.c extra', `Bearer ${'x'.repeat(17000)}.b.c`]) {
    const f = fixture()
    await expectFailure(await f.handler(request(undefined, { authorization })), 401, 'UNAUTHENTICATED')
    assert.equal(f.authCalls, 0)
    assert.equal(f.adminClients, 0)
  }
})

test('JWT giả/hết hạn dù đúng cú pháp phải bị Auth server từ chối', async () => {
  for (const code of ['bad_jwt', 'session_not_found', 'user_not_found']) {
    const f = fixture({ authReply: { status: 401, body: { code, msg: sensitive } } })
    await expectFailure(await f.handler(request()), 401, 'UNAUTHENTICATED')
    assert.equal(f.authCalls, 1)
    assert.equal(f.adminClients, 0)
  }
})

test('Auth không có user hoặc ID sai: fail closed, không truy vấn đặc quyền', async () => {
  const malformed = fixture({ user: null })
  await expectFailure(await malformed.handler(request()), 500, 'INTERNAL_ERROR')
  assert.equal(malformed.adminClients, 0)
  for (const user of [{ id: '' }, { id: 'not-a-uuid' }]) {
    const f = fixture({ user })
    await expectFailure(await f.handler(request()), 401, 'UNAUTHENTICATED')
    assert.equal(f.adminClients, 0)
  }
})

test('domain ngoài OU, suffix/subdomain giả và email thiếu/sai đều bị chặn', async () => {
  for (const invalidEmail of [undefined, '', 'test@gmail.com', 'test@sub.ou.edu.vn', 'test@ou.edu.vn.evil', 'a b@ou.edu.vn', '@ou.edu.vn', 'a..b@ou.edu.vn', 'a@ou.edu.vn\n', `${'a'.repeat(65)}@ou.edu.vn`]) {
    const f = fixture({ user: { email: invalidEmail } })
    await expectFailure(await f.handler(request()), 403, 'FORBIDDEN')
    assert.equal(f.adminClients, 0)
  }
  const f = fixture({ user: { email: 'A@OU.EDU.VN' } })
  assert.equal((await (await f.handler(request())).json()).data.emailMasked, '***@ou.edu.vn')
})

test('email chưa xác minh/anonymous không qua guard dù metadata tự khai confirmed/admin', async () => {
  for (const user of [
    { email_confirmed_at: undefined, user_metadata: { email_verified: true, role: 'ADMIN' } },
    { email_confirmed_at: 'not-a-date' },
    { is_anonymous: true },
  ]) {
    const f = fixture({ user })
    await expectFailure(await f.handler(request()), 403, 'FORBIDDEN')
    assert.equal(f.adminClients, 0)
  }
})

test('BANNED bị từ chối dù JWT hợp lệ và có ADMIN; không sửa profile/đọc roles', async () => {
  const f = fixture({ profile: { nickname: 'Bị khóa', status: 'BANNED' }, admin: true })
  await expectFailure(await f.handler(request()), 403, 'FORBIDDEN')
  assert.equal(f.insertCalls, 0)
  assert.deepEqual(f.databaseCalls.map(c => c.table), ['profiles'])
  assert.equal(f.profile?.status, 'BANNED')
})

test('status và quyền ADMIN được đọc lại mỗi request, không cache kết quả JWT', async () => {
  const f = fixture()
  assert.equal((await (await f.handler(request())).json()).data.isAdmin, false)
  f.admin = true
  assert.equal((await (await f.handler(request())).json()).data.isAdmin, true)
  f.admin = false
  assert.equal((await (await f.handler(request())).json()).data.isAdmin, false)
  f.profile = { nickname: 'OUer-offline', status: 'BANNED' }
  await expectFailure(await f.handler(request()), 403, 'FORBIDDEN')
  assert.equal(f.authCalls, 4)
  assert.equal(f.insertCalls, 0)
})

test('ADMIN chỉ từ user_roles, không từ user_metadata hoặc request payload/header', async () => {
  for (const admin of [false, true]) {
    const f = fixture({ admin })
    const body = await (await f.handler(request(undefined, { 'x-role': admin ? 'student' : 'ADMIN' }))).json()
    assert.equal(body.data.isAdmin, admin)
  }
  for (const payload of [{ userId: otherId }, { email: 'fake@ou.edu.vn' }, { role: 'ADMIN' }, { status: 'ACTIVE' }, { isAdmin: true }]) {
    const f = fixture()
    await expectFailure(await f.handler(request({ action: 'getMe', payload })), 400, 'VALIDATION_ERROR')
    assert.equal(f.adminClients, 0)
  }
})

test('profile mới: nickname an toàn, không set status/role; gọi lại không ghi đè', async () => {
  const f = fixture({ profile: null })
  const first = await (await f.handler(request())).json()
  assert.match(first.data.nickname, /^OUer-[1-9][0-9]{3}$/)
  assert.equal(first.data.isAdmin, false)
  const second = await (await f.handler(request())).json()
  assert.deepEqual(second.data, first.data)
  assert.equal(f.insertCalls, 1)
})

test('concurrent initialization trả cùng profile, không mất nickname/status của request thắng', async () => {
  const f = fixture({ profile: null })
  const responses = await Promise.all(Array.from({ length: 12 }, () => f.handler(request())))
  assert.ok(responses.every(r => r.status === 200))
  const data = await Promise.all(responses.map(async r => (await r.json()).data))
  assert.ok(f.insertCalls > 1, 'phải có nhiều request cùng quan sát profile chưa tồn tại')
  assert.ok(data.every(row => row.nickname === data[0].nickname))
  assert.match(data[0].nickname, /^OUer-[1-9][0-9]{3}$/)
  assert.equal(f.profile?.nickname, data[0].nickname)
})

test('race: hàng đã tồn tại hoặc vừa bị BAN không bị insert khôi phục ACTIVE', async () => {
  const existing: Profile = { nickname: 'Nickname giữ nguyên', status: 'ACTIVE' }
  const f = fixture({ profile: null, concurrentProfile: existing })
  assert.equal((await (await f.handler(request())).json()).data.nickname, existing.nickname)
  const banned = fixture({ profile: null, concurrentProfile: { ...existing, status: 'BANNED' } })
  await expectFailure(await banned.handler(request()), 403, 'FORBIDDEN')
  assert.equal(banned.profile?.status, 'BANNED')
})

test('DB lỗi đọc/insert/role hoặc không thấy profile sau insert đều INTERNAL_ERROR an toàn', async () => {
  const dbError = { status: 500, body: { code: 'XX000', message: sensitive, details: sensitive, hint: sensitive } }
  for (const options of [
    { profileReply: dbError },
    { profile: null, insertReply: dbError },
    { roleReply: dbError },
    { profile: null, invisibleAfterInsert: true },
    { profileReply: { status: 200, body: [{ nickname: 'Test', status: 'UNKNOWN' }] } },
  ]) {
    const f = fixture(options)
    await expectFailure(await f.handler(request()), 500, 'INTERNAL_ERROR')
  }
})

test('Auth lỗi hệ thống/mạng/rate limit không giả thành token hợp lệ hoặc lỗi quyền', async () => {
  const original = console.error
  const logs: unknown[][] = []
  console.error = (...args: unknown[]) => { logs.push(args) }
  try {
    for (const options of [
      { authThrows: true },
      { authReply: { status: 503, body: { code: 'unexpected_failure', msg: sensitive } } },
      { authReply: { status: 429, body: { code: 'over_request_rate_limit', msg: sensitive } } },
    ]) {
      const f = fixture(options)
      await expectFailure(await f.handler(request()), 500, 'INTERNAL_ERROR')
      assert.equal(f.adminClients, 0)
    }
    assert.deepEqual(logs, [], 'SDK/handler không được log lỗi chứa thông tin nhạy cảm')
  } finally {
    console.error = original
  }
})

test('request malformed, action ngoài scope, payload thừa và method/content-type sai', async () => {
  const f = fixture()
  for (const body of [null, [], {}, { action: 'listPosts', payload: {} }, { action: 'getMe' },
    { action: 'getMe', payload: null }, { action: 'getMe', payload: [] },
    { action: 'getMe', payload: {}, userId }, { action: 'getMe', payload: {}, isAdmin: true }]) {
    await expectFailure(await f.handler(request(body)), 400, 'VALIDATION_ERROR')
  }
  await expectFailure(await f.handler(request(undefined, { 'content-type': 'text/plain' })), 400, 'VALIDATION_ERROR')
  for (const method of ['GET', 'PUT', 'DELETE']) {
    await expectFailure(await f.handler(new Request('https://offline.example.invalid', { method })), 400, 'VALIDATION_ERROR')
  }
  for (const body of ['{', '', ' '.repeat(4097), JSON.stringify({ action: 'getMe', payload: { large: 'a'.repeat(5000) } })]) {
    await expectFailure(await f.handler(new Request('https://offline.example.invalid', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body,
    })), 400, 'VALIDATION_ERROR')
  }
  assert.equal(f.authCalls, 0)
})

test('CORS: Vite preflight không Auth/DB, origin lạ/method/header bị chặn', async () => {
  const f = fixture()
  const preflight = await f.handler(new Request('https://offline.example.invalid', {
    method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'POST',
      'access-control-request-headers': 'authorization, apikey, content-type, x-client-info' },
  }))
  assert.equal(preflight.status, 204)
  assert.equal(preflight.headers.get('access-control-allow-origin'), origin)
  assert.equal(preflight.headers.get('vary'), 'Origin')
  assert.match(preflight.headers.get('access-control-allow-headers') ?? '', /authorization/)
  const denied = await f.handler(request(undefined, { origin: 'https://evil.example.invalid' }))
  await expectFailure(denied, 403, 'FORBIDDEN')
  assert.equal(denied.headers.get('access-control-allow-origin'), null)
  const invalidHeaders: Record<string, string>[] = [
    { 'access-control-request-method': 'DELETE' }, { 'access-control-request-headers': 'x-user-id' },
  ]
  for (const headers of invalidHeaders) {
    await expectFailure(await f.handler(new Request('https://offline.example.invalid', {
      method: 'OPTIONS', headers: { origin, ...headers },
    })), 400, 'VALIDATION_ERROR')
  }
  assert.equal(f.authCalls, 0)
  assert.equal(f.adminClients, 0)
  const noOrigin = request()
  noOrigin.headers.delete('origin')
  noOrigin.headers.delete('authorization')
  await expectFailure(await f.handler(noOrigin), 401, 'UNAUTHENTICATED')
})

test('requestId do server tạo, không phản chiếu input/client ID', async () => {
  const f = fixture()
  const a = await (await f.handler(request(undefined, { 'x-request-id': sensitive }))).json()
  const b = await (await f.handler(request())).json()
  assert.match(a.meta.requestId, /^[0-9a-f-]{36}$/)
  assert.notEqual(a.meta.requestId, b.meta.requestId)
  assert.equal(JSON.stringify(a).includes(sensitive), false)
})

test('config clients/env: key đặc quyền chỉ đọc khi cần; CORS không cho wildcard/path', () => {
  const reads: string[] = []
  const env: Record<string, string> = { SUPABASE_URL: 'https://offline.example.invalid',
    THEOU_PUBLISHABLE_KEY: publishableKey, SUPABASE_SERVICE_ROLE_KEY: serviceKey }
  const clients = createSupabaseClients(name => { reads.push(name); return env[name] })
  assert.equal(reads.length, 0)
  clients.createAuthClient()
  assert.equal(reads.includes('SUPABASE_SERVICE_ROLE_KEY'), false)
  clients.createAdminClient()
  assert.equal(reads.includes('SUPABASE_SERVICE_ROLE_KEY'), true)
  assert.throws(() => createSupabaseClients(() => undefined).createAuthClient())
  for (const key of [serviceKey, 'sb_secret_offline', token, 'sb_publishable_key\n']) {
    assert.throws(() => createSupabaseClients(name => name === 'THEOU_PUBLISHABLE_KEY' ? key : env[name]).createAuthClient())
  }
  assert.deepEqual(readAllowedOrigins(() => undefined), [origin, 'http://127.0.0.1:5173'])
  assert.deepEqual(readAllowedOrigins(() => 'https://theou.example.invalid'), ['https://theou.example.invalid'])
  for (const value of ['*', 'https://example.invalid/path', 'https://user:password@example.invalid', 'null', 'file:///test']) {
    assert.throws(() => readAllowedOrigins(() => value))
  }
  const config = readFileSync(new URL('../config.toml', import.meta.url), 'utf8')
  assert.match(config, /\[functions\.social-api\][\s\S]*verify_jwt = true/)
})
