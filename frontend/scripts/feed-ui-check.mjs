// API/Auth giả lập toàn bộ; chặn mọi host ngoài Vite và host offline.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { chromium } from 'playwright-core'

const prototype = await readFile(new URL('../../docs/fe-templates/TheOU-Social-UI-Redesign-V2.html', import.meta.url), 'utf8')
const root = fileURLToPath(new URL('../', import.meta.url))
const artifacts = join(root, 'node_modules/.cache/theou-feed-ui')
const origin = 'http://127.0.0.1:5189'
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '5189', '--strictPort'], {
  cwd: root, windowsHide: true, stdio: 'ignore', env: { ...process.env, VITE_SUPABASE_URL: 'https://offline.example.invalid', VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_offline_ui' },
})
const id = number => `10000000-0000-4000-8000-${String(number).padStart(12, '0')}`
const user = { id: id(900), email: 'offline.student@ou.edu.vn', email_confirmed_at: '2026-11-01T00:00:00Z', aud: 'authenticated', app_metadata: {}, user_metadata: {} }
const jwt = `${Buffer.from('{"alg":"HS256"}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: user.id, exp: 4_000_000_000 })).toString('base64url')}.offline`
const session = { user, access_token: jwt, refresh_token: 'offline-refresh', token_type: 'bearer', expires_in: 3600 }
const envelope = data => ({ data, error: null, meta: { requestId: id(999) } })
const post = (number, changes = {}) => ({ id: id(number), tag: 'CONFESSION', body: `Câu chuyện offline ${number}.\n\nMột đoạn nhỏ dành cho OUer.`, displayMode: 'ANONYMOUS', authorLabel: 'OUer ẩn danh', contactUrl: null,
  publishedAt: new Date(Date.now() - number * 60_000).toISOString(), upvoteCount: number, commentCount: 2, hasUpvoted: false, isMine: number === 1, images: [], ...changes })
