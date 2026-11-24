// Auth/API giả; chỉ cho mạng tới Vite và host offline, không dùng tài khoản thật.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { chromium } from 'playwright-core'

const root = fileURLToPath(new URL('../', import.meta.url))
const artifacts = join(root, 'node_modules/.cache/theou-votes-ui')
const origin = 'http://127.0.0.1:5191'
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '5191', '--strictPort'], {
  cwd: root, windowsHide: true, stdio: 'ignore', env: { ...process.env, VITE_SUPABASE_URL: 'https://offline.example.invalid', VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_offline_ui' },
})
const id = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const users = [1, 2].map(n => ({ id: id(900 + n), email: `offline${n}@ou.edu.vn`, email_confirmed_at: '2026-11-01T00:00:00Z', aud: 'authenticated', app_metadata: {}, user_metadata: {} }))
const sessions = users.map(user => ({ user, access_token: `${Buffer.from('{"alg":"HS256"}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: user.id, exp: 4_000_000_000 })).toString('base64url')}.offline`, refresh_token: `offline-${user.id}`, token_type: 'bearer', expires_in: 3600 }))
const votes = [new Set(), new Set()]
const dto = (n, caller) => ({ id: id(n), tag: 'CONFESSION', body: `Bài viết offline ${n} để kiểm tra bình chọn.`, displayMode: 'ANONYMOUS', authorLabel: 'OUer ẩn danh', contactUrl: null,
  publishedAt: '2026-11-17T00:00:00Z', upvoteCount: 3 + votes[n - 1].size, commentCount: 0, hasUpvoted: votes[n - 1].has(caller), isMine: false, images: [] })
