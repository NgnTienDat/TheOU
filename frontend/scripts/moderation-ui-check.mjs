// Chỉ Auth/API/bitmap tổng hợp; chặn mọi host ngoài Vite/host giả.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { chromium } from 'playwright-core'
const root = fileURLToPath(new URL('../', import.meta.url)), origin = 'http://127.0.0.1:5193'
const artifacts = join(root, 'node_modules/.cache/theou-moderation-ui')
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '5193', '--strictPort'], { cwd: root, windowsHide: true, stdio: 'ignore', env: { ...process.env, VITE_SUPABASE_URL: 'https://offline.example.invalid', VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_offline_ui' } })
const id = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const user = { id: id(900), email: 'offline@ou.edu.vn', email_confirmed_at: '2026-11-01T00:00:00Z', aud: 'authenticated', user_metadata: {}, app_metadata: {} }
const session = { user, access_token: `${Buffer.from('{"alg":"HS256"}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: user.id, exp: 4000000000 })).toString('base64url')}.offline`, refresh_token: 'offline-refresh', token_type: 'bearer', expires_in: 3600 }
const envelope = data => ({ data, error: null, meta: { requestId: id(999) } })
const failure = code => ({ data: null, error: { code, message: 'PRIVATE SQL JWT offline@ou.edu.vn', details: null }, meta: { requestId: id(999) } })
let admin = false, deleted = false, hidden = false, commentHidden = false, mode = '', held, release, browser, shots = 0
const calls = [], errors = []
const dto = n => ({ id: id(n), tag: 'CONFESSION', body: 'Nội dung bài viết giả lập an toàn.', displayMode: 'ANONYMOUS', authorLabel: 'OUer ẩn danh', contactUrl: null, publishedAt: '2026-11-18T00:00:00Z', upvoteCount: 0, commentCount: n === 1 && !commentHidden ? 1 : 0, hasUpvoted: false, isMine: n === 1,
  images: n === 1 ? [{ id: id(10), signedUrl: `https://offline.example.invalid/storage/v1/object/sign/post-media/posts/${id(1)}/${id(10)}.png?token=offline-read`, expiresAt: new Date(Date.now() + 300000).toISOString() }] : [] })
try {
  for (let n = 0; n < 100; n++) { try { if ((await fetch(origin)).ok) break } catch { /* Chờ Vite local. */ } await new Promise(resolve => setTimeout(resolve, 50)) }
  browser = await chromium.launch({ executablePath: process.env.THEOU_BROWSER_PATH ?? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', headless: true })
  const context = await browser.newContext({ reducedMotion: 'reduce' }), page = await context.newPage()
  const imageBytes = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 600; canvas.height = 400
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#51778b'; ctx.fillRect(0, 0, 600, 400)
    ctx.fillStyle = '#e6cda8'; ctx.fillRect(80, 60, 440, 280)
    return canvas.toDataURL('image/png').split(',')[1]
  })
  page.setDefaultTimeout(10000); page.on('pageerror', () => errors.push('runtime error'))
  await context.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url())
    if (url.origin === origin) return route.continue()
    if (url.origin !== 'https://offline.example.invalid') return route.abort()
    if (url.pathname.startsWith('/storage/')) return route.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from(imageBytes, 'base64') })
    const input = req.postDataJSON() ?? {}; let body, status = 200
    if (url.pathname.endsWith('/token')) body = session
    else if (url.pathname.endsWith('/user')) body = user
    else if (url.pathname.endsWith('/logout')) body = {}
    else if (url.pathname.endsWith('/public-feed')) { assert.equal(req.headers()['authorization'], undefined); body = envelope({ items: [], nextCursor: null }) }
    else if (url.pathname.endsWith('/social-api')) {
      assert.equal(req.headers().authorization, `Bearer ${session.access_token}`)
      if (input.action === 'getMe') body = envelope({ nickname: 'OUer offline', emailMasked: '***@ou.edu.vn', isAdmin: admin })
      else if (input.action === 'listPosts') body = envelope({ items: [...(!deleted && !hidden ? [dto(1)] : []), dto(2)], nextCursor: null })
      else if (input.action === 'getPost') { if (deleted || hidden) { status = 404; body = failure('NOT_FOUND') } else body = envelope(dto(1)) }
      else if (input.action === 'listComments') body = envelope({ items: commentHidden ? [] : [{ id: id(20), postId: id(1), body: 'Bình luận offline', authorLabel: 'Chủ bài', isOriginalPoster: true, isMine: true, createdAt: '2026-11-18T00:00:00Z' }], nextCursor: null })
      else if (['deletePost', 'adminHideContent'].includes(input.action)) {
        calls.push(input)
        const selected = mode
        if (selected === 'hold') { held = true; await new Promise(resolve => { release = resolve }) }
        if (selected === 'error') { status = 500; body = failure('INTERNAL_ERROR') }
        else if (selected === 'missing') { status = 404; body = failure('NOT_FOUND') }
        else if (selected === 'hold') { status = 401; body = failure('UNAUTHENTICATED') }
        else { if (input.action === 'deletePost') deleted = true; else if (input.payload.targetType === 'COMMENT') commentHidden = true; else hidden = true; body = envelope({ success: true }) }
      } else assert.fail('Action ngoài scope moderation mock')
    } else assert.fail('Endpoint ngoài scope mock')
    return route.fulfill({ status, json: body })
  })
  await mkdir(artifacts, { recursive: true })
  const shot = async name => {
    for (const width of [390, 1280]) for (const theme of ['dark', 'light']) {
      await page.setViewportSize({ width, height: 900 }); await page.evaluate(theme => { document.documentElement.dataset.theme = theme; window.scrollTo(0, 0) }, theme)
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      if (name === 'admin-form') assert.ok((await page.getByRole('heading', { name: 'Kiểm duyệt nội dung', exact: true }).boundingBox()).width > 100, 'Heading admin hiển thị cả mobile')
      await page.screenshot({ path: join(artifacts, `${name}-${width}-${theme}.png`), fullPage: true }); shots++
    }
  }
  const login = async () => { if (await page.locator('input[name=email]').count() === 0) await page.goto(origin + '/dang-nhap'); await page.getByLabel('Email trường', { exact: true }).fill(user.email); await page.getByLabel('Mật khẩu', { exact: true }).fill('Offline-password!'); await page.getByRole('button', { name: 'Đăng nhập', exact: true }).click(); await page.waitForURL(origin + '/') }
  const confirm = async (name, accept = true) => { page.once('dialog', dialog => accept ? dialog.accept() : dialog.dismiss()); await page.getByRole('button', { name, exact: true }).click() }
  await page.goto(origin + '/dang-nhap'); await page.waitForURL('**/dang-nhap'); await login()
  await page.getByRole('button', { name: 'Xóa bài viết', exact: true }).waitFor()
  assert.equal(await page.getByRole('button', { name: 'Xóa bài viết', exact: true }).count(), 1, 'chỉ owner có delete')
  await page.locator('.post-image-frame img').waitFor(); await shot('owner-feed')
  await confirm('Xóa bài viết', false); assert.equal(calls.length, 0)
  mode = 'error'; await confirm('Xóa bài viết'); await page.getByRole('alert').waitFor()
  assert.equal(await page.locator('.post-card').count(), 2); await shot('delete-error')
  assert.doesNotMatch(await page.locator('.social-wrap').innerText(), /PRIVATE|SQL|JWT|offline@|offline-read/)
  mode = ''; await page.getByRole('link', { name: 'Mở bài viết và bình luận', exact: true }).first().click()
  await page.locator('.post-thread').waitFor(); await shot('owner-detail')
  await confirm('Xóa bài viết'); await page.waitForURL(origin + '/')
  await page.waitForFunction(() => document.querySelectorAll('.post-card').length === 1)
  assert.equal(await page.locator('.post-images').count(), 0)
  await page.goto(origin + '/admin'); await page.getByRole('heading', { name: 'Không có quyền kiểm duyệt' }).waitFor()
  assert.equal(await page.locator('#moderation-target').count(), 0); await shot('admin-denied')
  admin = true; deleted = false; await page.reload()
  await page.getByRole('heading', { name: 'Kiểm duyệt nội dung', exact: true }).waitFor(); await shot('admin-form')
  const before = calls.length
  await page.getByRole('button', { name: 'Ẩn nội dung', exact: true }).click(); await page.getByRole('alert').waitFor(); assert.equal(calls.length, before)
  await page.getByLabel('UUID hoặc URL bài viết', { exact: true }).fill(`https://evil.invalid/bai-viet/${id(1)}`)
  await page.getByLabel('Lý do ẩn nội dung', { exact: true }).fill('Nội dung giả lập vi phạm.')
  await page.getByRole('button', { name: 'Ẩn nội dung', exact: true }).click(); assert.equal(calls.length, before)
  await page.getByLabel('UUID hoặc URL bài viết', { exact: true }).fill(`${origin}/bai-viet/${id(1)}`)
  await confirm('Ẩn nội dung', false); assert.equal(calls.length, before)
  mode = 'missing'; await confirm('Ẩn nội dung'); await page.getByText('Không tìm thấy nội dung hoặc bạn không được phép truy cập.').waitFor(); await shot('admin-missing')
  mode = ''; await page.getByLabel('Loại nội dung').selectOption('COMMENT'); await page.getByLabel('UUID bình luận', { exact: true }).fill(id(20))
  page.once('dialog', dialog => dialog.accept())
  await page.getByRole('button', { name: 'Ẩn nội dung', exact: true }).focus(); await page.keyboard.press('Enter')
  await page.getByText('Đã ẩn nội dung và ghi lịch sử kiểm duyệt.').waitFor(); await shot('admin-comment-success')
  assert.deepEqual(calls.at(-1).payload, { targetType: 'COMMENT', targetId: id(20), reason: 'Nội dung giả lập vi phạm.' })
  await page.goto(`${origin}/bai-viet/${id(1)}`); await page.getByText('Chưa có bình luận nào').waitFor()
  assert.match(await page.locator('.post-stats').innerText(), /0\s+bình luận/)
  await page.goto(origin + '/admin'); await page.getByLabel('UUID hoặc URL bài viết', { exact: true }).fill(id(1)); await page.getByLabel('Lý do ẩn nội dung', { exact: true }).fill('Nội dung giả lập vi phạm.')
  await confirm('Ẩn nội dung'); await page.getByText('Đã ẩn nội dung và ghi lịch sử kiểm duyệt.').waitFor(); await shot('admin-post-success')
  await page.goto(`${origin}/bai-viet/${id(1)}`); await page.getByRole('heading', { name: 'Không tìm thấy bài viết', exact: true }).waitFor()
  // Late Auth error của request cũ không được logout phiên mới.
  hidden = false; await page.goto(origin); mode = 'hold'; held = false; await confirm('Xóa bài viết')
  for (let n = 0; n < 100 && !held; n++) await page.waitForTimeout(20)
  assert.ok(held); assert.equal(await page.getByRole('button', { name: 'Xóa bài viết', exact: true }).isDisabled(), true)
  const count = calls.length; await page.getByRole('button', { name: 'Xóa bài viết', exact: true }).evaluate(node => { node.click(); node.click() }); assert.equal(calls.length, count)
  await page.getByRole('link', { name: 'Cá nhân', exact: true }).click(); await page.getByRole('button', { name: 'Đăng xuất', exact: true }).click(); await page.waitForURL(origin + '/')
  await login(); mode = ''; release(); await page.waitForTimeout(200); assert.equal(new URL(page.url()).pathname, '/')
  assert.deepEqual(errors, [])
  console.log(`PASS: T11 moderation browser offline; ${shots} screenshots, owner delete/cancel/error/pending/navigation/session, admin allow/deny/POST/COMMENT/validation, media/count/privacy,390/1280 dark/light. Không gọi Cloud.`)
} finally { release?.(); await browser?.close(); server.kill() }
