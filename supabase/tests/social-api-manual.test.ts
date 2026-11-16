import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createClient, type Session } from '@supabase/supabase-js'
import { createSocialApiHandler } from '../functions/social-api/handler.ts'
import { runGetMeChecks } from '../scripts/social-api-manual.ts'

const config = { url: 'https://puhkisyehspcmgzerutm.supabase.co', publishableKey: 'sb_publishable_offline_only' }
const identity = { userId: '00000000-0000-4000-8000-000000000001', email: 'offline.test@ou.edu.vn', accessToken: 'offline.user.jwt' }
const meta = { requestId: '00000000-0000-4000-8000-000000000002' }
const data = { nickname: 'OUer-1234', emailMasked: '***@ou.edu.vn', isAdmin: false }
const success = () => ({ data: { ...data }, error: null, meta })
const handlerError = (code: string) => ({ data: null, error: { code, message: 'Lỗi an toàn.', details: null }, meta })
interface Reply { status: number; body?: unknown; headers?: Record<string, string>; text?: string; network?: boolean; replaceSession?: boolean; replaceUser?: boolean; dropSession?: boolean; sessionError?: boolean }

function fixture() {
  let session: Session | null = {
    access_token: identity.accessToken, refresh_token: 'offline-refresh', expires_in: 3600, token_type: 'bearer',
    user: { id: identity.userId, email: identity.email, aud: 'authenticated',
      created_at: '2026-11-16T00:00:00Z', app_metadata: {}, user_metadata: {} },
  }
  let sessionError = false
  const replies: Reply[] = [
    { status: 200, body: success() },
    { status: 200, body: success() },
    { status: 401, body: { code: 401, message: 'Missing authorization header' } },
    { status: 401, body: handlerError('UNAUTHENTICATED') },
    { status: 400, body: handlerError('VALIDATION_ERROR') },
    { status: 400, body: handlerError('VALIDATION_ERROR') },
  ]
  const calls: { url: string; headers: Headers; body: unknown }[] = []
  const logs: string[] = []
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = String(input)
    assert.equal(url, `${config.url}/functions/v1/social-api`)
    assert.equal(init?.method, 'POST')
    const headers = new Headers(init?.headers)
    assert.equal(headers.get('apikey'), config.publishableKey)
    const body: unknown = JSON.parse(String(init?.body))
    const index = calls.length
    calls.push({ url, headers, body })
    if (index === 2 || index === 3) {
      assert.equal(headers.get('authorization'), index === 2 ? null : 'Bearer invalid.jwt.signature', 'JWT negative không dùng token thật từ SDK')
      assert.equal(init?.redirect, 'error')
      assert.equal(init?.credentials, 'omit')
    } else {
      assert.equal(headers.get('authorization'), `Bearer ${identity.accessToken}`)
    }
    if (index < 4) assert.deepEqual(body, { action: 'getMe', payload: {} })
    if (index === 4) assert.deepEqual(body, { action: 'getMe', payload: null })
    if (index === 5) assert.deepEqual(body, { action: '__t04_unknown__', payload: {} })
    const reply = replies[index]
    assert.ok(reply, 'không có API/fixture ngoài sáu request đã định nghĩa')
    if (reply.network) throw new Error(`${identity.email} ${identity.accessToken}`)
    if (reply.replaceSession && session) session = { ...session, access_token: 'unexpected-new-token' }
    if (reply.replaceUser && session) session = { ...session, user: { ...session.user, id: meta.requestId } }
    if (reply.dropSession) session = null
    if (reply.sessionError) sessionError = true
    return reply.text !== undefined
      ? new Response(reply.text, { status: reply.status, headers: reply.headers })
      : Response.json(reply.body, { status: reply.status, headers: reply.headers })
  }
  const client = createClient(config.url, config.publishableKey, {
    global: { fetch: fakeFetch },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  })
  client.auth.getSession = async () => {
    if (sessionError) throw new Error(`raw-secret ${identity.accessToken}`)
    return session ? { data: { session }, error: null } : { data: { session: null }, error: null }
  }
  return { replies, calls, logs, run: () => runGetMeChecks(client, config, identity, line => logs.push(line), fakeFetch),
    get session() { return session }, set session(value: Session | null) { session = value } }
}

