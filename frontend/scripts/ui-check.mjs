// Chỉ mock offline; chặn mọi request ngoài Vite và host dữ liệu giả.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { chromium } from 'playwright-core'

const root = fileURLToPath(new URL('../', import.meta.url))
const artifacts = join(root, 'node_modules/.cache/theou-ui')
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '5188', '--strictPort'], {
  cwd: root, windowsHide: true, stdio: 'ignore', env: { ...process.env, VITE_SUPABASE_URL: 'https://offline.example.invalid', VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_offline_ui' },
})
let browser
let nickname = 'OUer offline'
let mode = 'ok'
let signupCalls = 0
let verifyCalls = 0
let resendCalls = 0
const user = { id: '00000000-0000-4000-8000-000000000001', email: 'offline.student@ou.edu.vn', email_confirmed_at: '2026-11-01T00:00:00Z', aud: 'authenticated', app_metadata: {}, user_metadata: {} }
const jwt = `${Buffer.from('{"alg":"HS256"}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: user.id, exp: 4_000_000_000 })).toString('base64url')}.offline`
const session = { user, access_token: jwt, refresh_token: 'offline-refresh', token_type: 'bearer', expires_in: 3600 }
const envelope = data => ({ data, error: null, meta: { requestId: '00000000-0000-4000-8000-000000000002' } })
try {
  browser = await chromium.launch({ executablePath: process.env.THEOU_BROWSER_PATH ?? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', headless: true })
  const context = await browser.newContext({ reducedMotion: 'reduce' })
  const page = await context.newPage()
  const pageErrors = []
  page.on('pageerror', () => pageErrors.push('runtime error'))
  await context.route('**/*', async route => {
    const request = route.request()
    const url = new URL(request.url())
    if (url.origin === 'http://127.0.0.1:5188') return route.continue()
    if (url.origin !== 'https://offline.example.invalid') return route.abort()
    let status = 200
    let body = {}
    const input = request.postDataJSON() ?? {}
    if (url.pathname.endsWith('/signup')) { signupCalls++; body = { user, session: null } }
    else if (url.pathname.endsWith('/resend')) { resendCalls++ }
    else if (url.pathname.endsWith('/verify')) {
      verifyCalls++
      if (input.token !== '654321') { status = 403; body = { code: 'otp_expired', msg: 'offline error' } }
      else body = session
    } else if (url.pathname.endsWith('/token')) {
      if (input.password !== 'Offline-password!') { status = 400; body = { code: 'invalid_credentials', msg: 'offline error' } }
      else body = session
    } else if (url.pathname.endsWith('/user')) body = user
    else if (url.pathname.endsWith('/logout')) body = {}
    else if (url.pathname.endsWith('/social-api')) {
      if (mode === 'banned') { status = 403; body = { data: null, error: { code: 'FORBIDDEN', message: 'Bị khóa', details: null }, meta: envelope(null).meta } }
      else if (mode === 'server') { status = 500; body = {} }
      else if (mode === 'expired') { status = 401; body = { code: 401, message: 'Invalid JWT' } }
      else if (input.action === 'updateNickname') {
        if (mode === 'update-error') { status = 500; body = {} }
        else { nickname = input.payload.nickname; body = envelope({ nickname }) }
      }
      else if (input.action === 'listPosts') body = envelope({ items: [], nextCursor: null })
      else body = envelope({ nickname, emailMasked: '***@ou.edu.vn', isAdmin: false })
    } else throw new Error('Mock thiếu endpoint; không cho request đi ra mạng')
    await route.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*', 'x-supabase-api-version': '2024-01-01' }, body: JSON.stringify(body) })
  })
  for (let count = 0; count < 100; count++) {
    try { if ((await fetch('http://127.0.0.1:5188')).ok) break } catch { /* Vite có thể chưa sẵn sàng. */ }
    await new Promise(done => setTimeout(done, 50))
  }
  await mkdir(artifacts, { recursive: true })
  const visualMetrics = []
  const measure = () => ({
    cardWidth: document.querySelector('.card').getBoundingClientRect().width,
    radius: getComputedStyle(document.querySelector('.card')).borderRadius,
    panel: getComputedStyle(document.querySelector('.card')).backgroundColor,
    inputHeight: [...document.querySelectorAll('input')].find(input => input.getClientRects().length)?.getBoundingClientRect().height ?? null,
    heading: getComputedStyle(document.querySelector('h1')).fontSize,
  })
  async function screenshots(name) {
    for (const width of [360, 390, 768, 1280]) for (const theme of ['dark', 'light']) {
      await page.setViewportSize({ width, height: width < 600 ? 912 : 960 })
      if (name === 'profile') assert.equal(await page.getByRole('heading', { name: 'Cá nhân', exact: true }).count(), 1)
      if (await page.getAttribute('html', 'data-theme') !== theme) await page.getByRole('button', { name: /Chuyển giao diện/ }).click()
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'không tràn ngang')
      assert.equal(await page.locator('input').evaluateAll(inputs => inputs.every(e => e.labels?.length || e.getAttribute('aria-label'))), true, 'input có nhãn')
      await page.screenshot({ path: join(artifacts, `${name}-${width}-${theme}.png`), fullPage: true, style: '.toast{visibility:hidden}' })
      visualMetrics.push({ name, width, theme, metrics: await page.evaluate(measure) })
    }
  }
  async function login(password = 'Offline-password!') {
    await page.getByLabel('Email trường', { exact: true }).fill(user.email)
    await page.getByLabel('Mật khẩu', { exact: true }).fill(password)
    await page.getByRole('button', { name: 'Đăng nhập', exact: true }).click()
  }
  async function ready() {
    if (new URL(page.url()).pathname !== '/ca-nhan') {
      await page.getByRole('heading', { name: 'Bảng tin', exact: true }).waitFor()
      assert.equal(new URL(page.url()).pathname, '/', 'login/OTP/retry chuyển về feed')
      await page.getByRole('link', { name: 'Cá nhân', exact: true }).click()
    }
    await page.waitForSelector('.profile-name')
  }
  async function logout() { await page.getByRole('button', { name: 'Đăng xuất', exact: true }).click(); await page.waitForSelector('input[name=email]') }
  await page.goto('http://127.0.0.1:5188/ca-nhan')
  await page.waitForURL('**/dang-nhap'); await page.waitForSelector('input[name=email]')
  assert.equal(await page.getAttribute('html', 'data-theme'), 'dark')
  await page.keyboard.press('Tab')
  assert.equal(await page.evaluate(() => document.activeElement.classList.contains('theme-btn')), true)
  await screenshots('login')
  const themeBefore = await page.getAttribute('html', 'data-theme')
  await page.getByRole('button', { name: /Chuyển giao diện/ }).click()
  assert.notEqual(await page.getAttribute('html', 'data-theme'), themeBefore)
  await login('Wrong-password!'); await page.getByRole('alert').waitFor()
  await page.getByRole('button', { name: 'Hiện mật khẩu', exact: true }).click()
  assert.equal(await page.getByLabel('Mật khẩu', { exact: true }).getAttribute('type'), 'text')
  await page.getByRole('button', { name: 'Ẩn mật khẩu', exact: true }).click()
  await login(); await ready()
  assert.equal(await page.locator('.profile-info').textContent(), '***@ou.edu.vn')
  await page.reload(); await ready()
  await page.getByRole('button', { name: 'Chỉnh sửa' }).click()
  await page.getByLabel('Biệt danh mới').fill('ab')
  await page.getByRole('button', { name: 'Lưu biệt danh' }).click()
  await page.locator('.error.visible').waitFor()
  await page.getByLabel('Biệt danh mới').fill('OUer mới')
  mode = 'update-error'
  await page.getByRole('button', { name: 'Lưu biệt danh' }).click()
  await page.getByRole('alert').waitFor()
  assert.equal(await page.locator('.profile-name').textContent(), 'OUer offline')
  mode = 'ok'
  await page.getByRole('button', { name: 'Lưu biệt danh' }).click()
  await page.waitForFunction(() => document.querySelector('.profile-name')?.textContent === 'OUer mới')
  await screenshots('profile')
  await logout()
  await page.getByRole('link', { name: 'Đăng ký ngay' }).click()
  await screenshots('signup')
  await page.getByLabel('Email trường', { exact: true }).fill(user.email)
  await page.getByLabel('Tạo mật khẩu', { exact: true }).fill('Offline-password!')
  await page.getByLabel('Nhập lại mật khẩu', { exact: true }).fill('Offline-password!')
  await page.locator('form').evaluate(form => { form.requestSubmit(); form.requestSubmit() })
  await page.waitForSelector('.otp-box')
  assert.equal(signupCalls, 1, 'chống submit trùng')
  await page.reload(); await page.waitForSelector('.otp-box')
  assert.equal(await page.locator('.otp-resend button').isDisabled(), true, 'cooldown sau reload')
  await screenshots('otp')
  await page.locator('#otp-0').fill('111111')
  await page.getByRole('button', { name: 'Xác minh email', exact: true }).click()
  await page.getByRole('alert').waitFor()
  await page.locator('#otp-0').evaluate(input => { const data = new DataTransfer(); data.setData('text', '654321'); input.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, clipboardData: data })) })
  assert.equal(await page.locator('.otp-box').evaluateAll(inputs => inputs.map(e => e.value).join('')), '654321')
  await page.keyboard.press('ArrowLeft')
  assert.equal(await page.evaluate(() => document.activeElement.id), 'otp-4')
  await page.keyboard.press('Backspace'); await page.keyboard.press('Backspace')
  assert.equal(await page.evaluate(() => document.activeElement.id), 'otp-3')
  await page.locator('#otp-0').fill('654321')
  await page.getByRole('button', { name: 'Xác minh email', exact: true }).click(); await ready()
  assert.equal(verifyCalls, 2)
  await logout()
  await page.goto('http://127.0.0.1:5188/xac-thuc')
  await page.getByLabel('Email trường đã đăng ký').fill(user.email)
  await page.getByRole('button', { name: 'Tiếp tục xác minh' }).click()
  await page.locator('.otp-box').first().waitFor()
  await page.getByRole('button', { name: 'Gửi lại mã', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('.otp-resend button')?.disabled)
  assert.equal(resendCalls, 1)
  await page.goto('http://127.0.0.1:5188/dang-nhap')
  for (const denial of ['server', 'banned', 'expired']) {
    mode = denial
    const rejection = denial === 'expired' ? page.waitForResponse(response => response.url().endsWith('/social-api') && response.status() === 401) : null
    await login()
    if (denial === 'expired') { await rejection; await page.waitForSelector('input[name=email]'); assert.equal(await page.locator('.profile-name').count(), 0) }
    else {
      await page.getByRole('alert').waitFor()
      assert.equal(await page.locator('.profile-name').count(), 0)
      if (denial === 'server') { mode = 'ok'; await page.getByRole('button', { name: 'Thử lại', exact: true }).click(); await ready() }
      await logout()
    }
  }
  assert.deepEqual(pageErrors, [])
  const reference = await context.newPage()
  await reference.setContent(await readFile(join(root, '../docs/fe-templates/TheOU-T05-Authentication-Prototype.html'), 'utf8'))
  for (const { name, width, theme, metrics } of visualMetrics.filter(item => item.name !== 'profile')) {
    await reference.setViewportSize({ width, height: width < 600 ? 912 : 960 })
    await reference.evaluate(({ name, theme }) => {
      document.documentElement.dataset.theme = theme
      document.querySelector(`.preview-tabs [data-go="${name}"]`).click()
    }, { name, theme })
    assert.deepEqual(metrics, await reference.evaluate(measure), `card/tokens/input/heading đúng prototype: ${name}/${width}/${theme}`)
  }
  await reference.close()
  console.log('PASS: UI offline — routes, Auth/OTP/profile, errors/403/401/retry, theme, double-submit, keyboard/paste; 32 screenshots ở 360/390/768/1280px dark/light.')
  console.log('PASS: kích thước card/input, radius, panel và heading đối chiếu HTML T05 cho 24 trường hợp Auth; 8 ảnh Profile dùng shell V2.')
  console.log('Ảnh dữ liệu giả: frontend/node_modules/.cache/theou-ui/ (gitignored). Không gọi Cloud.')
} finally { await browser?.close(); server.kill() }
