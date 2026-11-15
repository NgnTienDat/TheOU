import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { createRejectionEmail, domainRejectionMessage, isOuEmail, normalizeOuEmail, parseOtp, parsePassword, readManualAuthConfig } from '../scripts/auth-helpers.ts'
import { runManualAuth, type ManualAuthClient } from '../scripts/auth-manual-flow.ts'

const ref = 'puhkisyehspcmgzerutm'
const env = {
  THEOU_ALLOW_AUTH_TESTS: 'theou-dev',
  THEOU_AUTH_SUPABASE_URL: `https://${ref}.supabase.co`,
  THEOU_AUTH_PUBLISHABLE_KEY: 'sb_publishable_fake',
}

test('manual config khóa trước API; chỉ URL dev, flag và publishable key hợp lệ', () => {
  assert.throws(() => readManualAuthConfig({}, ref), /Chưa xác nhận/)
  assert.throws(() => readManualAuthConfig({ ...env, THEOU_ALLOW_AUTH_TESTS: 'true' }, ref), /Chưa xác nhận/)
  assert.throws(() => readManualAuthConfig(env, 'abcdefghijklmnopqrst'), /TheOU-dev/)
  for (const url of ['https://example.invalid', `https://${ref}.supabase.co/path`, `http://${ref}.supabase.co`]) {
    assert.throws(() => readManualAuthConfig({ ...env, THEOU_AUTH_SUPABASE_URL: url }, ref), /TheOU-dev/)
  }
  for (const key of ['', 'sb_secret_fake', 'ey.fake.jwt', 'sb_publishable_bad\nkey']) {
    assert.throws(() => readManualAuthConfig({ ...env, THEOU_AUTH_PUBLISHABLE_KEY: key }, ref), /publishable key/)
  }
  assert.deepEqual(readManualAuthConfig(env, ref), { url: env.THEOU_AUTH_SUPABASE_URL, publishableKey: env.THEOU_AUTH_PUBLISHABLE_KEY })
})

test('domain/OTP validation: chuẩn hóa email OU, chặn suffix giả và mã không đủ 6 số', () => {
  assert.equal(normalizeOuEmail('  Student.Test@OU.EDU.VN  '), 'student.test@ou.edu.vn')
  for (const email of ['', '@ou.edu.vn', 'a@sub.ou.edu.vn', 'a@ou.edu.vn.evil', 'a@gmail.com', 'a b@ou.edu.vn']) {
    assert.equal(isOuEmail(email), false)
    assert.throws(() => normalizeOuEmail(email), /email hợp lệ/)
  }
  assert.equal(parseOtp(' 123456 '), '123456')
  for (const value of ['', '12345', '1234567', '12a456', '１２３４５６']) assert.throws(() => parseOtp(value), /6 chữ số/)
})

test('mật khẩu giữ nguyên khoảng trắng, giới hạn ký tự/byte và không ép policy signup lên login cũ', () => {
  const value = ` ${randomUUID()} `
  assert.equal(parsePassword(value, 'signup'), value)
  assert.equal(parsePassword('a'.repeat(72), 'signup').length, 72)
  assert.equal(parsePassword('a'.repeat(6), 'login').length, 6)
  assert.equal(parsePassword('😀'.repeat(18), 'signup'), '😀'.repeat(18))
  for (const password of ['', 'a'.repeat(73), '😀'.repeat(19), 'a\0password', 'password\r', 'password\n', 'password\t', 'password\x7f']) {
    assert.throws(() => parsePassword(password, 'signup'), /Mật khẩu/)
  }
  for (const password of ['a'.repeat(7), ' '.repeat(8), '😀'.repeat(7)]) {
    assert.throws(() => parsePassword(password, 'signup'), /ít nhất 8/)
  }
})