function assertSafeLogs(f: ReturnType<typeof fixture>) {
  const logs = f.logs.join('\n')
  for (const value of [...Object.values(identity), config.publishableKey, 'raw-secret', 'SQL SELECT', data.nickname]) {
    assert.equal(logs.includes(value), false)
  }
}

test('getMe runner: SDK invoke hai lần + bốn negative cases, không gọi Auth admin/DB', async () => {
  const f = fixture()
  await f.run()
  assert.equal(f.calls.length, 6)
  assert.equal(f.logs.filter(line => line.startsWith('PASS:')).length, 6)
  assert.match(f.logs.join('\n'), /source=gateway; code=GATEWAY_JWT_REJECTED; http=401/)
  assert.match(f.logs.join('\n'), /source=handler; code=UNAUTHENTICATED; http=401/)
  assert.match(f.logs.join('\n'), /code=VALIDATION_ERROR; http=400/)
  assertSafeLogs(f)
})

test('getMe runner: chỉ nhận đúng envelope/DTO và không rò email/UUID/token dưới field hợp lệ', async () => {
  for (const body of [
    null, [], {}, { ...success(), user: identity },
    { ...success(), data: { ...data, id: identity.userId } },
    { ...success(), data: { ...data, email: identity.email } },
    { ...success(), data: { ...data, userMetadata: {} } },
    { ...success(), data: { ...data, emailMasked: identity.email } },
    { ...success(), data: { ...data, nickname: identity.email } },
    { ...success(), data: { ...data, nickname: identity.accessToken } },
    { ...success(), data: { ...data, isAdmin: 'true' } },
    { ...success(), data: { ...data, nickname: '' } },
    { ...success(), meta: { requestId: identity.userId } },
    { ...success(), meta: { ...meta, metadata: identity } },
    { ...success(), error: { code: 'INTERNAL_ERROR' } },
  ]) {
    const f = fixture()
    f.replies[0] = { status: 200, body }
    await assert.rejects(f.run(), /social-api chưa đạt/)
    assert.equal(f.calls.length, 1)
    assert.equal(f.logs.some(line => line.startsWith('PASS:')), false)
    assertSafeLogs(f)
  }
})

test('getMe runner: nickname thay đổi giữa hai lần invoke phải FAIL, boolean ADMIN được chấp nhận', async () => {
  const changed = fixture()
  changed.replies[1] = { status: 200, body: { ...success(), data: { ...data, nickname: 'Khác biệt' } } }
  await assert.rejects(changed.run(), /social-api chưa đạt/)
  assert.equal(changed.calls.length, 2)
  assertSafeLogs(changed)
  const admin = fixture()
  for (const index of [0, 1]) admin.replies[index] = { status: 200, body: { ...success(), data: { ...data, isAdmin: true } } }
  await admin.run()
  assertSafeLogs(admin)
})

test('getMe runner: nhận diện cả handler 401 và các mẫu gateway JWT rejection đã biết', async () => {
  for (const body of [handlerError('UNAUTHENTICATED'),
    { code: 401, message: 'Invalid JWT' },
    { code: '401', message: 'Invalid JWT' },
    { code: 401, message: 'Invalid Token or Protected Header formatting' },
  ]) {
    const f = fixture()
    f.replies[3] = { status: 401, body }
    await f.run()
    assert.equal(f.calls.length, 6)
    assertSafeLogs(f)
  }
})

test('missing JWT: HTTP handler thật trả UNAUTHENTICATED/401 không cần gateway code', async () => {
  const handler = createSocialApiHandler({
    allowedOrigins: [],
    createAuthClient: () => { throw new Error('không được tạo Auth client khi thiếu JWT') },
    createAdminClient: () => { throw new Error('không được tạo DB client khi thiếu JWT') },
  })
  const response = await handler(new Request(`${config.url}/functions/v1/social-api`, {
    method: 'POST', headers: { apikey: config.publishableKey, 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'getMe', payload: {} }),
  }))
  const body = await response.json()
  assert.equal(response.status, 401)
  assert.equal(body.data, null)
  assert.equal(body.error.code, 'UNAUTHENTICATED')
  assert.equal(Object.hasOwn(body, 'code'), false)
  assert.equal(response.headers.has('sb-error-code'), false)
  const f = fixture()
  f.replies[2] = { status: response.status, body }
  await f.run()
  assert.match(f.logs.join('\n'), /PASS: JWT thiếu; source=handler; code=UNAUTHENTICATED; http=401/)
  assert.equal(f.calls.length, 6)
  assert.equal(f.session?.access_token, identity.accessToken)
  assertSafeLogs(f)
})

