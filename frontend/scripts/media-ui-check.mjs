// Mọi Auth/API/Storage đều giả lập, chỉ mạng loopback và offline.example.invalid.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { chromium } from 'playwright-core'

const root = fileURLToPath(new URL('../', import.meta.url))
const origin = 'http://127.0.0.1:5192'
const artifacts = join(root, 'node_modules/.cache/theou-media-ui')
const server = spawn(process.execPath, [
  'node_modules/vite/bin/vite.js',
  '--host',
  '127.0.0.1',
  '--port',
  '5192',
  '--strictPort',
], {
  cwd: root,
  windowsHide: true,
  stdio: 'ignore',
  env: {
    ...process.env,
    VITE_SUPABASE_URL: 'https://offline.example.invalid',
    VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_offline_ui',
  },
})
const id = (n) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const user = {
  id: id(900),
  email: 'offline.student@ou.edu.vn',
  email_confirmed_at: '2026-11-01T00:00:00Z',
  aud: 'authenticated',
  app_metadata: {},
  user_metadata: {},
}
const token = `${Buffer.from('{"alg":"HS256"}').toString('base64url')}.${
  Buffer.from(JSON.stringify({ sub: user.id, exp: 4000000000 })).toString('base64url')
}.offline`
const session = {
  user,
  access_token: token,
  refresh_token: 'offline-refresh',
  token_type: 'bearer',
  expires_in: 3600,
}
const envelope = (data) => ({ data, error: null, meta: { requestId: id(999) } })
const failure = (code) => ({
  data: null,
  error: { code, message: 'SECRET SQL RAW must not display', details: null },
  meta: { requestId: id(999) },
})
let mediaCount = 1,
  expired = false,
  shortExpiry = false,
  recoverExpiry = false,
  imageError = false,
  recoverImage = false,
  readError = false,
  holdRead = false,
  releaseRead,
  readHeld,
  holdImage = false,
  imageHeld,
  releaseImage,
  uploadFail = false,
  holdUpload = false,
  release,
  held = false,
  browser,
  shots = 0,
  reads = 0,
  imageReads = 0