test('runner nạp env rõ ràng; template Confirm signup chỉ chứa OTP, không có magic link', () => {
  const { scripts } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(scripts['auth:manual'], 'node --env-file=.env.auth.local scripts/auth-manual.ts')
  const template = readFileSync(new URL('../templates/email-otp.html', import.meta.url), 'utf8')
  assert.match(template, /lang="vi"/)
  assert.match(template, /\{\{ \.Token \}\}/)
  assert.match(template, /Xác minh email đăng ký/)
  assert.doesNotMatch(template, /ConfirmationURL|TokenHash|href=|<script|Mã đăng nhập/i)
  const alias = createRejectionEmail(`${'a'.repeat(30)}@gmail.com`, 'a'.repeat(20))
  assert.ok(alias.split('@')[0].length <= 64)
  assert.throws(() => createRejectionEmail('offline@gmail.com', 'bad-run'), /Run ID/)
})

function fixture() {
  const password = `${randomUUID()}-Aa1!`
  const user = { id: 'offline-user', email: 'student.test@ou.edu.vn', email_confirmed_at: '' }
  const session = { access_token: 'offline-token-never-log', user }
  const state = { active: false, failLogout: false, registered: false, confirmed: false }
  const calls: { method: string; input?: unknown }[] = []
  const logs: string[] = []
  const client: ManualAuthClient = {
    async signInWithOtp(input) {
      calls.push({ method: 'otp-send', input })
      return { data: { session: null }, error: { code: 'otp_disabled', status: 403 } }
    },
    async signUp(input) {
      calls.push({ method: 'signup', input })
      if (input.email.endsWith('@gmail.com')) {
        return { data: { session: null }, error: { status: 403, message: domainRejectionMessage } }
      }
      state.registered = true
      return { data: { session: null }, error: null }
    },
    async signInWithPassword(input) {
      calls.push({ method: 'password', input })
      if (!state.registered || input.password !== password) {
        return { data: { session: null }, error: { code: 'invalid_credentials' } }
      }
      if (!state.confirmed) return { data: { session: null }, error: { code: 'email_not_confirmed' } }
      state.active = true
      user.email_confirmed_at = '2026-11-15T00:00:00Z'
      return { data: { session }, error: null }
    },
    async verifyOtp(input) {
      calls.push({ method: 'verify', input })
      if (!state.registered || input.token !== '123456') return { data: { session: null }, error: { code: 'otp_expired' } }
      state.confirmed = true
      state.active = true
      user.email_confirmed_at = '2026-11-15T00:00:00Z'
      return { data: { session }, error: null }
    },
    async getUser() { return { data: { user }, error: null } },
    async getSession() { return { data: { session: state.active ? session : null }, error: null } },
    async signOut(input) {
      calls.push({ method: 'logout', input })
      if (state.failLogout) return { error: { status: 500, message: 'private logout response' } }
      state.active = false
      return { error: null }
    },
  }
  const answers = [user.email, password, password, '123456']
  return { password, user, session, state, client, calls, logs, answers,
    ask: async (_prompt: string) => answers.shift() ?? '', report: (line: string) => logs.push(line) }
}

function assertSafeLogs(f: ReturnType<typeof fixture>): void {
  for (const secret of [f.password, f.user.email, f.user.id, f.session.access_token, '123456']) {
    assert.ok(!f.logs.join('\n').includes(secret), 'Log chỉ chứa trạng thái an toàn')
  }
}

test('passwordless-denied gọi Auth trực tiếp với shouldCreateUser=false và otp_disabled phù hợp', async () => {
  for (const status of [400, 403]) {
    const f = fixture()
    f.state.registered = f.state.confirmed = true
    f.answers.splice(0, f.answers.length, ' Student.Test@OU.EDU.VN ')
    const otp = f.client.signInWithOtp
    f.client.signInWithOtp = async (input) => {
      const result = await otp(input)
      return { ...result, error: { code: 'otp_disabled', status } }
    }
    await runManualAuth(f.client, 'passwordless-denied', f.ask, f.report)
    assert.deepEqual(f.calls, [
      { method: 'otp-send', input: { email: f.user.email, options: { shouldCreateUser: false } } },
      { method: 'logout', input: { scope: 'local' } },
    ])
    assert.equal(f.state.active, false)
    assert.match(f.logs.join('\n'), /otp_disabled/)
    assert.match(f.logs.join('\n'), /hoàn tất kiểm tra passwordless-denied/)
    assertSafeLogs(f)
  }
})