test('handler envelope hợp lệ được kiểm tra độc lập với header mã gateway', async () => {
  for (const index of [2, 3, 4, 5]) {
    for (const headerCode of ['UNAUTHORIZED_INVALID_JWT_FORMAT', 'UNKNOWN_GATEWAY_CODE']) {
      const f = fixture()
      f.replies[index] = { status: index < 4 ? 401 : 400,
        body: handlerError(index < 4 ? 'UNAUTHENTICATED' : 'VALIDATION_ERROR'),
        headers: { 'sb-error-code': headerCode } }
      await f.run()
      assert.equal(f.calls.length, 6)
      assertSafeLogs(f)
    }
  }
})

test('missing JWT: gateway missing-header từ body/header hoặc legacy đều PASS', async () => {
  const code = 'UNAUTHORIZED_NO_AUTH_HEADER'
  for (const reply of [
    { status: 401, body: { code, message: 'Missing authorization header' } },
    { status: 401, body: { message: 'Missing authorization header' }, headers: { 'sb-error-code': code } },
    ...[401, '401'].map(legacy => ({ status: 401, body: { code: legacy, message: 'Missing authorization header' } })),
  ]) {
    const f = fixture()
    f.replies[2] = reply
    await f.run()
    assert.match(f.logs.join('\n'), /PASS: JWT thiếu; source=gateway;/)
    assert.equal(f.session?.access_token, identity.accessToken)
    assertSafeLogs(f)
  }
})

test('handlerEnvelope=true chưa đủ: malformed error/identity phải FAIL với lý do an toàn', async () => {
  const base = handlerError('UNAUTHENTICATED')
  const cases: { reply: Reply; reason: string }[] = [
    { reply: { status: 401, body: { ...base, error: { code: 'UNAUTHENTICATED', message: 'Lỗi an toàn.' } } }, reason: 'RESPONSE_CLASSIFICATION' },
    { reply: { status: 401, body: { ...base, error: { ...base.error, details: {} } } }, reason: 'RESPONSE_CLASSIFICATION' },
    { reply: { status: 401, body: { ...base, error: { ...base.error, code: 'UNKNOWN' } } }, reason: 'RESPONSE_CLASSIFICATION' },
    { reply: { status: 401, body: { ...base, meta: { requestId: 'invalid' } } }, reason: 'RESPONSE_CLASSIFICATION' },
    { reply: { status: 401, body: { ...base, error: { ...base.error, message: identity.email } } }, reason: 'PRIVATE_IDENTITY' },
  ]
  for (const { reply, reason } of cases) {
    const f = fixture()
    f.replies[2] = reply
    await assert.rejects(f.run(), /social-api chưa đạt/)
    assert.match(f.logs.join('\n'), new RegExp(`reason=${reason}`))
    assert.equal(f.calls.length, 3)
    assert.equal(f.logs.some(line => line.startsWith('PASS: JWT thiếu')), false)
    assertSafeLogs(f)
  }
})

test('JWT rejection có Set-Cookie không đồng nghĩa tạo session trong runner fetch riêng', async () => {
  for (const index of [2, 3]) {
    for (const gateway of [false, true]) {
      const f = fixture()
      const code = index === 2 ? 'UNAUTHORIZED_NO_AUTH_HEADER' : 'UNAUTHORIZED_INVALID_JWT_FORMAT'
      f.replies[index] = { status: 401,
        body: gateway ? { code, message: 'JWT rejected' } : handlerError('UNAUTHENTICATED'),
        headers: { 'set-cookie': '__cf_bm=offline-only; HttpOnly; Secure' } }
      await f.run()
      assert.equal(f.session?.access_token, identity.accessToken)
      assert.equal(f.session?.user.id, identity.userId)
      assert.equal(f.calls.length, 6)
      assertSafeLogs(f)
      const changed = fixture()
      changed.replies[index] = { ...f.replies[index], replaceSession: true }
      await assert.rejects(changed.run(), /social-api chưa đạt/)
      assert.match(changed.logs.join('\n'), /SESSION_CHANGED_OR_UNVERIFIED/)
      assertSafeLogs(changed)
    }
  }
})

