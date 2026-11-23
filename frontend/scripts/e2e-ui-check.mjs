// E2E local: React thật, ba contexts cô lập; Auth/API/Storage chỉ trong bộ nhớ.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { chromium } from 'playwright-core'

const root = fileURLToPath(new URL('../', import.meta.url))
const origin = 'http://127.0.0.1:5194'
const endpoint = 'https://offline.example.invalid'
const artifacts = join(root, 'node_modules/.cache/theou-e2e-ui')
const executablePath = process.env.THEOU_BROWSER_PATH
assert.ok(executablePath, 'Phải chọn Chrome binary đã xác minh bằng THEOU_BROWSER_PATH')
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '5194', '--strictPort'], {
  cwd: root, windowsHide: true, stdio: 'ignore',
  env: { ...process.env, VITE_SUPABASE_URL: endpoint, VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_offline_ui' },
})
const id = n => `20000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const users = ['a', 'b'].map((actor, i) => ({ id: id(900 + i), email: `offline.${actor}@ou.edu.vn`, email_confirmed_at: '2026-11-01T00:00:00Z', aud: 'authenticated', app_metadata: {}, user_metadata: {} }))
const sessions = users.map(user => ({ user, access_token: `${Buffer.from('{"alg":"HS256"}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: user.id, exp: 4000000000 })).toString('base64url')}.offline`, refresh_token: 'offline-only-refresh', token_type: 'bearer', expires_in: 3600 }))
const envelope = data => ({ data, error: null, meta: { requestId: id(999) } })
const failure = code => ({ data: null, error: { code, message: 'Lỗi giả lập an toàn.', details: null }, meta: { requestId: id(999) } })
let browser, shots = 0
try {
  let ready = false
  for (let n = 0; n < 200; n++) {
    try { if ((await fetch(origin)).ok) { ready = true; break } } catch { /* Chờ Vite local. */ }
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  assert.ok(ready, 'Vite local phải sẵn sàng')
  browser = await chromium.launch({ executablePath, headless: true })
  const cdp = await browser.newBrowserCDPSession()
  const version = await cdp.send('Browser.getVersion')
  assert.match(version.product, /^Chrome\//, 'Không nhận Edge/Chromium là Chrome')
  console.log(`Chrome verified: ${version.product}; isolated contexts A/B/guest; local mocks only.`)
  await cdp.detach()
  await mkdir(artifacts, { recursive: true })
  for (const width of [1280, 390]) for (const theme of ['dark', 'light']) {
    const posts = new Map(), comments = new Map(), images = new Map(), votes = new Set(), audits = [], calls = [], runtimeErrors = [], blocked = []
    let admin = false, sequence = 1, lostCommentAck = true, pixels
    const old = { id: id(sequence++), owner: 1, body: 'Bài cũ tổng hợp ngoài cửa sổ HOT.', tag: 'REVIEW_MON', status: 'PUBLISHED', publishedAt: new Date(Date.now() - 172800000).toISOString() }
    posts.set(old.id, old)
    const guestRows = [{ ...old, id: id(700), body: 'Nội dung tổng hợp đã duyệt công khai.', publishedAt: new Date(Date.now() - 1000).toISOString() },
      { ...old, id: id(701), body: 'Nội dung công khai cũ tổng hợp.' }]
    const guestCalls = []
    const visibleComments = postId => [...comments.values()].filter(c => c.postId === postId && c.status === 'VISIBLE')
    const dto = (post, actor) => ({ id: post.id, tag: post.tag, body: post.body, displayMode: 'ANONYMOUS', authorLabel: 'OUer ẩn danh', contactUrl: null,
      publishedAt: post.publishedAt, upvoteCount: Number(votes.has(post.id)), commentCount: visibleComments(post.id).length,
      hasUpvoted: actor === 1 && votes.has(post.id), isMine: post.owner === actor,
      images: [...images.values()].filter(image => image.postId === post.id && image.ready).map(image => ({ id: image.id, signedUrl: `${endpoint}/storage/v1/object/sign/post-media/${image.path}?token=offline-only-read`, expiresAt: new Date(Date.now() + 300000).toISOString() })) })
    const contexts = []
    const pages = []
    try {
      for (const contextActor of [0, 1, null]) {
        const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce' })
        contexts.push(context)
        await context.addInitScript(theme => localStorage.setItem('theou.theme', theme), theme)
        await context.route('**/*', async route => {
          const req = route.request(), url = new URL(req.url())
          if (url.origin === origin) return route.continue()
          if (url.origin !== endpoint) { blocked.push('unexpected-external-host'); return route.abort() }
          if (url.pathname.startsWith('/storage/v1/object/sign/')) {
            const image = [...images.values()].find(image => url.pathname.endsWith(image.path))
            assert.ok(image?.ready)
            return route.fulfill({ contentType: 'image/png', body: pixels })
          }
          if (url.pathname.startsWith('/storage/v1/object/upload/sign/post-media/')) {
            const image = [...images.values()].find(image => url.pathname.endsWith(image.path))
            assert.ok(image && image.owner === contextActor)
            assert.equal(req.method(), 'PUT')
            assert.notEqual(req.headers()['x-upsert'], 'true')
            image.bytes = req.postDataBuffer()
            assert.ok(image.bytes?.length)
            return route.fulfill({ json: { Key: `post-media/${image.path}` } })
          }
          const input = req.postDataJSON() ?? {}
          let status = 200, body
          const deny = (code, http) => { status = http; body = failure(code) }
          if (url.pathname.endsWith('/token')) {
            assert.notEqual(contextActor, null)
            assert.equal(input.email, users[contextActor].email)
            assert.equal(input.password, 'Offline-password!')
            body = sessions[contextActor]
          } else if (url.pathname.endsWith('/user')) {
            assert.notEqual(contextActor, null)
            body = users[contextActor]
          } else if (url.pathname.endsWith('/logout')) body = {}
          else if (url.pathname.endsWith('/public-feed')) {
            assert.equal(req.headers().authorization, undefined)
            assert.equal(input.action, 'listPosts')
            const p = input.payload
            guestCalls.push(p)
            const rows = guestRows.filter(row => (!p.tag || row.tag === p.tag) && (p.sort !== 'HOT' || Date.parse(row.publishedAt) >= Date.now() - 86400000))
            const offset = p.cursor ? 1 : 0
            body = envelope({ items: rows.slice(offset, offset + 1).map(row => ({ ...dto(row, null), isMine: false, hasUpvoted: false, images: [] })), nextCursor: rows.length > offset + 1 ? 'guest-next' : null })
          }
          else if (url.pathname.endsWith('/social-api')) {
            const actor = sessions.findIndex(session => req.headers().authorization === `Bearer ${session.access_token}`)
            if (actor < 0) deny('UNAUTHENTICATED', 401)
            else {
              assert.equal(actor, contextActor, 'Context không được dùng session của actor khác')
              const p = input.payload ?? {}, post = posts.get(p.postId)
              calls.push({ actor, action: input.action, payload: p })
              if (input.action === 'getMe') body = envelope({ nickname: `OUer local ${actor ? 'B' : 'A'}`, emailMasked: '***@ou.edu.vn', isAdmin: actor === 1 && admin })
              else if (input.action === 'listPosts') {
                assert.ok(['NEW', 'HOT'].includes(p.sort)); assert.ok(p.limit >= 1 && p.limit <= 20)
                const rows = [...posts.values()].filter(post => post.status === 'PUBLISHED' && (!p.tag || p.tag === post.tag) && (p.sort !== 'HOT' || Date.parse(post.publishedAt) >= Date.now() - 86400000)).reverse()
                const offset = p.cursor === null ? 0 : Number(p.cursor.replace('opaque-page-', ''))
                assert.ok(Number.isInteger(offset) && offset >= 0)
                body = envelope({ items: rows.slice(offset, offset + 1).map(post => dto(post, actor)), nextCursor: rows.length > offset + 1 ? `opaque-page-${offset + 1}` : null })
              } else if (input.action === 'createPost') {
                assert.equal(p.displayMode, 'ANONYMOUS'); assert.equal(p.tag, 'CONFESSION'); assert.equal(p.contactUrl ?? null, null)
                let created = [...posts.values()].find(post => post.key === p.idempotencyKey && post.owner === actor)
                if (!created) { created = { id: id(sequence++), owner: actor, key: p.idempotencyKey, body: p.body, tag: p.tag, status: 'DRAFT' }; posts.set(created.id, created) }
                assert.equal(created.body, p.body)
                body = envelope({ postId: created.id, status: 'DRAFT' })
              } else if (input.action === 'createImageUpload') {
                assert.ok(post?.owner === actor && post.status === 'DRAFT'); assert.ok(p.position === 1 || p.position === 2)
                assert.ok(p.sizeBytes > 0 && p.sizeBytes <= 2097152)
                assert.ok(['image/png', 'image/webp', 'image/jpeg'].includes(p.mimeType))
                const imageId = id(sequence++), extension = { 'image/png': 'png', 'image/webp': 'webp', 'image/jpeg': 'jpg' }[p.mimeType]
                const image = { ...p, owner: actor, id: imageId, path: `posts/${post.id}/${imageId}.${extension}` }
                images.set(image.id, image); body = envelope({ imageId, path: image.path, token: 'offline-only-upload' })
              } else if (input.action === 'finalizeImage') {
                const image = images.get(p.imageId)
                assert.ok(image?.bytes && image.owner === actor)
                image.ready = true; body = envelope({ imageId: image.id, status: 'READY' })
              } else if (input.action === 'publishPost') {
                assert.ok(post?.owner === actor)
                assert.ok([...images.values()].filter(image => image.postId === post.id).every(image => image.ready))
                post.status = 'PUBLISHED'; post.publishedAt ??= new Date().toISOString(); body = envelope(dto(post, actor))
              } else if (input.action === 'getPost') {
                if (post?.status !== 'PUBLISHED') deny('NOT_FOUND', 404)
                else body = envelope(dto(post, actor))
              } else if (input.action === 'listComments') {
                if (post?.status !== 'PUBLISHED') deny('NOT_FOUND', 404)
                else body = envelope({ items: visibleComments(post.id).map(c => ({ id: c.id, postId: c.postId, body: c.body, authorLabel: c.owner === post.owner ? 'Chủ bài' : 'OUer ẩn danh', isOriginalPoster: c.owner === post.owner, isMine: c.owner === actor, createdAt: c.createdAt })), nextCursor: null })
              } else if (input.action === 'createComment') {
                assert.equal(post?.status, 'PUBLISHED')
                let comment = [...comments.values()].find(c => c.key === p.idempotencyKey && c.owner === actor)
                if (!comment) { comment = { id: id(sequence++), postId: post.id, owner: actor, body: p.body, key: p.idempotencyKey, status: 'VISIBLE', createdAt: new Date().toISOString() }; comments.set(comment.id, comment) }
                if (actor === 1 && lostCommentAck) { lostCommentAck = false; return route.abort() }
                body = envelope({ id: comment.id, postId: post.id, body: comment.body, authorLabel: actor === post.owner ? 'Chủ bài' : 'OUer ẩn danh', isOriginalPoster: actor === post.owner, isMine: true, createdAt: comment.createdAt })
              } else if (input.action === 'toggleUpvote') {
                assert.equal(post?.status, 'PUBLISHED'); assert.equal(actor, 1)
                if (p.desiredState) votes.add(post.id); else votes.delete(post.id)
                body = envelope({ hasUpvoted: votes.has(post.id), upvoteCount: Number(votes.has(post.id)) })
              } else if (input.action === 'deletePost') {
                if (!post || post.owner !== actor) deny('NOT_FOUND', 404)
                else { post.status = 'DELETED'; body = envelope({ success: true }) }
              } else if (input.action === 'adminHideContent') {
                if (actor !== 1 || !admin) deny('FORBIDDEN', 403)
                else {
                  const target = (p.targetType === 'POST' ? posts : comments).get(p.targetId)
                  assert.ok(target && ['PUBLISHED', 'VISIBLE'].includes(target.status))
                  target.status = 'HIDDEN'; audits.push({ actor, ...p }); body = envelope({ success: true })
                }
              } else assert.fail('Action chưa mock trong E2E local')
            }
          } else assert.fail('Endpoint chưa mock trong E2E local')
          await route.fulfill({ status, json: body })
        })
        const page = await context.newPage(); page.setDefaultTimeout(15000)
        page.on('pageerror', () => runtimeErrors.push('runtime-error'))
        pages.push(page)
      }
      const [a, b, guest] = pages
      const shot = async (page, name) => {
        await page.evaluate(() => scrollTo(0, 0))
        assert.equal(await page.getAttribute('html', 'data-theme'), theme)
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Không overflow ngang')
        await page.screenshot({ path: join(artifacts, `${name}-${width}-${theme}.png`), fullPage: true, style: '.toast{visibility:hidden}' }); shots++
      }
      const login = async (page, actor) => {
        await page.goto(origin + '/dang-nhap'); await page.waitForURL('**/dang-nhap')
        await page.getByLabel('Email trường', { exact: true }).fill(users[actor].email)
        await page.getByLabel('Mật khẩu', { exact: true }).fill('Offline-password!')
        await page.getByRole('button', { name: 'Đăng nhập', exact: true }).click()
        await page.getByRole('heading', { name: 'Bảng tin', exact: true }).waitFor()
      }
      const bitmap = await guest.evaluate(() => {
        const canvas = document.createElement('canvas'); canvas.width = 480; canvas.height = 320
        const ctx = canvas.getContext('2d'); ctx.fillStyle = '#c28b5f'; ctx.fillRect(0, 0, 480, 320)
        ctx.fillStyle = '#315d78'; ctx.fillRect(60, 40, 360, 240)
        return canvas.toDataURL('image/png').split(',')[1]
      })
      pixels = Buffer.from(bitmap, 'base64')
      const publish = async count => {
        await a.getByRole('link', { name: 'Viết bài', exact: true }).click()
        assert.equal(await a.locator('input[value=ANONYMOUS]').isChecked(), true)
        await a.getByLabel('Câu chuyện của bạn').fill(`Bài E2E local ${count} ảnh, dữ liệu tổng hợp.`)
        await a.locator('input[type=file]').setInputFiles(Array.from({ length: count }, (_, i) => ({ name: `synthetic-${i}.png`, mimeType: 'image/png', buffer: Buffer.from(bitmap, 'base64') })))
        await a.waitForFunction(count => document.querySelectorAll('.draft-image').length === count, count)
        await a.getByRole('button', { name: 'Đăng bài', exact: true }).click()
        await a.waitForURL(origin + '/')
        return [...posts.values()].at(-1)
      }
      await guest.goto(origin + '/bang-tin'); await guest.getByRole('link', { name: 'Đăng nhập để tương tác', exact: true }).waitFor()
      await guest.getByText(guestRows[0].body, { exact: true }).waitFor()
      assert.equal(new URL(guest.url()).pathname, '/')
      assert.equal(calls.length, 0, 'Khách không gửi protected business API')
      assert.equal(await guest.locator('.upvote-button,.post-images,.post-share').count(), 0)
      assert.equal(await guest.getByRole('link', { name: 'Cá nhân', exact: true }).count(), 0)
      assert.equal(await guest.getByRole('link', { name: 'Mở bài viết và bình luận', exact: true }).count(), 0)
      await guest.getByRole('button', { name: 'Tải thêm', exact: true }).click()
      await guest.getByText(guestRows[1].body, { exact: true }).waitFor()
      assert.equal(guestCalls.at(-1).cursor, 'guest-next')
      await guest.getByRole('button', { name: 'Nổi bật 24h', exact: true }).click()
      await guest.waitForFunction(() => document.querySelectorAll('.post-card').length === 1)
      await guest.getByRole('button', { name: 'Hỏi gấp', exact: true }).click()
      await guest.getByRole('heading', { name: 'Chưa có bài viết công khai.', exact: true }).waitFor()
      await guest.getByRole('link', { name: 'Viết bài', exact: true }).click(); await guest.waitForURL('**/dang-nhap')
      for (const path of ['/bai-viet/moi', `/bai-viet/${old.id}`, '/ca-nhan', '/admin']) {
        await guest.goto(origin + path); await guest.waitForURL('**/dang-nhap')
      }
      const denied = await guest.evaluate(async endpoint => {
        const res = await fetch(`${endpoint}/functions/v1/social-api`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'listPosts', payload: { sort: 'NEW', tag: null, cursor: null, limit: 20 } }) })
        return res.status
      }, endpoint)
      assert.equal(denied, 401)
      await guest.goto(origin); await guest.getByText(guestRows[0].body, { exact: true }).waitFor()
      await shot(guest, 'guest-feed')
      await login(a, 0); const first = await publish(1)
      assert.equal([...images.values()].filter(image => image.postId === first.id && image.ready).length, 1)
      await a.reload(); await a.locator('.post-card').first().waitFor()
      assert.equal(await a.locator('input[name=email]').count(), 0, 'Session restore không yêu cầu login lại')
      await login(b, 1)
      await b.getByText(first.body, { exact: true }).waitFor()
      assert.equal(await b.getByRole('button', { name: 'Xóa bài viết', exact: true }).count(), 0, 'B không có delete trên bài mới của A')
      await shot(b, 'b-feed-one-image')
      await b.getByRole('link', { name: 'Mở ảnh 1 và chi tiết bài viết', exact: true }).click()
      await b.locator('.post-thread').waitFor()
      assert.equal(await b.getByRole('button', { name: 'Xóa bài viết', exact: true }).count(), 0)
      await b.getByRole('button', { name: 'Upvote bài viết', exact: true }).click()
      await b.getByRole('button', { name: 'Bỏ upvote bài viết', exact: true }).waitFor()
      assert.equal(votes.size, 1)
      await b.getByLabel('Bình luận của bạn', { exact: true }).fill('B bình luận local, retry cùng key.')
      await b.getByLabel('Bình luận của bạn', { exact: true }).press('Control+Enter')
      await b.getByRole('button', { name: 'Thử gửi lại', exact: true }).click()
      await b.locator('.comment-card').waitFor()
      const attempts = calls.filter(c => c.action === 'createComment' && c.actor === 1)
      assert.equal(attempts.length, 2); assert.deepEqual(attempts[0].payload, attempts[1].payload)
      assert.equal(comments.size, 1, 'Lost ACK mock không tạo comment trùng')
      await a.goto(`${origin}/bai-viet/${first.id}`); await a.locator('.comment-card').waitFor()
      assert.equal(await a.locator('.upvote-button').getAttribute('aria-pressed'), 'false')
      assert.match(await a.locator('.upvote-button').innerText(), /^1\s+bình chọn$/)
      await a.getByLabel('Bình luận của bạn', { exact: true }).fill('A trả lời local, nhãn Chủ bài.')
      await a.getByLabel('Bình luận của bạn', { exact: true }).press('Control+Enter')
      await a.locator('.op-label').waitFor()
      await b.getByRole('button', { name: 'Làm mới bình luận', exact: true }).click()
      await b.locator('.op-label').waitFor()
      assert.equal(await b.locator('.comment-card').count(), 2)
      // List và Detail refetch song song; đợi cả count render, không chỉ nhãn OP.
      await b.waitForFunction(() => /2\s+bình luận/.test(document.querySelector('.post-stats')?.textContent ?? ''))
      assert.match(await b.locator('.post-stats').innerText(), /2\s+bình luận/)
      for (const page of [a, b]) {
        const html = await page.locator('.social-wrap').innerHTML()
        for (const user of users) { assert.ok(!html.includes(user.id)); assert.ok(!html.includes(user.email)) }
        assert.doesNotMatch(html, /authorId|author_id|userMetadata|offline-only-upload/)
      }
      await shot(b, 'b-detail-op-comment')
      await b.getByRole('button', { name: 'Bỏ upvote bài viết', exact: true }).click()
      await b.getByRole('button', { name: 'Upvote bài viết', exact: true }).waitFor(); assert.equal(votes.size, 0)
      const second = await publish(2)
      await b.goto(`${origin}/bai-viet/${second.id}`); await b.locator('.carousel-counter').waitFor()
      assert.equal(await b.locator('.carousel-counter').innerText(), '1/2')
      await b.getByRole('button', { name: 'Ảnh tiếp theo', exact: true }).click()
      assert.equal(await b.locator('.carousel-counter').innerText(), '2/2')
      await shot(b, 'b-two-images')
      await b.goto(origin); await b.getByRole('button', { name: 'Tải thêm', exact: true }).click()
      await b.getByRole('button', { name: 'Tải thêm', exact: true }).click()
      await b.getByText(old.body, { exact: true }).waitFor()
      assert.equal(await b.locator('.post-card').count(), 3)
      await b.getByRole('button', { name: 'Nổi bật 24h', exact: true }).click()
      await b.getByRole('button', { name: 'Tải thêm', exact: true }).click()
      await b.getByText(first.body, { exact: true }).waitFor()
      assert.equal(await b.locator('.post-card').count(), 2); assert.equal(await b.getByText(old.body, { exact: true }).count(), 0)
      await b.getByRole('button', { name: 'Review môn', exact: true }).click()
      await b.getByText('Chưa có bài viết nào.', { exact: false }).waitFor()
      assert.equal(calls.filter(c => c.action === 'listPosts').at(-1).payload.cursor, null)
      await b.goto(origin + '/admin'); await b.getByRole('heading', { name: 'Không có quyền kiểm duyệt' }).waitFor()
      admin = true; await b.reload()
      await b.getByRole('heading', { name: 'Kiểm duyệt nội dung', exact: true }).waitFor(); await shot(b, 'b-admin-form')
      await b.getByLabel('Loại nội dung').selectOption('COMMENT')
      await b.getByLabel('UUID bình luận', { exact: true }).fill([...comments.values()][0].id)
      await b.getByLabel('Lý do ẩn nội dung', { exact: true }).fill('Lý do tổng hợp E2E local.')
      b.once('dialog', d => d.accept()); await b.getByRole('button', { name: 'Ẩn nội dung', exact: true }).click()
      await b.getByText('Đã ẩn nội dung và ghi lịch sử kiểm duyệt.').waitFor()
      await a.goto(`${origin}/bai-viet/${first.id}`); await a.locator('.comment-card').waitFor()
      assert.equal(await a.locator('.comment-card').count(), 1); assert.equal(visibleComments(first.id).length, 1)
      a.once('dialog', d => d.dismiss()); await a.getByRole('button', { name: 'Xóa bài viết', exact: true }).click()
      assert.equal(first.status, 'PUBLISHED')
      a.once('dialog', d => d.accept()); await a.getByRole('button', { name: 'Xóa bài viết', exact: true }).click()
      await a.waitForURL(origin + '/'); assert.equal(first.status, 'DELETED')
      await b.goto(`${origin}/bai-viet/${first.id}`); await b.getByRole('heading', { name: 'Không tìm thấy bài viết', exact: true }).waitFor()
      await b.goto(origin + '/admin'); await b.getByLabel('UUID hoặc URL bài viết', { exact: true }).fill(second.id)
      await b.getByLabel('Lý do ẩn nội dung', { exact: true }).fill('Lý do tổng hợp E2E local.')
      b.once('dialog', d => d.accept()); await b.getByRole('button', { name: 'Ẩn nội dung', exact: true }).click()
      await b.getByText('Đã ẩn nội dung và ghi lịch sử kiểm duyệt.').waitFor()
      assert.equal(audits.length, 2); assert.equal(second.status, 'HIDDEN')
      await a.goto(`${origin}/bai-viet/${second.id}`); await a.getByRole('heading', { name: 'Không tìm thấy bài viết', exact: true }).waitFor()
      await shot(a, 'a-hidden-not-found')
      admin = false; await b.goto(origin + '/admin'); await b.reload()
      await b.getByRole('heading', { name: 'Không có quyền kiểm duyệt' }).waitFor()
      await a.getByRole('link', { name: 'Cá nhân', exact: true }).click(); await a.getByRole('button', { name: 'Đăng xuất', exact: true }).click(); await a.waitForURL(origin + '/')
      await a.getByText(guestRows[0].body, { exact: true }).waitFor()
      await b.goto(origin); await b.getByRole('heading', { name: 'Bảng tin', exact: true }).waitFor()
      assert.equal(await guest.locator('.post-card').count(), 1)
      assert.equal(calls.filter(c => c.action === 'createPost').length, 2)
      assert.deepEqual(runtimeErrors, []); assert.deepEqual(blocked, [])
      console.log(`PASS: cross-context React E2E ${width}/${theme}; A/B/guest isolated, media1/2, OP, vote/count, lost ACK, NEW/HOT/pages, delete/hide, mock audits, logout isolation.`)
    } finally { await Promise.all(contexts.map(context => context.close())) }
  }
  console.log(`PASS: local E2E; ${shots} screenshots; no Cloud calls. Mock audit is not DB atomicity proof.`)
} finally { await browser?.close(); server.kill() }