test('MagicLink disabled dùng email_provider_disabled/422; không chấp nhận tắt Email chung hoặc user không tồn tại', async () => {
  const allowed = fixture()
  allowed.state.registered = allowed.state.confirmed = true
  allowed.client.signInWithOtp = async (input) => {
    allowed.calls.push({ method: 'otp-send', input })
    return { data: { session: null }, error: { code: 'email_provider_disabled', status: 422, message: 'Login with magic link is disabled' } }
  }
  await runManualAuth(allowed.client, 'passwordless-denied', allowed.ask, allowed.report)
  assert.deepEqual(allowed.calls[0].input, { email: allowed.user.email, options: { shouldCreateUser: false } })
  assert.match(allowed.logs.join('\n'), /magicLinkDisabled=true/)
  assert.match(allowed.logs.join('\n'), /hoàn tất kiểm tra passwordless-denied/)
  assertSafeLogs(allowed)
  for (const error of [
    { code: 'email_provider_disabled', status: 422, message: 'Email logins are disabled' },
    { code: 'email_provider_disabled', status: 400, message: 'Email signups are disabled' },
    { code: 'email_provider_disabled', status: 429, message: 'Login with magic link is disabled' },
    { code: 'email_provider_disabled', status: 500, message: 'Login with magic link is disabled' },
    { code: 'otp_disabled', status: 422, message: 'Signups not allowed for otp' },
  ]) {
    const f = fixture()
    f.client.signInWithOtp = async () => ({ error, data: { session: null } })
    await assert.rejects(runManualAuth(f.client, 'passwordless-denied', f.ask, f.report), /chưa chứng minh passwordless bị tắt/)
    assert.equal(f.logs.some(line => line.includes('hoàn tất kiểm tra')), false)
    assertSafeLogs(f)
  }
})

test('passwordless-denied không tính success, SMTP, rate limit, code khác hoặc lỗi mạng là PASS', async () => {
  for (const error of [null, { code: 'unexpected_failure', status: 500 },
    { code: 'over_email_send_rate_limit', status: 429 }, { code: 'email_address_not_authorized', status: 403 },
    { code: 'email_provider_disabled', status: 400 }, { code: 'user_not_found', status: 404 },
    { code: 'otp_disabled', status: 429 }, { code: 'otp_disabled', status: 500 }, { code: 'otp_disabled' },
    { status: 403, message: 'OTP sign-in disabled' }]) {
    const f = fixture()
    f.client.signInWithOtp = async () => ({ error, data: { session: null } })
    await assert.rejects(runManualAuth(f.client, 'passwordless-denied', f.ask, f.report), /chưa chứng minh passwordless bị tắt/)
    assert.equal(f.logs.some(line => line.includes('hoàn tất kiểm tra')), false)
    assertSafeLogs(f)
  }
  const network = fixture()
  network.client.signInWithOtp = async () => { throw new Error(`${network.user.email} ${network.session.access_token}`) }
  await assert.rejects(runManualAuth(network.client, 'passwordless-denied', network.ask, network.report), /kết nối hoặc SDK/)
  assert.equal(network.logs.some(line => line.includes('hoàn tất kiểm tra')), false)
  assertSafeLogs(network)
})

test('chẩn đoán passwordless chỉ in mã lỗi allowlist/HTTP, không lộ error message/email/token', async () => {
  const f = fixture()
  for (const [error, expected] of [
    [null, /error=false; code=none; http=unknown/],
    [{ code: 'over_email_send_rate_limit', status: 429, message: f.password }, /code=over_email_send_rate_limit; http=429/],
    [{ code: 'otp_disabled', status: 500, message: f.session.access_token }, /code=otp_disabled; http=500/],
    [{ code: f.user.email, status: 403, message: f.user.email }, /code=unknown_or_missing; http=403/],
    [{ code: f.session.access_token, status: 999, message: f.password }, /code=unknown_or_missing; http=unknown/],
  ] as const) {
    f.answers.splice(0, f.answers.length, f.user.email)
    f.logs.length = 0
    f.client.signInWithOtp = async () => ({ error, data: { session: null } })
    await assert.rejects(runManualAuth(f.client, 'passwordless-denied', f.ask, f.report), /chưa chứng minh passwordless bị tắt/)
    assert.match(f.logs[0], expected)
    assertSafeLogs(f)
    assert.equal(f.logs.some(line => line.includes('hoàn tất kiểm tra')), false)
  }
})