test('getMe runner: chỉ nhận chính xác format Supabase msg Invalid JWT với HTTP 401', async () => {
  const known = fixture()
  known.replies[3] = { status: 401, body: { msg: 'Invalid JWT' } }
  await known.run()
  assert.match(known.logs.join('\n'), /PASS: JWT sai; source=gateway; code=GATEWAY_JWT_REJECTED; http=401/)
  assertSafeLogs(known)
  for (const reply of [
    { status: 200, body: { msg: 'Invalid JWT' } },
    { status: 500, body: { msg: 'Invalid JWT' } },
    { status: 401, body: { msg: 'Invalid JWT', user: identity } },
    { status: 401, body: { msg: 'Invalid JWT: raw-secret' } },
    { status: 401, body: { msg: 'rate limit' } },
    { status: 401, body: { msg: 'Invalid JWT' }, headers: { 'x-relay-error': 'true' } },
  ]) {
    const f = fixture()
    f.replies[3] = reply
    await assert.rejects(f.run(), /social-api chưa đạt/)
    assert.equal(f.logs.some(line => line.startsWith('PASS: JWT sai')), false)
    assertSafeLogs(f)
  }
})

test('getMe runner: chẩn đoán UNKNOWN_RESPONSE chỉ in enum/boolean, không in raw code/message/keys', async () => {
  for (const body of [
    { code: 'UNAUTHORIZED_UNKNOWN', message: 'Invalid JWT' },
    { code: identity.email, message: identity.accessToken, [identity.userId]: 'raw-secret SQL SELECT' },
    { msg: `raw-secret ${identity.email}` },
    null,
  ]) {
    const f = fixture()
    f.replies[3] = { status: 401, body }
    await assert.rejects(f.run(), /social-api chưa đạt/)
    const diagnostic = f.logs.find(line => line.startsWith('FAIL: chẩn đoán response'))
    assert.ok(diagnostic)
    assert.match(diagnostic, /http=401; shape=(msg_only|code_message|other); codeType=(number|string|other); headerCode=missing; bodyCode=(unknown|missing); handlerEnvelope=false; relay=false/)
    assert.equal(f.logs.some(line => line.startsWith('PASS: JWT sai')), false)
    assertSafeLogs(f)
  }
})

test('getMe runner: không coi 401 bất kỳ, lỗi mạng/relay/rate limit/server là negative PASS', async () => {
  for (const reply of [
    { status: 200, body: success() },
    { status: 401, body: { code: 401, message: 'raw-secret SQL SELECT' } },
    { status: 401, body: handlerError('FORBIDDEN') },
    { status: 401, body: { code: identity.email, message: identity.accessToken } },
    { status: 401, body: { code: 401, message: 'Invalid JWT', user: identity } },
    { status: 401, text: 'raw-secret SQL SELECT' },
    { status: 401, body: handlerError('UNAUTHENTICATED'), headers: { 'x-relay-error': 'true' } },
    { status: 429, body: { code: 'RATE_LIMITED' } },
    { status: 500, body: handlerError('INTERNAL_ERROR') },
    { status: 401, network: true },
  ]) {
    const f = fixture()
    f.replies[2] = reply
    await assert.rejects(f.run(), /social-api chưa đạt/)
    assert.equal(f.calls.length, 3)
    assert.equal(f.logs.some(line => line.startsWith('PASS: JWT thiếu')), false)
    assertSafeLogs(f)
  }
})

test('getMe runner: malformed/unknown cần handler VALIDATION_ERROR/400, không nhầm gateway/Auth/lỗi SDK', async () => {
  for (const index of [4, 5]) {
    for (const reply of [
      { status: 200, body: success() },
      { status: 400, body: { code: 400, message: 'raw-secret' } },
      { status: 400, body: handlerError('UNAUTHENTICATED') },
      { status: 401, body: { code: 401, message: 'Invalid JWT' } },
      { status: 400, body: handlerError('VALIDATION_ERROR'), headers: { 'x-relay-error': 'true' } },
      { status: 400, body: { ...handlerError('VALIDATION_ERROR'), metadata: identity } },
      { status: 400, body: { ...handlerError('VALIDATION_ERROR'), error: { code: 'VALIDATION_ERROR', message: identity.email, details: null } } },
      { status: 400, network: true },
      { status: 500, body: handlerError('INTERNAL_ERROR') },
    ]) {
      const f = fixture()
      f.replies[index] = reply
      await assert.rejects(f.run(), /social-api chưa đạt/)
      assert.equal(f.calls.length, index + 1)
      assertSafeLogs(f)
    }
  }
})