const first = post(1)
const second = post(2, { tag: 'TAI_LIEU', displayMode: 'NICKNAME', authorLabel: 'OUer snapshot', contactUrl: 'https://zalo.me/offline' })
let feedMode = 'many'
let createMode = 'normal'
let publishMode = 'normal'
let releaseList
let releasePublish
let holding
let browser
let shots = 0
const listCalls = []
const createCalls = []
const publishCalls = []
const drafts = new Map()
let createFailed = false
let publishFailed = false
try {
  for (let count = 0; count < 100; count++) {
    try { if ((await fetch(origin)).ok) break } catch { /* Chờ Vite local. */ }
    await new Promise(done => setTimeout(done, 50))
  }
  browser = await chromium.launch({ executablePath: process.env.THEOU_BROWSER_PATH ?? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', headless: true })
  const context = await browser.newContext({ reducedMotion: 'reduce' })
  const page = await context.newPage()
  page.setDefaultTimeout(10_000)
  const runtimeErrors = []
  page.on('pageerror', () => runtimeErrors.push('runtime error'))
  await context.route('**/*', async route => {
    const request = route.request(); const url = new URL(request.url())
    if (url.origin === origin && url.pathname === '/__v2-reference.html') return route.fulfill({ contentType: 'text/html', body: prototype })
    if (url.origin === origin) return route.continue()
    if (url.origin !== 'https://offline.example.invalid') return route.abort()
    const input = request.postDataJSON() ?? {}; let body = {}; let status = 200
    if (url.pathname.endsWith('/token')) body = session
    else if (url.pathname.endsWith('/user')) body = user
    else if (url.pathname.endsWith('/logout')) body = {}
    else if (url.pathname.endsWith('/public-feed')) { assert.equal(request.headers()['authorization'], undefined); body = envelope({ items: [], nextCursor: null }) }
    else if (url.pathname.endsWith('/social-api')) {
      assert.equal(request.headers().authorization, `Bearer ${jwt}`, 'request nghiệp vụ gắn đúng phiên')
      if (input.action === 'getMe') body = envelope({ nickname: 'OUer riêng tư', emailMasked: '***@ou.edu.vn', isAdmin: false })
      else if (input.action === 'listPosts') {
        listCalls.push(input.payload)
        const mode = feedMode
        if (mode === 'hold' || (mode === 'late' && input.payload.tag === 'CONFESSION')) { holding = true; await new Promise(done => { releaseList = done }) }
        if (['error', 'forbidden', 'expired'].includes(mode) || (['page-error', 'cursor-error'].includes(mode) && input.payload.cursor)) {
          status = mode === 'cursor-error' ? 400 : mode === 'forbidden' ? 403 : mode === 'expired' ? 401 : 500
          body = { data: null, error: { code: mode === 'cursor-error' ? 'VALIDATION_ERROR' : mode === 'forbidden' ? 'FORBIDDEN' : mode === 'expired' ? 'UNAUTHENTICATED' : 'INTERNAL_ERROR', message: 'PRIVATE SQL JWT secret@ou.edu.vn', details: null }, meta: { requestId: id(999) } }
        } else if (mode === 'privacy') body = envelope({ items: [{ ...first, author_id: user.id, email: user.email }], nextCursor: null })
        else if (mode === 'empty' || mode === 'hold') body = envelope({ items: [], nextCursor: null })
        else if (input.payload.tag) body = envelope({ items: [post(10, { tag: input.payload.tag, body: `Chủ đề ${input.payload.tag}` })], nextCursor: null })
        else body = envelope(input.payload.cursor ? { items: [second, post(3)], nextCursor: null } : { items: [first, second], nextCursor: 'opaque-offline-cursor' })
      } else if (input.action === 'createPost') {
        createCalls.push(input.payload)
        if (createMode === 'conflict') { status = 409; body = { message: 'PRIVATE SQL JWT' } }
        else {
          if (!drafts.has(input.payload.idempotencyKey)) drafts.set(input.payload.idempotencyKey, { ...input.payload, postId: id(100 + drafts.size) })
          if (createMode === 'lost' && !createFailed) { createFailed = true; return route.abort() }
          body = envelope({ postId: drafts.get(input.payload.idempotencyKey).postId, status: 'DRAFT' })
        }
      } else if (input.action === 'publishPost') {
        publishCalls.push(input.payload.postId)
        if (publishMode === 'hold') await new Promise(done => { releasePublish = done })
        if (publishMode === 'lost' && !publishFailed) { publishFailed = true; return route.abort() }
        const draft = [...drafts.values()].find(value => value.postId === input.payload.postId)
        assert.ok(draft)
        body = envelope(post(100, { id: draft.postId, body: draft.body, tag: draft.tag, displayMode: draft.displayMode, contactUrl: draft.contactUrl ?? null, authorLabel: draft.displayMode === 'ANONYMOUS' ? 'OUer ẩn danh' : 'OUer riêng tư', isMine: true }))
      } else assert.fail('Không có action ngoài scope T07')
    } else assert.fail('Mock thiếu endpoint; không gọi Cloud')
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body), headers: { 'access-control-allow-origin': '*', 'x-supabase-api-version': '2024-01-01' } })
  })
  await mkdir(artifacts, { recursive: true })
  const reference = await context.newPage()
  await reference.goto(`${origin}/__v2-reference.html`)
  async function screen(name, width, theme) {
    await page.setViewportSize({ width, height: width < 600 ? 860 : 960 })
    if (await page.getAttribute('html', 'data-theme') !== theme) await page.getByRole('button', { name: /Chuyển giao diện/ }).click()
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'không tràn ngang')
    const logo = page.locator(width <= 720 ? '.mobile-logo' : '.feed-header .brand-word')
    if (name === 'feed') {
      if (width <= 720) assert.equal(await logo.locator('.theou-logo-mark').innerText(), 't')
      else assert.equal(await logo.locator('.theou-logo-mark').count(), 0, 'Desktop wordmark must not duplicate the sidebar mark')
      assert.equal(await logo.locator('.theou-logo-word').innerText(), 'TheOU')
      assert.equal(await logo.isVisible(), true)
      assert.equal(await page.locator('.rail-logo .theou-logo-mark').innerText(), 't')
      assert.equal(await page.locator('.social-app .theou-logo-mark').evaluateAll(marks => marks.filter(mark => mark.getBoundingClientRect().width > 0).length), 1, 'Only one visible brand mark per viewport')
    }
    if (name === 'feed' || name === 'composer') {
      assert.equal(await page.getByRole('heading', { name: name === 'feed' ? 'Bảng tin' : 'Viết bài', exact: true }).count(), 1)
      await reference.setViewportSize({ width, height: width < 600 ? 860 : 960 })
      await reference.evaluate(({ name, theme }) => { document.documentElement.dataset.theme = theme; location.hash = name === 'feed' ? '#/' : '#/viet-bai' }, { name, theme })
      await reference.locator(name === 'feed' ? '#screen-feed.active' : '#screen-compose.active').waitFor()
      const expected = await reference.evaluate(() => { const column = document.querySelector('.screen.active .column'); const style = getComputedStyle(column); return { width: column.getBoundingClientRect().width, bg: style.getPropertyValue('--bg').trim(), panel: style.getPropertyValue('--surface').trim(), fg: style.getPropertyValue('--text').trim(), muted: style.getPropertyValue('--muted').trim(), border: style.getPropertyValue('--border').trim() } })
      const actual = await page.locator('.social-wrap').evaluate(column => { const style = getComputedStyle(column); return { width: column.getBoundingClientRect().width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight), bg: style.getPropertyValue('--bg').trim(), panel: style.getPropertyValue('--panel').trim(), fg: style.getPropertyValue('--fg').trim(), muted: style.getPropertyValue('--muted').trim(), border: style.getPropertyValue('--line').trim() } })
      assert.deepEqual(actual, expected, `V2 tokens/column: ${name}/${width}/${theme}`)
      assert.equal(await page.locator('.social-nav a').count(), 3)
      assert.equal(await page.locator('.social-nav a[aria-current=page]').count(), 1)
      assert.equal(await page.locator('a[href="/thanh-phan"],.preview-toggle').count(), 0)
      if (width <= 720) assert.equal(await page.locator('.social-nav').evaluate(e => getComputedStyle(e).position), 'fixed')
      else assert.equal(await page.locator('.social-navigation').evaluate(e => e.getBoundingClientRect().width), width > 1100 ? 92 : 66)
      assert.equal(await page.locator('.post-card').evaluateAll(cards => cards.every(e => getComputedStyle(e).borderRadius === '0px')), true)
      await reference.screenshot({ path: join(artifacts, `reference-${name}-${width}-${theme}.png`), fullPage: true })
    }
    await page.evaluate(() => scrollTo(0, 0))
    if (width <= 720) assert.equal(await page.locator('.mobile-header').evaluate(e => e.getBoundingClientRect().y), 0)
    await page.screenshot({ path: join(artifacts, `${name}-${width}-${theme}.png`), fullPage: true, style: '.toast{visibility:hidden}' }); shots++
  }
  const feed = () => page.getByRole('heading', { name: 'Bảng tin', exact: true }).waitFor()
  async function refresh() { await page.getByRole('button', { name: 'Làm mới bảng tin', exact: true }).first().click() }
  async function composer() { await page.getByRole('link', { name: 'Viết bài', exact: true }).click(); await page.getByLabel('Câu chuyện của bạn', { exact: true }).waitFor() }
  async function leave() {
    page.once('dialog', dialog => dialog.accept())
    await page.getByRole('link', { name: 'Hủy', exact: true }).click(); await feed()
  }
  async function login() {
    if (await page.locator('input[name=email]').count() === 0) await page.goto(origin + '/dang-nhap')
    await page.getByLabel('Email trường', { exact: true }).fill(user.email)
    await page.getByLabel('Mật khẩu', { exact: true }).fill('Offline-password!')
    await page.getByRole('button', { name: 'Đăng nhập', exact: true }).click(); await feed()
  }
  for (const path of ['/bai-viet/moi']) { await page.goto(`${origin}${path}`); await page.waitForURL('**/dang-nhap') }
  feedMode = 'hold'; await login()
  await page.getByRole('status', { name: 'Đang tải bảng tin' }).waitFor()
  assert.equal(await page.locator('.skeleton-card').count(), 3)
  for (const theme of ['dark', 'light']) await screen('loading', 390, theme)
  releaseList(); await page.getByRole('heading', { name: 'Chưa có bài viết nào. Hãy mở đầu câu chuyện!' }).waitFor()
  for (const theme of ['dark', 'light']) await screen('empty', 390, theme)
  feedMode = 'error'; await refresh(); await page.getByRole('heading', { name: 'Không tải được bảng tin' }).waitFor()
  assert.doesNotMatch(await page.locator('.social-wrap').innerText(), /PRIVATE|SQL|JWT|secret@/)
  for (const theme of ['dark', 'light']) await screen('error', 390, theme)
  feedMode = 'many'; await page.getByRole('button', { name: 'Thử lại', exact: true }).click(); await page.locator('.post-card').first().waitFor()
  assert.equal(await page.locator('.post-card').count(), 2)
  assert.equal(await page.locator('.post-body').first().evaluate(e => getComputedStyle(e).whiteSpace), 'pre-wrap')
  assert.equal(await page.locator('.post-card .upvote-button').count(), 2, 'hai nút upvote, không thêm reaction khác')
  await page.locator('.post-card').filter({has:page.locator('.post-delete')}).getByRole('button',{name:'Tùy chọn bài viết',exact:true}).click()
  assert.equal(await page.getByRole('menuitem', {name:'Xóa bài viết',exact:true}).count(), 1)
  await page.keyboard.press('End')
  assert.equal(await page.getByRole('menuitem',{name:'Xóa bài viết',exact:true}).evaluate(e=>e===document.activeElement),true)
  await page.keyboard.press('Escape')
  assert.equal(await page.locator('.post-menu>button[aria-expanded=true]').count(),0)
  assert.equal(await page.locator('.post-card').filter({has:page.locator('.post-delete')}).locator('.post-menu>button').evaluate(e=>e===document.activeElement),true)
  await page.locator('.post-card').filter({has:page.locator('.post-delete')}).getByRole('button',{name:'Tùy chọn bài viết',exact:true}).click()
  await page.locator('.feed-heading h2').click()
  assert.equal(await page.locator('.post-menu>button[aria-expanded=true]').count(),0,'Outside đóng menu')
  assert.equal(await page.locator('.upvote-button[aria-pressed=false]').count(), 2)
  assert.equal(await page.locator('.post-byline a').count(), 0, 'không link danh tính')
  assert.doesNotMatch(await page.locator('.feed-list').innerHTML(), new RegExp(`${user.id}|${user.email}|OUer riêng tư|author_id|access_token`))
  assert.equal(await page.getByRole('link', { name: /Liên hệ người đăng/ }).getAttribute('rel'), 'noopener noreferrer')
  for (const width of [360, 390, 768, 1280]) for (const theme of ['dark', 'light']) await screen('feed', width, theme)
  console.log('PASS: V2 Feed tokens, responsive shell và ảnh đối chiếu prototype.')
  await page.setViewportSize({ width: 360, height: 860 })
  assert.equal(await page.locator('.tag-filters').evaluate(e => e.scrollWidth > e.clientWidth), true)
  for (const [label, value] of [['Confession', 'CONFESSION'], ['Review môn', 'REVIEW_MON'], ['Tài liệu', 'TAI_LIEU'], ['Tìm trọ', 'TIM_TRO'], ['Hỏi gấp', 'HOI_GAP'], ['Tất cả', null]]) {
    await page.getByRole('button', { name: label, exact: true }).click()
    await page.waitForFunction(value => document.querySelector('.tag-filters button[aria-pressed=true]')?.textContent === value, label)
    await page.waitForFunction(() => !document.querySelector('.feed-list[aria-busy=true]'))
    assert.equal(listCalls.at(-1).tag, value); assert.equal(listCalls.at(-1).cursor, null)
  }
  console.log('PASS: sáu tag filters.')
  await page.getByRole('button', { name: 'Nổi bật 24h', exact: true }).click(); await page.locator('.post-card').first().waitFor()
  assert.equal(listCalls.at(-1).sort, 'HOT'); assert.equal(listCalls.at(-1).cursor, null)
  await page.getByRole('button', { name: 'Tải thêm', exact: true }).click(); await page.waitForFunction(() => document.querySelectorAll('.post-card').length === 3)
  assert.equal(listCalls.at(-1).cursor, 'opaque-offline-cursor'); assert.equal(await page.getByRole('button', { name: 'Tải thêm', exact: true }).count(), 0)
  await refresh(); await page.waitForFunction(() => document.querySelectorAll('.post-card').length === 2); assert.equal(listCalls.at(-1).cursor, null)
  feedMode = 'page-error'; await page.getByRole('button', { name: 'Tải thêm', exact: true }).click(); await page.getByRole('button', { name: 'Thử tải thêm', exact: true }).waitFor()
  assert.equal(await page.locator('.post-card').count(), 2)
  feedMode = 'many'; await page.getByRole('button', { name: 'Thử tải thêm', exact: true }).click(); await page.waitForFunction(() => document.querySelectorAll('.post-card').length === 3)
  await refresh(); await page.waitForFunction(() => document.querySelectorAll('.post-card').length === 2)
  feedMode = 'cursor-error'; await page.getByRole('button', { name: 'Tải thêm', exact: true }).click(); await page.getByText('Phiên phân trang không còn hợp lệ.', { exact: false }).waitFor()
  feedMode = 'many'; await page.getByRole('button', { name: 'Làm mới bảng tin', exact: true }).last().click(); await page.getByRole('button', { name: 'Tải thêm', exact: true }).waitFor(); assert.equal(listCalls.at(-1).cursor, null)
  feedMode = 'late'; holding = false
  console.log('PASS: pagination/retry/reset; kiểm tra đổi filter khi response tới muộn.')
  await page.getByRole('button', { name: 'Confession', exact: true }).click()
  for (let attempt = 0; attempt < 100 && !holding; attempt++) await page.waitForTimeout(10)
  assert.ok(holding, 'request đổi filter đã tới mock trước khi chuyển sang tag khác')
  await page.getByRole('button', { name: 'Hỏi gấp', exact: true }).click(); await page.getByText('Chủ đề HOI_GAP', { exact: true }).waitFor()
  releaseList(); await page.waitForTimeout(50)
  assert.equal(await page.getByText('Chủ đề CONFESSION', { exact: true }).count(), 0)
  feedMode = 'privacy'; await refresh(); await page.getByRole('heading', { name: 'Không tải được bảng tin' }).waitFor()
  assert.doesNotMatch(await page.locator('.social-wrap').innerHTML(), new RegExp(`${user.id}|${user.email}|author_id`))
  feedMode = 'many'; await page.getByRole('button', { name: 'Thử lại', exact: true }).click(); await page.locator('.post-card').waitFor()
  await composer()
  assert.equal(await page.getByRole('radio', { name: /Ẩn danh/ }).isChecked(), true)
  assert.equal(await page.getByRole('radio', { name: 'Confession', exact: true }).isChecked(), true)
  await page.getByRole('button', { name: 'Đăng bài', exact: true }).click(); await page.getByText('Nội dung cần từ 1 đến 1.000 ký tự.', { exact: true }).waitFor()
  assert.equal(await page.getByLabel('Câu chuyện của bạn', { exact: true }).evaluate(e => e === document.activeElement), true)
  await page.getByLabel('Câu chuyện của bạn', { exact: true }).fill('👋'.repeat(1001)); await page.getByText('1001/1000', { exact: true }).waitFor()
  await page.getByRole('button', { name: 'Đăng bài', exact: true }).click(); assert.equal(createCalls.length, 0)
  await page.getByLabel('Câu chuyện của bạn', { exact: true }).fill('Một câu chuyện offline.\n\nMình cùng lắng nghe nhé.')
  for (const width of [360, 390, 768, 1280]) for (const theme of ['dark', 'light']) await screen('composer', width, theme)
  await page.setViewportSize({ width: 390, height: 600 }); await page.getByLabel('Câu chuyện của bạn', { exact: true }).focus()
  await page.getByRole('button', { name: 'Đăng bài', exact: true }).scrollIntoViewIfNeeded()
  assert.equal(await page.getByRole('button', { name: 'Đăng bài', exact: true }).isVisible(), true)
  page.once('dialog', dialog => dialog.dismiss()); await page.getByRole('link', { name: 'Cá nhân', exact: true }).click(); assert.equal(new URL(page.url()).pathname, '/bai-viet/moi')
  await page.getByRole('radio', { name: 'Tài liệu', exact: true }).check(); await page.getByRole('radio', { name: /Biệt danh/ }).check()
  const contact = page.getByLabel('Liên kết liên hệ', { exact: false })
  await contact.fill('https://zalo.me.evil.invalid/x'); await page.getByRole('button', { name: 'Đăng bài', exact: true }).click(); await page.getByText(/Dùng liên kết HTTPS/).waitFor(); assert.equal(createCalls.length, 0)
  await contact.fill('https://zalo.me/offline'); await page.getByRole('radio', { name: /Ẩn danh/ }).check(); assert.equal(await contact.count(), 0)
  await page.getByRole('radio', { name: /Biệt danh/ }).check(); assert.equal(await contact.inputValue(), '')
  await contact.fill('https://m.me/offline'); await page.getByRole('radio', { name: 'Confession', exact: true }).check(); assert.equal(await contact.count(), 0)
  await page.getByRole('radio', { name: /Ẩn danh/ }).check()
  createMode = 'lost'
  await page.locator('.composer-card').evaluate(form => { form.requestSubmit(); form.requestSubmit() })
  await page.getByRole('button', { name: 'Thử lại đăng bài', exact: true }).waitFor()
  assert.equal(createCalls.length, 1); assert.equal(Object.hasOwn(createCalls[0], 'contactUrl'), false)
  assert.equal(await page.getByLabel('Câu chuyện của bạn', { exact: true }).isDisabled(), true)
  assert.match(await page.getByLabel('Câu chuyện của bạn', { exact: true }).inputValue(), /Một câu chuyện offline/)
  publishMode = 'hold'
  await page.getByRole('button', { name: 'Thử lại đăng bài', exact: true }).click()
  await page.getByText('Đang hoàn tất đăng bài…', { exact: true }).waitFor()
  assert.equal(createCalls.length, 2); assert.deepEqual(createCalls[0], createCalls[1]); assert.equal(new URL(page.url()).pathname, '/bai-viet/moi')
  releasePublish(); await feed(); assert.equal(await page.getByRole('button', { name: 'Mới nhất', exact: true }).getAttribute('aria-pressed'), 'true')
  assert.equal(listCalls.at(-1).cursor, null)
  createMode = 'normal'; publishMode = 'lost'
  await composer(); await page.getByLabel('Câu chuyện của bạn', { exact: true }).fill('Replay publish offline')
  await page.getByRole('button', { name: 'Đăng bài', exact: true }).click(); await page.getByRole('button', { name: 'Thử lại hoàn tất đăng bài', exact: true }).waitFor()
  const createBeforeRetry = createCalls.length
  await page.setViewportSize({ width: 360, height: 600 })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'retry publish không tràn mobile360')
  await page.getByRole('button', { name: 'Thử lại hoàn tất đăng bài', exact: true }).click(); await feed()
  assert.equal(createCalls.length, createBeforeRetry); assert.equal(publishCalls.at(-1), publishCalls.at(-2)); assert.notEqual(createCalls.at(-1).idempotencyKey, createCalls[0].idempotencyKey)
  createMode = 'conflict'; publishMode = 'normal'
  await composer(); await page.getByLabel('Câu chuyện của bạn', { exact: true }).fill('Conflict offline')
  await page.getByRole('button', { name: 'Đăng bài', exact: true }).click(); await page.getByRole('alert').waitFor()
  assert.equal(await page.getByLabel('Câu chuyện của bạn', { exact: true }).inputValue(), 'Conflict offline')
  assert.doesNotMatch(await page.locator('.composer-card').innerText(), /PRIVATE|SQL|JWT/)
  await leave()
  const theme = await page.getAttribute('html', 'data-theme')
  await page.getByRole('link', { name: 'Cá nhân', exact: true }).click(); await page.waitForSelector('.profile-name'); assert.equal(await page.getAttribute('html', 'data-theme'), theme)
  await page.getByRole('button', { name: 'Đăng xuất', exact: true }).click(); await page.waitForURL(origin + '/bang-tin')
  feedMode = 'empty'; await login(); await page.getByRole('heading', { name: 'Chưa có bài viết nào. Hãy mở đầu câu chuyện!' }).waitFor(); assert.equal(await page.locator('.post-card').count(), 0)
  feedMode = 'forbidden'; await refresh(); await page.getByText('Tài khoản không đủ điều kiện truy cập TheOU hoặc đã bị khóa.', { exact: true }).waitFor()
  assert.equal(await page.locator('.post-card').count(), 0); assert.equal(await page.locator('.composer-card').count(), 0)
  await page.getByRole('button', { name: 'Đăng xuất', exact: true }).click(); await page.waitForURL(origin + '/bang-tin')
  feedMode = 'many'; await login(); await page.locator('.post-card').first().waitFor()
  feedMode = 'expired'; await refresh(); await page.getByRole('link', { name: 'Đăng nhập để tương tác', exact: true }).waitFor(); assert.equal(await page.locator('.post-card').count(), 0)
  assert.deepEqual(runtimeErrors, [])
  console.log(`PASS: Feed/Composer browser offline — ${shots} screenshots; 360/390/768/1280px dark/light; filters/races/pages/cursor/states/privacy, composer retry/validation/double-submit, routing/Auth/theme. Không gọi Cloud.`)
  console.log('Ảnh dữ liệu giả: frontend/node_modules/.cache/theou-feed-ui/ (gitignored).')
} finally { releaseList?.(); releasePublish?.(); await browser?.close(); server.kill() }