test('passwordless-denied bắt session trước/sau request và cleanup lỗi, không PASS dù code đúng', async () => {
  const before = fixture()
  before.state.active = true
  await assert.rejects(runManualAuth(before.client, 'passwordless-denied', before.ask, before.report), /vẫn có session/)
  assert.equal(before.calls.some(call => call.method === 'otp-send'), false)
  const returned = fixture()
  returned.client.signInWithOtp = async () => ({ error: { code: 'otp_disabled', status: 403 }, data: { session: returned.session } })
  await assert.rejects(runManualAuth(returned.client, 'passwordless-denied', returned.ask, returned.report), /chưa chứng minh/)
  const stored = fixture()
  stored.client.signInWithOtp = async () => {
    stored.state.active = true
    return { error: { code: 'otp_disabled', status: 403 }, data: { session: null } }
  }
  await assert.rejects(runManualAuth(stored.client, 'passwordless-denied', stored.ask, stored.report), /vẫn có session/)
  const logout = fixture()
  logout.state.failLogout = true
  await assert.rejects(runManualAuth(logout.client, 'passwordless-denied', logout.ask, logout.report), /Đăng xuất/)
  for (const f of [before, returned, stored, logout]) {
    assert.equal(f.logs.some(line => line.includes('hoàn tất kiểm tra')), false)
    assertSafeLogs(f)
  }
})

test('passwordless-denied chặn email ngoài OU trước request, không hỏi mật khẩu/OTP', async () => {
  const f = fixture()
  f.answers.splice(0, f.answers.length, 'outside@gmail.com')
  let prompts = 0
  await assert.rejects(runManualAuth(f.client, 'passwordless-denied', async (prompt) => {
    prompts++
    assert.match(prompt, /Email OU đã tồn tại/)
    return f.ask(prompt)
  }, f.report), /email hợp lệ/)
  assert.equal(prompts, 1)
  assert.deepEqual(f.calls.map(call => call.method), ['logout'])
  assert.equal(f.state.registered, false)
})

test('signup: chưa xác minh bị chặn password login, OTP sai không session, OTP đúng xác minh OU', async () => {
  const f = fixture()
  await runManualAuth(f.client, 'signup', f.ask, f.report)
  assert.deepEqual(f.calls.map(call => call.method), ['signup', 'password', 'verify', 'verify', 'logout'])
  assert.deepEqual(f.calls[0].input, { email: f.user.email, password: f.password })
  const verifies = f.calls.filter(call => call.method === 'verify').map(call => call.input as { token: string; type: string })
  assert.notEqual(verifies[0].token, verifies[1].token)
  assert.equal(verifies[1].type, 'email')
  assert.equal(f.state.confirmed, true)
  assert.equal(f.state.active, false)
  assert.deepEqual(f.calls.at(-1)?.input, { scope: 'local' })
  assert.match(f.logs.join('\n'), /email_not_confirmed/)
  assert.match(f.logs.join('\n'), /hoàn tất kiểm tra signup/)
  assertSafeLogs(f)
})

test('verify-signup tiếp tục OTP đang chờ, không gửi email hoặc đổi mật khẩu', async () => {
  const f = fixture()
  f.state.registered = true
  f.answers.splice(0, f.answers.length, f.user.email, '123456')
  await runManualAuth(f.client, 'verify-signup', f.ask, f.report)
  assert.deepEqual(f.calls.map(call => call.method), ['verify', 'verify', 'logout'])
  assert.equal(f.state.confirmed, true)
  assertSafeLogs(f)
})