test('getMe runner: lỗi invoke đầu tiên được lọc, không serialize SDK error/response', async () => {
  for (const reply of [
    { status: 503, network: true },
    { status: 503, body: { message: `raw-secret ${identity.email} ${identity.accessToken}` } },
    { status: 401, body: handlerError('UNAUTHENTICATED') },
    { status: 200, text: 'raw-secret SQL SELECT' },
  ]) {
    const f = fixture()
    f.replies[0] = reply
    await assert.rejects(f.run(), /social-api chưa đạt/)
    assert.equal(f.calls.length, 1)
    assertSafeLogs(f)
  }
})

const invalidJwtCodes = [
  'UNAUTHORIZED_INVALID_JWT_FORMAT',
  'UNAUTHORIZED_UNSUPPORTED_TOKEN_ALGORITHM',
  'UNAUTHORIZED_LEGACY_JWT',
  'UNAUTHORIZED_ASYMMETRIC_JWT',
]

test('gateway JWT mới: allowlist ở body/header, header bổ sung legacy và hai nguồn khớp', async () => {
  for (const code of invalidJwtCodes) {
    for (const reply of [
      { status: 401, body: { code, message: 'Invalid JWT' } },
      { status: 401, body: { code, message: 'raw-secret SQL SELECT' } },
      { status: 401, body: { code, message: 'Invalid JWT' }, headers: { 'sb-error-code': code } },
      { status: 401, body: { message: 'Invalid JWT' }, headers: { 'sb-error-code': code } },
      { status: 401, body: { code: 401, message: 'Invalid JWT' }, headers: { 'sb-error-code': code } },
      { status: 401, body: { code: '401', message: 'Invalid JWT' }, headers: { 'sb-error-code': code } },
    ]) {
      const f = fixture()
      f.replies[3] = reply
      await f.run()
      assert.match(f.logs.join('\n'), new RegExp(`PASS: JWT sai; source=gateway; code=${code}; http=401`))
      assert.equal(f.calls.length, 6)
      assert.equal(f.session?.access_token, identity.accessToken)
      assertSafeLogs(f)
    }
  }
})

test('gateway JWT mới: không cho header lạ/không khớp body hoặc body sai shape giả PASS', async () => {
  const code = invalidJwtCodes[0]
  for (const reply of [
    { status: 401, body: { code: 'UNAUTHORIZED_FUTURE', message: 'Invalid JWT' } },
    { status: 401, body: { code: 'UNAUTHORIZED_INVALID_JWT_FORMAT_EXTRA', message: 'Invalid JWT' } },
    { status: 401, body: { code: 'unauthorized_invalid_jwt_format', message: 'Invalid JWT' } },
    { status: 401, body: { code: 401, message: 'Invalid JWT' }, headers: { 'sb-error-code': 'UNAUTHORIZED_FUTURE' } },
    { status: 401, body: { code, message: 'Invalid JWT' }, headers: { 'sb-error-code': 'EDGE_FUNCTION_ERROR' } },
    { status: 401, body: { code, message: 'Invalid JWT' }, headers: { 'sb-error-code': invalidJwtCodes[1] } },
    { status: 401, body: { code: 'UNKNOWN', message: 'Invalid JWT' }, headers: { 'sb-error-code': code } },
    { status: 401, body: { code: true, message: 'Invalid JWT' }, headers: { 'sb-error-code': code } },
    { status: 401, body: { code: 403, message: 'Invalid JWT' }, headers: { 'sb-error-code': code } },
    { status: 401, body: { code: ['401'], message: 'Invalid JWT' } },
    { status: 401, body: { code, message: null } },
    { status: 401, body: { code, message: 'Invalid JWT', session: { access_token: 'new-token' } } },
    { status: 401, body: null, headers: { 'sb-error-code': code } },
    { status: 401, text: 'Invalid JWT', headers: { 'sb-error-code': code } },
  ]) {
    const f = fixture()
    f.replies[3] = reply
    await assert.rejects(f.run(), /social-api chưa đạt/)
    assert.equal(f.logs.some(line => line.startsWith('PASS: JWT sai')), false)
    assertSafeLogs(f)
  }
})