let voted = false
const reservations = new Map(), uploaded = new Set(), ready = new Set(), calls = []
const dto = () => ({
  id: id(1),
  tag: 'CONFESSION',
  body: 'Ảnh giả lập màu sắc hình học. ' + 'Nội dung dài an toàn. '.repeat(8),
  displayMode: 'ANONYMOUS',
  authorLabel: 'OUer ẩn danh',
  contactUrl: null,
  publishedAt: '2026-11-17T00:00:00Z',
  upvoteCount: Number(voted),
  commentCount: 0,
  hasUpvoted: voted,
  isMine: true,
  images: Array.from(
    { length: mediaCount },
    (_, n) => ({
      id: id(10 + n),
      signedUrl: `https://offline.example.invalid/storage/v1/object/sign/post-media/posts/${id(1)}/${
        id(10 + n)
      }.${n ? 'webp' : 'png'}?token=offline-read-${reads}`,
      expiresAt: new Date(Date.now() + (expired ? -1000 : shortExpiry ? 500 : 300000)).toISOString(),
    }),
  ),
})
try {
  for (let n = 0; n < 100; n++) {
    try {
      if ((await fetch(origin)).ok) break
    } catch { /* Chờ Vite local. */ }
    await new Promise((r) => setTimeout(r, 50))
  }
  browser = await chromium.launch({
    executablePath: process.env.THEOU_BROWSER_PATH ??
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    headless: true,
  })
  const context = await browser.newContext({ reducedMotion: 'reduce' })
  const page = await context.newPage()
  const mockImages = await page.evaluate(() => [false, true].map(portrait => {
    const canvas = document.createElement('canvas')
    canvas.width = portrait ? 600 : 900
    canvas.height = portrait ? 800 : 600
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = portrait ? '#2b526e' : '#f1c2a4'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.fillStyle = portrait ? '#aac9bc' : '#bc684b'
    ctx.fillRect(60, 80, canvas.width - 120, canvas.height - 160)
    ctx.fillStyle = '#fbf4de'
    ctx.beginPath(); ctx.arc(canvas.width / 2, canvas.height / 2, 110, 0, Math.PI * 2); ctx.fill()
    const mime = portrait ? 'image/webp' : 'image/png'
    return { mime, bytes: canvas.toDataURL(mime).split(',')[1] }
  }))
  page.setDefaultTimeout(10000)
  const runtimeErrors = []
  page.on('pageerror', () => runtimeErrors.push('runtime-error'))
  await context.route('**/*', async (route) => {
    const req = route.request(), url = new URL(req.url())
    if (url.origin === origin) return route.continue()
    if (url.origin !== 'https://offline.example.invalid') return route.abort()
    if (url.pathname.startsWith('/storage/v1/object/sign/')) {
      imageReads++
      if (holdImage) { imageHeld = true; await new Promise(resolve => { releaseImage = resolve }) }
      const image = mockImages[url.pathname.endsWith('.webp') ? 1 : 0]
      return imageError
        ? route.fulfill({ status: 403, body: '' })
        : route.fulfill({ status: 200, contentType: image.mime, body: Buffer.from(image.bytes, 'base64') })
    }
    if (url.pathname.startsWith('/storage/v1/object/upload/sign/post-media/')) {
      assert.equal(req.method(), 'PUT')
      assert.notEqual(req.headers()['x-upsert'], 'true')
      const path = url.pathname.split('/post-media/')[1]
      assert.ok(reservations.has(path))
      const body = req.postDataBuffer()
      assert.ok(body)
      assert.equal(body.includes(Buffer.from('SYNTHETIC-GPS')), false)
      assert.equal(body.includes(Buffer.from('original-gps-photo')), false)
      if (holdUpload) {
        held = true
        await new Promise((done) => {
          release = done
        })
      }
      if (uploadFail) return route.fulfill({ status: 500, json: { error: 'PRIVATE storage error' } })
      uploaded.add(path)
      return route.fulfill({ status: 200, json: { Key: `post-media/${path}` } })
    }
    const input = req.postDataJSON() ?? {}
    let body, status = 200
    if (url.pathname.endsWith('/token')) body = session
    else if (url.pathname.endsWith('/user')) body = user
    else if (url.pathname.endsWith('/logout')) body = {}
    else if (url.pathname.endsWith('/social-api')) {
      assert.equal(req.headers().authorization, `Bearer ${token}`)
      calls.push(input.action)
      if (input.action === 'getMe') {
        body = envelope({ nickname: 'OUer offline', emailMasked: '***@ou.edu.vn', isAdmin: false })
      } else if (input.action === 'listPosts') body = envelope({ items: [dto()], nextCursor: null })
      else if (input.action === 'getPost') {
        reads++
        if (holdRead) { readHeld = true; await new Promise(resolve => { releaseRead = resolve }) }
        if (recoverExpiry) { expired = false; shortExpiry = false }
        if (recoverImage) imageError = false
        if (readError) { status = 500; body = failure('INTERNAL_ERROR') }
        else body = envelope(dto())
      } else if (input.action === 'listComments') body = envelope({ items: [], nextCursor: null })
      else if (input.action === 'toggleUpvote') { voted = input.payload.desiredState; body = envelope({ hasUpvoted: voted, upvoteCount: Number(voted) }) }
      else if (input.action === 'createPost') body = envelope({ postId: id(1), status: 'DRAFT' })
      else if (input.action === 'createImageUpload') {
        const p = input.payload
        assert.ok(p.sizeBytes <= 2097152)
        assert.ok(['image/png', 'image/jpeg', 'image/webp'].includes(p.mimeType))
        const imageId = id(100 + p.position),
          path = `posts/${p.postId}/${imageId}.${
            { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[p.mimeType]
          }`
        reservations.set(path, p)
        body = envelope({ imageId, path, token: 'offline-only-upload' })
      } else if (input.action === 'finalizeImage') {
        const entry = [...reservations].find(([path]) => path.includes(input.payload.imageId))
        if (!entry || !uploaded.has(entry[0])) {
          status = 422
          body = failure('UPLOAD_ERROR')
        } else {
          ready.add(input.payload.imageId)
          body = envelope({ imageId: input.payload.imageId, status: 'READY' })
        }
      } else if (input.action === 'removeDraftImage') {
        body = envelope({ success: true })
        ready.delete(input.payload.imageId)
      } else if (input.action === 'publishPost') {
        assert.equal(ready.size, 2)
        body = envelope(dto())
      } else throw new Error('Unexpected mocked action')
    } else throw new Error('Unexpected network path')
    return route.fulfill({ status, json: body })
  })
  await mkdir(artifacts, { recursive: true })
  const shot = async (name, width, theme) => {
    await page.setViewportSize({ width, height: 900 })
    await page.evaluate((theme) => document.documentElement.dataset.theme = theme, theme)
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }))
    await page.waitForTimeout(60)
    assert.ok(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      `${name}/${width}: overflow`,
    )
    await page.screenshot({ path: join(artifacts, `${name}-${width}-${theme}.png`), fullPage: true })
    shots++
  }
  const series = async (name) => {
    for (const width of [360, 390, 768, 1280]) {
      for (const theme of ['dark', 'light']) await shot(name, width, theme)
    }
  }
  await page.goto(origin)
  await page.getByLabel('Email trường', { exact: true }).fill(user.email)
  await page.getByLabel('Mật khẩu', { exact: true }).fill('Offline-Password-Only-123')
  await page.getByRole('button', { name: 'Đăng nhập', exact: true }).click()
  await page.waitForURL(origin + '/')
  {
    mediaCount = 2
    await page.goto(`${origin}/bai-viet/${id(1)}`)
    await page.getByRole('button', { name: 'Ảnh tiếp theo', exact: true }).click()
    await page.waitForFunction(() => document.querySelector('.post-image-frame img')?.naturalWidth > 0)
    const start = { reads, imageReads, calls: calls.length }
    const other = await context.newPage()
    await other.bringToFront()
    const hidden = await page.evaluate(() => document.visibilityState)
    await page.bringToFront()
    await other.close()
    await page.evaluate(() => {
      window.__mediaNode = document.querySelector('.post-image-frame img')
      window.__loadingSeen = false
      window.__mediaObserver = new MutationObserver(() => {
        if (document.querySelector('.image-placeholder')) window.__loadingSeen = true
      })
      window.__mediaObserver.observe(document.body, { childList: true, subtree: true })
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
      document.dispatchEvent(new Event('visibilitychange', { bubbles: true }))
    })
    await page.waitForTimeout(100)
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
      document.dispatchEvent(new Event('visibilitychange', { bubbles: true }))
    })
    await page.waitForTimeout(1000)
    assert.equal(reads, start.reads); assert.equal(imageReads, start.imageReads); assert.equal(calls.length, start.calls)
    assert.deepEqual(await page.evaluate(() => ({ sameImageNode: window.__mediaNode === document.querySelector('.post-image-frame img'), loadingSeen: window.__loadingSeen, slide: document.querySelector('.carousel-counter')?.textContent })), { sameImageNode: true, loadingSeen: false, slide: '2/2' })
    console.log(`PASS: FOCUS_UNDER_TTL; getPost=0; allSocialApi=0; imageRequests=0; sameNode=true; loading=false; slide=2/2; nativeBackgroundVisibility=${hidden}; visibility test simulated.`)
    shortExpiry = true
    await page.goto(`${origin}/bai-viet/${id(1)}`)
    await page.getByRole('button', { name: 'Ảnh tiếp theo', exact: true }).click()
    await page.waitForFunction(() => document.querySelector('.post-image-frame img')?.naturalWidth > 0)
    const expiryStart = reads
    await page.evaluate(() => {
      window.__mediaNode = document.querySelector('.post-image-frame img')
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
      document.dispatchEvent(new Event('visibilitychange', { bubbles: true }))
    })
    await page.waitForTimeout(1000)
    assert.equal(reads, expiryStart, 'Expiry hidden không gửi API')
    assert.equal(await page.evaluate(() => window.__mediaNode === document.querySelector('.post-image-frame img')), true)
    holdRead = true; readHeld = false; recoverExpiry = true
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
      document.dispatchEvent(new Event('visibilitychange', { bubbles: true }))
      for (let n = 0; n < 5; n++) window.dispatchEvent(new Event('focus'))
    })
    for (let n = 0; n < 100 && !readHeld; n++) await page.waitForTimeout(20)
    assert.equal(reads, expiryStart + 1)
    assert.equal(await page.locator('.image-placeholder').count(), 0)
    holdImage = true; imageHeld = false
    holdRead = false; releaseRead()
    for (let n = 0; n < 100 && !imageHeld; n++) await page.waitForTimeout(20)
    assert.ok(imageHeld)
    assert.equal(await page.evaluate(() => window.__mediaNode === document.querySelector('.post-image-frame img')), true)
    assert.equal(await page.locator('.image-placeholder').count(), 0, 'Giữ ảnh cũ khi URL mới chưa decode')
    holdImage = false; releaseImage()
    await page.waitForTimeout(700)
    assert.equal(reads, expiryStart + 1)
    assert.equal(await page.locator('.carousel-counter').innerText(), '2/2')
    assert.equal(await page.evaluate(() => window.__mediaNode === document.querySelector('.post-image-frame img')), true)
    await series('focus-expired-refreshed')
    console.log('PASS: FOCUS_AFTER_TTL; hiddenGetPost=0; foregroundGetPost=1; overlapFocus=5; sameNode=true; loading=false; slide=2/2.')
    // Refetch Detail đang pending và expiry phải dùng chung một request, giữ optimistic vote.
    recoverExpiry = false; shortExpiry = true; voted = false
    await page.reload()
    await page.getByRole('button', { name: 'Ảnh tiếp theo', exact: true }).click()
    await page.waitForFunction(() => document.querySelector('.post-image-frame img')?.naturalWidth > 0)
    holdRead = true; readHeld = false; recoverExpiry = true
    const overlapStart = reads
    await page.getByRole('button', { name: 'Upvote bài viết', exact: true }).click()
    for (let n = 0; n < 100 && !readHeld; n++) await page.waitForTimeout(20)
    await page.waitForTimeout(850)
    assert.equal(reads, overlapStart + 1)
    assert.equal(await page.locator('.image-placeholder').count(), 0)
    await page.getByRole('button', { name: 'Bỏ upvote bài viết', exact: true }).waitFor()
    holdRead = false; releaseRead()
    await page.waitForTimeout(750)
    assert.equal(reads, overlapStart + 1)
    assert.equal(await page.locator('.carousel-counter').innerText(), '2/2')
    assert.equal(await page.locator('.image-placeholder').count(), 0)
    await page.getByRole('button', { name: 'Ảnh trước', exact: true }).click()
    await page.waitForFunction(() => document.querySelector('.post-image-frame img')?.naturalWidth > 0)
    assert.equal(reads, overlapStart + 1, 'URL mới cho cả hai ảnh, không xin riêng từng slide')
    console.log('PASS: DETAIL_QUERY_EXPIRY_OVERLAP; getPost=1; bothImagesReady=true; optimisticVoteRetained=true; slideRetained=true.')
    recoverExpiry = false; voted = false
  }
  mediaCount = 0
  await page.goto(origin)
  await page.locator('.post-card').waitFor()
  assert.equal(await page.locator('.post-images').count(), 0)
  await series('feed-no-images')
  mediaCount = 1
  await page.reload()
  await page.locator('.post-image-frame img').waitFor()
  assert.equal(await page.locator('.carousel-counter,.carousel-control').count(), 0)
  await series('feed-one-image')
  await page.getByRole('link', { name: 'Mở ảnh 1 và chi tiết bài viết', exact: true }).click()
  await page.waitForURL(`**/bai-viet/${id(1)}`)
  await series('detail-one-image')
  mediaCount = 2
  await page.goto(origin)
  await page.locator('.post-image-frame img').waitFor()
  assert.equal(await page.locator('.post-image-frame img').count(), 1)
  assert.equal(await page.locator('.carousel-counter').innerText(), '1/2')
  assert.equal(await page.locator('.post-card a a,.post-card a button').count(), 0)
  assert.ok(await page.locator('.post-content-column').evaluate(column => {
    const nodes = ['.post-header', '.post-body', '.post-images', '.post-stats', '.post-meta'].map(selector => column.querySelector(selector))
    return nodes.every((node, index) => node && (!index || !!(nodes[index - 1].compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING)))
  }))
  assert.equal(await page.getByRole('button', { name: 'Tải lại ảnh', exact: true }).count(), 0)
  await series('feed-two-images')
  await page.getByRole('button', { name: 'Ảnh tiếp theo', exact: true }).click()
  assert.equal(await page.locator('.carousel-counter').innerText(), '2/2')
  assert.equal(new URL(page.url()).pathname, '/', 'Gallery controls không mở Detail')
  await series('feed-second-image')
  assert.ok(await page.locator('.post-image-frame img').evaluate(img => getComputedStyle(img).objectFit === 'contain'))
  await page.getByRole('button', { name: 'Ảnh trước', exact: true }).click()
  assert.equal(await page.locator('.carousel-counter').innerText(), '1/2')
  const gallery = page.getByRole('region', { name: 'Ảnh đính kèm bài viết', exact: true })
  await gallery.focus()
  await page.keyboard.press('ArrowRight')
  assert.equal(await page.locator('.carousel-counter').innerText(), '2/2')
  await page.keyboard.press('Home')
  assert.equal(await page.locator('.carousel-counter').innerText(), '1/2')
  await page.keyboard.press('End')
  await page.keyboard.press('ArrowLeft')
  assert.equal(await page.locator('.carousel-counter').innerText(), '1/2')
  await page.getByRole('button', { name: 'Ảnh tiếp theo', exact: true }).focus()
  await page.keyboard.press('ArrowRight')
  assert.equal(await gallery.evaluate(node => document.activeElement === node), true)
  await page.keyboard.press('ArrowLeft')
  assert.equal(await page.locator('.carousel-counter').innerText(), '1/2')
  assert.equal(await gallery.evaluate(node => getComputedStyle(node).animationName), 'none')
  await page.setViewportSize({ width: 390, height: 600 })
  await page.locator('.post-carousel-viewport').scrollIntoViewIfNeeded()
  const cdp = await context.newCDPSession(page)
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 })
  const swipe = async (horizontal, direction = -1) => {
    await page.locator('.post-carousel-viewport').scrollIntoViewIfNeeded()
    const rect = await page.locator('.post-carousel-viewport').boundingBox()
    const x = rect.x + rect.width * .75, y = Math.max(80, rect.y + Math.min(rect.height / 2, 200))
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] })
    for (let step = 1; step <= 6; step++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + (horizontal ? direction * rect.width * .5 * step / 6 : 0), y: y + (horizontal ? 0 : direction * 100 * step / 6) }] })
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  }
  await swipe(true)
  await page.waitForFunction(() => document.querySelector('.carousel-counter')?.textContent === '2/2')
  assert.equal(new URL(page.url()).pathname, '/', 'Swipe không mở Detail')
  await swipe(true, 1)
  await page.waitForFunction(() => document.querySelector('.carousel-counter')?.textContent === '1/2')
  const beforeScroll = await page.evaluate(() => scrollY)
  await swipe(false)
  await page.waitForTimeout(100)
  assert.ok(await page.evaluate(before => scrollY > before, beforeScroll), 'Cuộn dọc trên ảnh vẫn hoạt động')
  assert.equal(await page.locator('.carousel-counter').innerText(), '1/2')
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false })
  await cdp.detach()
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.__copied = text } } }))
  await page.getByRole('button', { name: 'Sao chép liên kết bài', exact: true }).click()
  assert.equal(await page.evaluate(() => window.__copied), `${origin}/bai-viet/${id(1)}`)
  await page.getByRole('button', { name: 'Upvote bài viết', exact: true }).click()
  await page.getByRole('button', { name: 'Bỏ upvote bài viết', exact: true }).waitFor()
  assert.equal(new URL(page.url()).pathname, '/')
  await page.getByRole('link', { name: 'Mở ảnh 1 và chi tiết bài viết', exact: true }).click()
  await page.waitForURL(`**/bai-viet/${id(1)}`)
  await page.locator('.post-thread').waitFor()
  await page.locator('.toast.show').waitFor({ state: 'hidden' })
  assert.equal(await page.locator('.post-thread .post-image-link').count(), 0, 'Detail không self-link')
  await series('detail-two-images')
  await page.getByRole('button', { name: 'Ảnh tiếp theo', exact: true }).click()
  await series('detail-second-image')
  await page.goto(origin)
  const waitForReads = async target => {
    for (let n = 0; n < 100 && reads < target; n++) await page.waitForTimeout(40)
    assert.equal(reads, target)
  }
  imageError = true
  const beforeFailure = reads
  await page.reload()
  await waitForReads(beforeFailure + 3)
  await page.getByText('Ảnh tạm thời chưa hiển thị.').waitFor()
  await page.waitForTimeout(800)
  assert.equal(reads, beforeFailure + 3, 'Giới hạn tự refetch, kể cả mỗi lần trả URL mới')
  await series('image-error-placeholder')
  await page.getByRole('button', { name: 'Ảnh tiếp theo', exact: true }).click()
  await page.waitForTimeout(450)
  assert.equal(reads, beforeFailure + 3, 'Đổi slide không reset ngân sách')
  assert.equal(await page.getByRole('button', { name: /Tải lại ảnh|Đang tải lại|Hãy tải lại trang/ }).count(), 0)
  imageError = false
  await page.reload()
  await page.waitForFunction(() => document.querySelector('.post-image-frame img')?.naturalWidth > 0)
  imageError = true; recoverImage = true
  const beforeRecovery = reads
  await page.getByRole('button', { name: 'Ảnh tiếp theo', exact: true }).click()
  await waitForReads(beforeRecovery + 1)
  await page.waitForFunction(() => document.querySelector('.post-image-frame img')?.naturalWidth > 0)
  assert.equal(await page.locator('.carousel-counter').innerText(), '2/2', 'Refetch URL không đưa carousel về ảnh đầu')
  recoverImage = false
  expired = true
  recoverExpiry = true
  const beforeExpiry = reads
  await page.reload()
  await waitForReads(beforeExpiry + 1)
  await page.waitForFunction(() => document.querySelector('.post-image-frame img')?.naturalWidth > 0)
  recoverExpiry = false; expired = true
  const beforeExpiredLimit = reads
  await page.reload()
  await waitForReads(beforeExpiredLimit + 3)
  await page.waitForTimeout(450)
  assert.equal(reads, beforeExpiredLimit + 3)
  assert.equal(await page.locator('.post-image-frame img').count(), 0)
  expired = false; recoverExpiry = true
  shortExpiry = true
  const beforeTimer = reads
  await page.reload()
  await waitForReads(beforeTimer + 1)
  recoverExpiry = false
  imageError = true; readError = true
  const beforeApiError = reads
  await page.reload()
  await waitForReads(beforeApiError + 3)
  await page.waitForTimeout(450)
  assert.equal(reads, beforeApiError + 3)
  assert.doesNotMatch(await page.locator('.post-card').innerText(), /offline-read|storage\/v1|SECRET|SQL|https:\/\//)
  readError = false; holdRead = true; readHeld = false
  await page.reload()
  for (let n = 0; n < 100 && !readHeld; n++) await page.waitForTimeout(30)
  assert.ok(readHeld)
  await page.getByRole('link', { name: 'Cá nhân', exact: true }).click()
  await page.getByRole('button', { name: 'Đăng xuất', exact: true }).click()
  await page.waitForURL('**/dang-nhap')
  holdRead = false; imageError = false; releaseRead()
  await page.waitForTimeout(400)
  assert.equal(await page.locator('.post-images').count(), 0, 'Late URL không tái xuất hiện sau logout')
  await page.getByLabel('Email trường', { exact: true }).fill(user.email)
  await page.getByLabel('Mật khẩu', { exact: true }).fill('Offline-Password-Only-123')
  await page.getByRole('button', { name: 'Đăng nhập', exact: true }).click()
  await page.waitForURL(origin + '/')
  await page.getByRole('link', { name: 'Viết bài', exact: true }).click()
  await series('composer-empty')
  const processed = await page.evaluate(async () => {
    const { processImage } = await import('/src/features/posts/image-processing.ts')
    const canvas = document.createElement('canvas')
    canvas.width = 2400
    canvas.height = 1200
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#fd7c3a'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    const results = []
    for (const type of ['image/jpeg', 'image/png', 'image/webp']) {
      const input = await new Promise((resolve) => canvas.toBlob(resolve, type))
      const output = await processImage(input)
      const bitmap = await createImageBitmap(output)
      results.push({ type: output.type, width: bitmap.width, height: bitmap.height, size: output.size })
      bitmap.close()
    }
    let rejected = false
    try {
      await processImage(new Blob(['<svg/>'], { type: 'image/png' }))
    } catch {
      rejected = true
    }
    return { results, rejected }
  })
  assert.equal(processed.rejected, true)
  assert.deepEqual(processed.results.map((value) => value.type), ['image/jpeg', 'image/png', 'image/webp'])
  assert.ok(
    processed.results.every((value) =>
      value.width === 2048 && value.height === 1024 && value.size > 0 && value.size <= 2097152
    ),
  )
  // PNG có tEXt giả; canvas reencode phải loại marker metadata khỏi bytes upload.
  const base = await page.evaluate(() => {
    const c = document.createElement('canvas')
    c.width = 240
    c.height = 160
    const ctx = c.getContext('2d')
    ctx.fillStyle = '#fd7c3a'
    ctx.fillRect(0, 0, 240, 160)
    ctx.fillStyle = '#5f8cec'
    ctx.fillRect(40, 40, 140, 80)
    return c.toDataURL('image/png').split(',')[1]
  })
  const raw = Buffer.from(base, 'base64'),
    chunkType = Buffer.from('tEXt'),
    text = Buffer.from('Note\0SYNTHETIC-GPS')
  let crc = 0xffffffff
  for (const byte of Buffer.concat([chunkType, text])) {
    crc ^= byte
    for (let n = 0; n < 8; n++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
  }
  const size = Buffer.alloc(4), end = Buffer.alloc(4)
  size.writeUInt32BE(text.length)
  end.writeUInt32BE((crc ^ 0xffffffff) >>> 0)
  const synthetic = Buffer.concat([raw.subarray(0, 33), size, chunkType, text, end, raw.subarray(33)])
  const selected = { name: 'original-gps-photo.png', mimeType: 'image/png', buffer: synthetic }
  await page.locator('input[type=file]').setInputFiles(selected)
  await page.locator('.draft-image').waitFor()
  await series('composer-one-image')
  await page.locator('input[type=file]').setInputFiles(selected)
  await page.locator('.draft-image').nth(1).waitFor()
  await series('composer-two-images')
  await page.getByRole('button', { name: 'Gỡ ảnh 2', exact: true }).click()
  assert.equal(await page.locator('.draft-image').count(), 1)
  await page.locator('input[type=file]').setInputFiles(selected)
  await page.locator('.draft-image').nth(1).waitFor()
  await page.getByLabel('Câu chuyện của bạn').fill('Bài có hai ảnh giả lập, không dữ liệu cá nhân.')
  holdUpload = true
  await page.getByRole('button', { name: 'Đăng bài', exact: true }).click()
  await page.waitForFunction(() =>
    document.querySelector('.draft-image')?.textContent.includes('Đang tải lên')
  )
  for (let n = 0; n < 100 && !held; n++) await page.waitForTimeout(20)
  assert.ok(held)
  await series('upload-pending')
  assert.ok(await page.getByRole('button', { name: 'Gỡ ảnh 1', exact: true }).isDisabled())
  uploadFail = true
  holdUpload = false
  release()
  await page.getByRole('button', { name: 'Thử lại hoàn tất đăng bài', exact: true }).waitFor()
  await series('upload-error-retry')
  assert.doesNotMatch(
    await page.locator('.composer-card').innerText(),
    /PRIVATE|SECRET|SQL|offline-only-upload/,
  )
  uploadFail = false
  await page.getByRole('button', { name: 'Thử lại hoàn tất đăng bài', exact: true }).click()
  await page.waitForURL(origin + '/')
  assert.equal(calls.filter((action) => action === 'createPost').length, 1)
  assert.equal(calls.filter((action) => action === 'publishPost').length, 1)
  assert.deepEqual(runtimeErrors, [])
  console.log(
    `PASS: media browser offline; ${shots} screenshots; xử lý metadata, 0/1/2 ảnh, remove, upload pending/error/retry, gallery/expiry/retry, responsive/theme. Không gọi Cloud.`,
  )
} finally {
  releaseImage?.()
  releaseRead?.()
  release?.()
  await browser?.close()
  server.kill()
}