test('login: mật khẩu sai bị chặn rồi mật khẩu đúng tạo session, không gọi OTP/signup', async () => {
  const f = fixture()
  f.state.registered = f.state.confirmed = true
  f.answers.splice(0, f.answers.length, f.user.email, f.password)
  await runManualAuth(f.client, 'login', f.ask, f.report)
  assert.deepEqual(f.calls.map(call => call.method), ['password', 'password', 'logout'])
  const wrong = f.calls[0].input as { password: string }
  assert.notEqual(wrong.password, f.password)
  assert.deepEqual(f.calls[1].input, { email: f.user.email, password: f.password })
  assert.equal(f.state.active, false)
  assert.match(f.logs.join('\n'), /không yêu cầu OTP/)
  assertSafeLogs(f)
})

test('signup không đạt nếu Confirm email tắt hoặc email đã có tài khoản được xác minh', async () => {
  const auto = fixture()
  auto.client.signUp = async () => ({ error: null, data: { session: auto.session } })
  await assert.rejects(runManualAuth(auto.client, 'signup', auto.ask, auto.report), /trả session trước OTP/)
  const existing = fixture()
  existing.state.registered = existing.state.confirmed = true
  await assert.rejects(runManualAuth(existing.client, 'signup', existing.ask, existing.report), /chưa chứng minh tài khoản chưa xác minh/)
  for (const f of [auto, existing]) {
    assert.equal(f.calls.some(call => call.method === 'verify'), false)
    assert.equal(f.logs.some(line => line.includes('hoàn tất kiểm tra')), false)
    assert.equal(f.state.active, false)
  }
})

test('đăng ký Gmail qua signUp với alias mới, chỉ PASS khi hook trả 403 đúng thông báo', async () => {
  const f = fixture()
  f.answers.splice(0, f.answers.length, 'offline.test@gmail.com', f.password)
  await runManualAuth(f.client, 'reject', f.ask, f.report)
  const input = f.calls[0].input as { email: string; password: string }
  assert.match(input.email, /^offline[.]test\+theou-t03-[a-f0-9]{20}@gmail[.]com$/)
  assert.equal(input.password, f.password)
  assert.deepEqual(f.calls.map(call => call.method), ['signup', 'logout'])
  assertSafeLogs(f)
  for (const error of [null, { status: 429 }, { status: 500 }, { status: 500, message: domainRejectionMessage }]) {
    const g = fixture()
    g.answers.splice(0, g.answers.length, 'offline.test@gmail.com', g.password)
    g.client.signUp = async () => ({ error, data: { session: null } })
    await assert.rejects(runManualAuth(g.client, 'reject', g.ask, g.report), /chưa chứng minh hook từ chối/)
  }
})

test('input sai hoặc nhập lại password không khớp dừng trước signUp/password/verify API', async () => {
  const invalid = fixture()
  invalid.answers[0] = 'outside@example.invalid'
  const mismatch = fixture()
  mismatch.answers[2] = randomUUID()
  const weak = fixture()
  weak.answers[1] = ''
  for (const f of [invalid, mismatch, weak]) {
    await assert.rejects(runManualAuth(f.client, 'signup', f.ask, f.report))
    assert.deepEqual(f.calls.map(call => call.method), ['logout'])
  }
  const otp = fixture()
  otp.answers[3] = '123'
  await assert.rejects(runManualAuth(otp.client, 'signup', otp.ask, otp.report), /6 chữ số/)
  assert.equal(otp.calls.some(call => call.method === 'verify'), false)
})