test('gateway JWT mới: HTTP sai, relay hoặc lỗi không phù hợp request đều FAIL', async () => {
  const code = invalidJwtCodes[0]
  const replies: Reply[] = [
    ...[200, 400, 403, 429, 500, 503].map(status => ({ status, body: { code, message: 'Invalid JWT' }, headers: { 'sb-error-code': code } })),
    { status: 401, body: { code, message: 'Invalid JWT' }, headers: { 'x-relay-error': 'true' } },
    { status: 401, body: { code: 'UNAUTHORIZED_NO_AUTH_HEADER', message: 'Missing authorization header' } },
    { status: 401, body: { code: 401, message: 'Missing authorization header' } },
  ]
  for (const reply of replies) {
    const f = fixture()
    f.replies[3] = reply
    await assert.rejects(f.run(), /social-api chưa đạt/)
    assert.equal(f.logs.some(line => line.startsWith('PASS: JWT sai')), false)
    assertSafeLogs(f)
  }
  const missing = fixture()
  missing.replies[2] = { status: 401, body: { code: 'UNAUTHORIZED_NO_AUTH_HEADER', message: 'No header' },
    headers: { 'sb-error-code': 'UNAUTHORIZED_NO_AUTH_HEADER' } }
  await missing.run()
  for (const index of [2, 4, 5]) {
    const f = fixture()
    f.replies[index] = { status: 401, body: { code, message: 'Invalid JWT' } }
    await assert.rejects(f.run(), /social-api chưa đạt/)
    assert.equal(f.calls.length, index + 1)
    assertSafeLogs(f)
  }
})

test('JWT negative chỉ PASS khi session ban đầu không bị tạo/thay thế hoặc mất xác minh', async () => {
  for (const index of [2, 3, 4, 5]) {
    for (const change of ['replaceSession', 'replaceUser', 'dropSession', 'sessionError'] as const) {
      const f = fixture()
      f.replies[index] = { ...f.replies[index], [change]: true }
      await assert.rejects(f.run(), /social-api chưa đạt/)
      assert.equal(f.logs.some(line => line.includes('SESSION_CHANGED_OR_UNVERIFIED')), true)
      assert.equal(f.logs.some(line => line.startsWith(`PASS: ${index === 2 ? 'JWT thiếu' : index === 3 ? 'JWT sai' : index === 4 ? 'Payload sai' : 'Action không hỗ trợ'}`)), false)
      assertSafeLogs(f)
    }
  }
  const missing = fixture()
  missing.session = null
  await assert.rejects(missing.run(), /social-api chưa đạt/)
  assert.equal(missing.calls.length, 2, 'không gửi negative requests khi không xác minh được phiên ban đầu')
})

test('gateway diagnostic: chỉ xuất code allowlist và metadata, lọc raw header/body code', async () => {
  const f = fixture()
  f.replies[3] = { status: 401,
    body: { code: invalidJwtCodes[0], message: 'raw-secret SQL SELECT' },
    headers: { 'sb-error-code': `UNAUTHORIZED_${identity.email}` } }
  await assert.rejects(f.run(), /social-api chưa đạt/)
  assert.match(f.logs.join('\n'), /codeType=string; headerCode=unknown; bodyCode=UNAUTHORIZED_INVALID_JWT_FORMAT/)
  assertSafeLogs(f)
  const conflict = fixture()
  conflict.replies[3] = { status: 401,
    body: { code: invalidJwtCodes[0], message: 'Invalid JWT' },
    headers: { 'sb-error-code': invalidJwtCodes[1] } }
  await assert.rejects(conflict.run(), /social-api chưa đạt/)
  assert.match(conflict.logs.join('\n'), /headerCode=UNAUTHORIZED_UNSUPPORTED_TOKEN_ALGORITHM; bodyCode=UNAUTHORIZED_INVALID_JWT_FORMAT/)
  assertSafeLogs(conflict)
})