const envelope = data => ({ data, error: null, meta: { requestId: id(999) } })
const failure = code => ({ data: null, error: { code, message: 'PRIVATE SQL JWT secret@ou.edu.vn', details: null }, meta: { requestId: id(999) } })
let mode = 'ready'
let release
let held = false
let browser
let shots = 0
const calls = []
const lists = []
try {
  for (let n = 0; n < 100; n++) {
    try { if ((await fetch(origin)).ok) break } catch { /* Chờ server local. */ }
    await new Promise(done => setTimeout(done, 50))
  }
  browser = await chromium.launch({ executablePath: process.env.THEOU_BROWSER_PATH ?? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', headless: true })
  const context = await browser.newContext({ reducedMotion: 'reduce' })
  const page = await context.newPage()
  page.setDefaultTimeout(10_000)
  const errors = []
  page.on('pageerror', () => errors.push('runtime error'))
  await context.route('**/*', async route => {
    const request = route.request(); const url = new URL(request.url())
    if (url.origin === origin) return route.continue()
    if (url.origin !== 'https://offline.example.invalid') return route.abort()
    const input = request.postDataJSON() ?? {}
    const caller = sessions.findIndex(value => request.headers().authorization === `Bearer ${value.access_token}`)
    let body; let status = 200
    if (url.pathname.endsWith('/token')) body = sessions[users.findIndex(user => user.email === input.email)]
    else if (url.pathname.endsWith('/user')) { assert.ok(caller >= 0); body = users[caller] }
    else if (url.pathname.endsWith('/logout')) body = {}
    else if (url.pathname.endsWith('/public-feed')) { assert.equal(request.headers()['authorization'], undefined); body = envelope({ items: [], nextCursor: null }) }
    else if (url.pathname.endsWith('/social-api')) {
      assert.ok(caller >= 0, 'API gắn token đúng caller')
      if (input.action === 'getMe') body = envelope({ nickname: 'OUer offline', emailMasked: '***@ou.edu.vn', isAdmin: false })
      else if (input.action === 'listPosts') {
        lists.push(input.payload)
        body = envelope(input.payload.cursor ? { items: [dto(2, caller)], nextCursor: null } : { items: [dto(1, caller)], nextCursor: 'opaque-offline-cursor' })
      } else if (input.action === 'getPost') body = envelope(dto(1, caller))
      else if (input.action === 'listComments') body = envelope({ items: [], nextCursor: null })
      else if (input.action === 'toggleUpvote') {
        assert.deepEqual(Object.keys(input.payload).sort(), ['desiredState', 'postId'])
        assert.equal(typeof input.payload.desiredState, 'boolean')
        assert.equal(input.payload.postId, id(1))
        calls.push({ ...input.payload, caller })
        const selected = mode
        if (selected.startsWith('hold')) { held = true; await new Promise(done => { release = done }) }
        if (selected === 'error') { status = 500; body = failure('INTERNAL_ERROR') }
        else if (selected === 'hold401') { status = 401; body = failure('UNAUTHENTICATED') }
        else {
          if (input.payload.desiredState) votes[0].add(caller); else votes[0].delete(caller)
          if (selected === 'lost') return route.abort()
          const post = dto(1, caller)
          body = envelope({ hasUpvoted: post.hasUpvoted, upvoteCount: post.upvoteCount })
        }
      } else assert.fail('Action ngoài scope browser upvote')
    } else assert.fail('Endpoint ngoài mock, không gọi Cloud')
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body), headers: { 'access-control-allow-origin': '*' } })
  })
  const button = () => page.locator('.upvote-button').first()
  async function state(pressed, count) {
    await page.waitForFunction(({ pressed, count }) => {
      const button = document.querySelector('.upvote-button')
      return button?.getAttribute('aria-pressed') === String(pressed) && button.textContent.trim() === `${count} bình chọn` && !button.disabled
    }, { pressed, count })
  }
  async function login(caller = 0) {
    if (await page.locator('input[name=email]').count() === 0) await page.goto(origin + '/dang-nhap')
    await page.getByLabel('Email trường', { exact: true }).fill(users[caller].email)
    await page.getByLabel('Mật khẩu', { exact: true }).fill('Offline-password!')
    await page.getByRole('button', { name: 'Đăng nhập', exact: true }).click()
    await page.locator('.upvote-button').first().waitFor()
  }
  async function shot(name, width, theme) {
    await page.setViewportSize({ width, height: width < 600 ? 860 : 960 })
    if (await page.getAttribute('html', 'data-theme') !== theme) await page.getByRole('button', { name: /Chuyển giao diện/ }).click()
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'không overflow')
    const bounds = await button().boundingBox()
    assert.ok(bounds.width >= 44 && bounds.height >= 44, 'touch target tối thiểu 44px')
    await page.screenshot({ path: join(artifacts, `${name}-${width}-${theme}.png`), fullPage: true }); shots++
  }
  async function waitHeld() {
    for (let n = 0; n < 100 && !held; n++) await page.waitForTimeout(10)
    assert.ok(held, 'request đã tới mock')
  }
  async function waitPending() {
    // Request tới mock chưa bảo đảm React đã commit notify của mutation cache.
    await page.waitForFunction(() => {
      const button = document.querySelector('.upvote-button')
      return button?.getAttribute('aria-pressed') === 'true' && button.getAttribute('aria-busy') === 'true' && button.disabled && /^4/.test(button.textContent)
    })
  }
  async function back() { await page.getByRole('link', { name: 'Bảng tin', exact: true }).click(); await button().waitFor() }
  await mkdir(artifacts, { recursive: true })
  await page.goto(origin + '/dang-nhap'); await page.waitForURL('**/dang-nhap'); await login(); await state(false, 3)
  for (const width of [360, 390, 768, 1280]) for (const theme of ['dark', 'light']) await shot('feed-outline', width, theme)

  mode = 'hold'; held = false; const before = calls.length
  await button().click(); await waitHeld()
  await waitPending()
  assert.equal(new URL(page.url()).pathname, '/bang-tin')
  assert.equal(await button().getAttribute('aria-pressed'), 'true')
  assert.equal(await button().getAttribute('aria-busy'), 'true')
  assert.match(await button().textContent(), /^4/)
  assert.equal(await button().isDisabled(), true)
  await button().evaluate(node => { node.click(); node.click() })
  assert.equal(calls.length, before + 1, 'double click không gửi thêm')
  for (const theme of ['dark', 'light']) await shot('pending', 390, theme)
  await page.getByRole('link', { name: 'Mở bài viết và bình luận', exact: true }).first().click()
  await page.locator('.post-thread .upvote-button').waitFor()
  await waitPending()
  assert.equal(await button().getAttribute('aria-pressed'), 'true', 'Detail đang chờ giữ intent của Feed')
  assert.match(await button().textContent(), /^4/)
  assert.equal(await button().isDisabled(), true)
  mode = 'ready'; release(); await state(true, 4)
  assert.equal(await button().getAttribute('aria-label'), 'Bỏ upvote bài viết')
  for (const width of [360, 390, 768, 1280]) for (const theme of ['dark', 'light']) await shot('detail-active', width, theme)
  await back(); await state(true, 4)
  await button().click(); await state(false, 3)
  await button().focus(); await page.keyboard.press('Enter'); await state(true, 4)
  await button().click(); await state(false, 3)

  mode = 'error'; await button().click(); await page.locator('.vote-error').waitFor()
  assert.equal(await button().getAttribute('aria-pressed'), 'false')
  assert.match(await button().textContent(), /^3/)
  assert.doesNotMatch(await page.locator('.social-wrap').innerText(), /PRIVATE|SQL|JWT|secret@/)
  for (const theme of ['dark', 'light']) await shot('error-rollback', 360, theme)
  const failed = calls.at(-1)
  mode = 'ready'; await page.getByRole('button', { name: 'Thử lại bình chọn', exact: true }).click(); await state(true, 4)
  assert.deepEqual(calls.at(-1), failed)
  await button().click(); await state(false, 3)
  mode = 'lost'; await button().click(); await page.locator('.vote-error').waitFor()
  await page.waitForFunction(() => document.querySelector('.upvote-button')?.getAttribute('aria-pressed') === 'true')
  const lost = calls.at(-1)
  mode = 'ready'; await page.getByRole('button', { name: 'Thử lại bình chọn', exact: true }).click(); await state(true, 4)
  assert.deepEqual(calls.at(-1), lost, 'retry lost ACK phải true, không đảo thành false')
  await button().click(); await state(false, 3)

  await page.getByRole('button', { name: 'Nổi bật 24h', exact: true }).click()
  await page.getByRole('button', { name: 'Tải thêm', exact: true }).click()
  await page.waitForFunction(() => document.querySelectorAll('.post-card').length === 2)
  const listStart = lists.length
  await button().click(); await state(true, 4)
  await page.waitForFunction(() => document.querySelectorAll('.post-card').length === 1)
  assert.deepEqual(lists.slice(listStart), [{ sort: 'HOT', tag: null, cursor: null, limit: 20 }], 'HOT restart cursor null')

  mode = 'hold401'; held = false; await button().click(); await waitHeld()
  await page.getByRole('link', { name: 'Cá nhân', exact: true }).click()
  await page.getByRole('button', { name: 'Đăng xuất', exact: true }).click()
  await page.waitForURL(origin + '/bang-tin')
  mode = 'ready'; await login(1); await state(false, 4)
  release(); await page.waitForTimeout(100)
  assert.equal(new URL(page.url()).pathname, '/bang-tin', '401 phiên cũ không logout phiên B')
  await state(false, 4)
  assert.equal(await page.locator('.vote-error').count(), 0)
  assert.doesNotMatch(await page.locator('.feed-list').innerHTML(), new RegExp(`${users[0].id}|${users[0].email}|access_token|user_id`))
  assert.deepEqual(errors, [])
  console.log(`PASS: Upvote browser offline — ${shots} ảnh; optimistic/pending/double-click, Feed→Detail, keyboard/aria, rollback/retry/lost ACK, HOT reset và đổi phiên. Không gọi Cloud.`)
  console.log('Ảnh dữ liệu giả: frontend/node_modules/.cache/theou-votes-ui/ (gitignored).')
} finally { release?.(); await browser?.close(); server.kill() }