test('negative password/OTP không coi lỗi mạng, rate limit, mã lỗi khác hoặc session bất thường là PASS', async () => {
  for (const error of [null, { status: 429 }, { code: 'email_not_confirmed' }, { status: 500 }]) {
    const f = fixture()
    f.answers.splice(0, f.answers.length, f.user.email, f.password)
    f.client.signInWithPassword = async () => ({ error, data: { session: null } })
    await assert.rejects(runManualAuth(f.client, 'login', f.ask, f.report), /mật khẩu sai chưa bị từ chối/)
  }
  for (const error of [null, { status: 429 }, { code: 'invalid_credentials' }]) {
    const f = fixture()
    f.client.verifyOtp = async () => ({ error, data: { session: null } })
    await assert.rejects(runManualAuth(f.client, 'signup', f.ask, f.report), /OTP sai chưa bị từ chối/)
  }
  const unexpected = fixture()
  unexpected.client.signInWithPassword = async () => ({ error: { code: 'invalid_credentials' }, data: { session: unexpected.session } })
  unexpected.answers.splice(0, unexpected.answers.length, unexpected.user.email, unexpected.password)
  await assert.rejects(runManualAuth(unexpected.client, 'login', unexpected.ask, unexpected.report), /mật khẩu sai chưa bị từ chối/)
})

test('login tài khoản chưa xác minh hoặc chưa có password dừng, không fallback sang OTP/reset', async () => {
  for (const registered of [true, false]) {
    const f = fixture()
    f.state.registered = registered
    f.answers.splice(0, f.answers.length, f.user.email, f.password)
    await assert.rejects(runManualAuth(f.client, 'login', f.ask, f.report), registered ? /Email chưa được xác minh/ : /Email hoặc mật khẩu không đúng/)
    assert.deepEqual(f.calls.map(call => call.method), ['password', 'password', 'logout'])
    assert.equal(f.logs.some(line => line.includes('hoàn tất kiểm tra')), false)
    assertSafeLogs(f)
  }
})

test('rate limit/weak password/OTP hết hạn và lỗi SDK được lọc; cleanup không che FAIL', async () => {
  for (const [code, status, pattern] of [
    ['over_email_send_rate_limit', 429, /rate limit/],
    ['weak_password', 422, /chính sách Auth/],
  ] as const) {
    const f = fixture()
    f.client.signUp = async () => ({ data: { session: null }, error: { code, status, message: f.password } })
    await assert.rejects(runManualAuth(f.client, 'signup', f.ask, f.report), pattern)
    assertSafeLogs(f)
  }
  const expired = fixture()
  expired.answers[3] = '999999'
  await assert.rejects(runManualAuth(expired.client, 'signup', expired.ask, expired.report), /OTP sai hoặc đã hết hạn/)
  const logout = fixture()
  logout.state.failLogout = true
  await assert.rejects(runManualAuth(logout.client, 'signup', logout.ask, logout.report), /Đăng xuất/)
  const network = fixture()
  network.client.signUp = async () => { throw new Error(`${network.password} SMTP_PASSWORD=never-log JWT=never-log`) }
  await assert.rejects(runManualAuth(network.client, 'signup', network.ask, network.report), /kết nối hoặc SDK/)
  for (const f of [expired, logout, network]) {
    assert.equal(f.calls.at(-1)?.method, 'logout')
    assert.equal(f.logs.some(line => line.includes('hoàn tất kiểm tra')), false)
    assertSafeLogs(f)
    assert.doesNotMatch(f.logs.join('\n'), /SMTP_PASSWORD|JWT=|private logout|999999/)
  }
})

test('session/user không khớp hoặc email chưa xác minh bị từ chối dù API trả token', async () => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => { f.client.getUser = async () => ({ error: null, data: { user: { ...f.user, email_confirmed_at: '' } } }) },
    (f: ReturnType<typeof fixture>) => { f.client.getUser = async () => ({ error: null, data: { user: { ...f.user, id: 'another-user' } } }) },
    (f: ReturnType<typeof fixture>) => { f.client.getUser = async () => ({ error: null, data: { user: { ...f.user, email: 'outside@gmail.com' } } }) },
  ]) {
    const f = fixture()
    mutate(f)
    await assert.rejects(runManualAuth(f.client, 'signup', f.ask, f.report), /session không khớp|email hợp lệ/)
    assert.equal(f.state.active, false)
    assert.equal(f.logs.some(line => line.includes('hoàn tất kiểm tra')), false)
  }
})
