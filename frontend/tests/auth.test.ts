import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createClient } from '@supabase/supabase-js'
import { createAuthService } from '../src/features/auth/auth-service.ts'
import { fillOtp, isOuEmail, nicknameError, normalizeEmail, passwordError } from '../src/features/auth/validation.ts'
import { clearPending, readPending, savePending, verificationTime } from '../src/features/auth/pending-verification.ts'

const email = 'offline.student@ou.edu.vn'
const password = '  Offline-only-password!  '
const id = '00000000-0000-4000-8000-000000000001'
const user = { id, email, email_confirmed_at: '2026-11-01T00:00:00Z', aud: 'authenticated', user_metadata: {}, app_metadata: {} }
const jwt = `${Buffer.from('{"alg":"HS256"}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: id, exp: 4_000_000_000 })).toString('base64url')}.offline`
const session = { user, access_token: jwt, refresh_token: 'offline-refresh', token_type: 'bearer', expires_in: 3600 }
function fixture(options: { code?: string; signupSession?: boolean; unconfirmed?: boolean; network?: boolean } = {}) {
  const calls: { path: string; body: Record<string, unknown> }[] = []
  const client = createClient('https://offline.example.invalid', 'sb_publishable_offline', {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: async (input, init) => {
      const path = new URL(String(input)).pathname
      calls.push({ path, body: JSON.parse(String(init?.body ?? '{}')) })
      if (options.network) return Response.json({ code: 'unexpected_failure', msg: `${email} secret OTP SQL` }, { status: 503 })
      if (options.code) return Response.json({ code: options.code, msg: `${email} secret OTP SQL` }, { status: options.code.includes('rate_limit') ? 429 : 400, headers: { 'x-supabase-api-version': '2024-01-01' } })
      if (path.endsWith('/user')) return Response.json(options.unconfirmed ? { ...user, email_confirmed_at: null } : user)
      if (path.endsWith('/signup')) return Response.json(options.signupSession ? session : { user, session: null })
      if (path.endsWith('/resend') || path.endsWith('/logout')) return Response.json({})
      return Response.json(session)
    } },
  })
  return { auth: createAuthService(client), calls }
}
test('email OU exact, password giữ nguyên và giới hạn Unicode/UTF-8; nickname URL/control', () => {
  assert.equal(normalizeEmail(' STUDENT@OU.EDU.VN '), 'student@ou.edu.vn')
  for (const value of ['a@gmail.com', 'a@sub.ou.edu.vn', 'a@ou.edu.vn.evil', 'a..b@ou.edu.vn', '@ou.edu.vn']) assert.equal(isOuEmail(value), false)
  assert.equal(isOuEmail(email), true)
  assert.equal(passwordError(password), '')
  assert.notEqual(passwordError('short'), '')
  assert.notEqual(passwordError('👋'.repeat(19)), '')
  assert.equal(passwordError('a'.repeat(72)), '')
  for (const value of ['ab', 'a'.repeat(31), 'https://evil.invalid', 'www.evil.invalid', 'evil.com', 'OU\nTest', 'OU\u200bTest']) assert.notEqual(nicknameError(value), '')
  assert.equal(nicknameError(' OUer mới 👋 '), '')
})
test('login password không gửi OTP, getUser xác minh và logout không còn session', async () => {
  const f = fixture()
  await f.auth.login(` ${email.toUpperCase()} `, password)
  assert.deepEqual(f.calls[0].body, { email, password, gotrue_meta_security: {} })
  assert.ok(f.calls.some(call => call.path.endsWith('/user')))
  assert.ok(f.calls.every(call => !/otp|verify|signup/.test(call.path)))
  assert.ok(await f.auth.restore())
  await f.auth.logout()
  assert.equal(await f.auth.restore(), null)
})
test('signup chưa xác minh không session; response account trùng được xử lý chung', async () => {
  const f = fixture()
  assert.equal(await f.auth.signup(email, password, password), email)
  assert.equal(await f.auth.restore(), null)
  assert.equal(f.calls[0].path, '/auth/v1/signup')
  assert.equal(f.calls[0].body.password, password)
  assert.equal(f.calls[0].body.email, email)
  const unexpected = fixture({ signupSession: true })
  await assert.rejects(unexpected.auth.signup(email, password, password), /Cấu hình xác minh/)
  assert.equal(await unexpected.auth.restore(), null)
})
test('OTP đúng verify email type, OTP sai/hết hạn, resend chỉ signup', async () => {
  const f = fixture()
  await f.auth.verify(email, '654321')
  assert.deepEqual(f.calls[0].body, { email, token: '654321', type: 'email', gotrue_meta_security: {} })
  await f.auth.resend(email)
  assert.equal(f.calls.at(-1)?.body.type, 'signup')
  const expired = fixture({ code: 'otp_expired' })
  await assert.rejects(expired.auth.verify(email, '654321'), /sai hoặc đã hết hạn/)
  assert.equal(await expired.auth.restore(), null)
})
test('password sai/unconfirmed/rate limit/network: thông báo an toàn, không đưa lỗi gốc ra UI', async () => {
  for (const code of ['invalid_credentials', 'email_not_confirmed', 'over_email_send_rate_limit', 'unexpected_failure']) {
    const f = fixture({ code })
    await assert.rejects(f.auth.login(email, password), error => {
      assert.ok(error instanceof Error)
      assert.ok(!/offline|secret|SQL|OTP/.test(error.message)); return true
    })
  }
  const unconfirmed = fixture({ unconfirmed: true })
  await assert.rejects(unconfirmed.auth.login(email, password), /chưa được xác minh/)
  assert.equal(await unconfirmed.auth.restore(), null)
})
test('validation trước network, không trim password và không chấp nhận OTP ngoài sáu số', async () => {
  const f = fixture()
  await assert.rejects(f.auth.signup(email, 'short', 'short'))
  await assert.rejects(f.auth.signup(email, password, password.trim()))
  await assert.rejects(f.auth.login('a@gmail.com', password))
  await assert.rejects(f.auth.verify(email, '12345'))
  await assert.rejects(f.auth.verify(email, '１２３４５６'))
  assert.equal(f.calls.length, 0)
})
test('OTP paste/full code/autofill và xóa một ô', () => {
  assert.deepEqual(fillOtp(['', '', '', '', '', ''], 0, '65 43-21'), { digits: ['6','5','4','3','2','1'], focus: 5 })
  assert.deepEqual(fillOtp(['6','5','','','',''], 2, '4321'), { digits: ['6','5','4','3','2','1'], focus: 5 })
  assert.equal(fillOtp(['6','5','4','3','2','1'], 2, '').digits[2], '')
})
test('pending email/timestamps khôi phục reload, cooldown 60s, expiry 600s không reset', () => {
  const values = new Map<string, string>()
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) }, removeItem: (key: string) => { values.delete(key) } }
  const now = Date.now()
  savePending(storage, { email, sentAt: now })
  assert.deepEqual(readPending(storage, now + 30_000), { email, sentAt: now, resendAt: now + 60_000 })
  assert.deepEqual(verificationTime(now, now + 30_000), { resend: 30, expires: 570 })
  assert.deepEqual(verificationTime(now, now + 700_000), { resend: 0, expires: 0 })
  assert.ok(![...values.values()].join('').includes(password))
  clearPending(storage); assert.equal(readPending(storage), null)
  assert.equal(readPending({ getItem: () => '{' }), null)
  assert.equal(readPending({ getItem: () => JSON.stringify({ email: 'a@gmail.com', sentAt: now }) }), null)
})
