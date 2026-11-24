// React + approved HTML reference; all Auth/API calls are mocked and external hosts blocked.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { chromium } from 'playwright-core'

const root = fileURLToPath(new URL('../', import.meta.url))
const html = await readFile(join(root, '../docs/fe-templates/TheOU-Landing-Black-White.html'), 'utf8')
const origin = 'http://127.0.0.1:5195', endpoint = 'https://offline.example.invalid'
const artifacts = join(root, 'node_modules/.cache/theou-landing-ui')
const executablePath = process.env.THEOU_BROWSER_PATH
assert.ok(executablePath, 'Select the verified Chrome binary')
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '5195', '--strictPort'], {
  cwd: root, windowsHide: true, stdio: 'ignore', env: { ...process.env, VITE_SUPABASE_URL: endpoint, VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_offline' },
})
const id = '30000000-0000-4000-8000-000000000001'
const user = { id, email: 'landing.synthetic@ou.edu.vn', email_confirmed_at: '2026-11-01T00:00:00Z', aud: 'authenticated', app_metadata: {}, user_metadata: {} }
const token = `${Buffer.from('{"alg":"HS256"}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: id, exp: 4000000000 })).toString('base64url')}.offline`
const session = { user, access_token: token, refresh_token: 'offline-refresh', token_type: 'bearer', expires_in: 3600, expires_at: 4000000000 }
const envelope = data => ({ data, error: null, meta: { requestId: id } })
const errors = [], blocked = [], calls = [], comparisons = []
let browser, holdMe = false, releaseMe
try {
  let ready = false
  for (let n = 0; n < 100; n++) {
    try { if ((await fetch(origin)).ok) { ready = true; break } } catch { /* Wait for local Vite. */ }
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  assert.ok(ready)
  browser = await chromium.launch({ executablePath, headless: true })
  const cdp = await browser.newBrowserCDPSession(), version = await cdp.send('Browser.getVersion')
  assert.match(version.product, /^Chrome\//)
  console.log(`Verified ${version.product}; local/mock only`)
  await cdp.detach()
  const context = await browser.newContext({ reducedMotion: 'reduce' })
  await context.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url())
    if (url.origin === origin && url.pathname === '/__landing-reference.html') return route.fulfill({ contentType: 'text/html', body: html })
    if (url.origin === origin) return route.continue()
    if (url.origin !== endpoint) { blocked.push(url.hostname); return route.abort() }
    const input = req.postDataJSON() ?? {}
    let body
    if (url.pathname.endsWith('/token')) body = session
    else if (url.pathname.endsWith('/user')) body = user
    else if (url.pathname.endsWith('/logout')) body = {}
    else if (url.pathname.endsWith('/public-feed')) {
      calls.push('public-feed'); assert.equal(req.headers().authorization, undefined)
      body = envelope({ items: [], nextCursor: null })
    } else if (url.pathname.endsWith('/social-api') && input.action === 'getMe') {
      calls.push('getMe')
      if (holdMe) await new Promise(resolve => { releaseMe = resolve })
      body = envelope({ nickname: 'OUer synthetic', emailMasked: '***@ou.edu.vn', isAdmin: false })
    } else if (url.pathname.endsWith('/social-api') && input.action === 'listPosts') {
      assert.equal(req.headers().authorization, `Bearer ${token}`)
      calls.push('listPosts')
      body = envelope({ items: [], nextCursor: null })
    } else assert.fail('Unexpected mock action')
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(body), headers: { 'access-control-allow-origin': '*' } })
  })
  const page = await context.newPage(), reference = await context.newPage()
  page.setDefaultTimeout(10000); reference.setDefaultTimeout(10000)
  page.on('pageerror', e => errors.push(e.message))
  reference.on('pageerror', e => errors.push(e.message))
  await mkdir(artifacts, { recursive: true })
  await page.goto(origin)
  await page.locator('#landing').waitFor()
  const navCta = page.locator('#landing .nav-actions .btn')
  const loginLink = page.locator('#landing .nav-actions .login-link')
  await loginLink.waitFor()
  assert.equal(await navCta.getAttribute('href'), '/bang-tin')
  assert.equal(new URL(page.url()).pathname, '/')
  assert.equal(await page.title(), 'TheOU — Landing Page · Đen – trắng')
  assert.equal(await page.locator('#landing .nav-links').count(), 0)
  assert.equal(await loginLink.getAttribute('href'), '/dang-nhap')
  assert.deepEqual(await page.locator('#landing .brand-icon span').allTextContents(), ['t', 't'])
  assert.equal(await page.getByText('© 2026 TheOU. All rights reserved.', { exact: true }).count(), 1)
  assert.equal(calls.length, 0, 'Landing demo must not request real business data')
  const postText = p => p.locator('#demo-posts .post-body').allTextContents()
  await reference.goto(origin + '/__landing-reference.html')
  // Apply only the three owner-approved visual changes to the comparison reference.
  await reference.evaluate(() => {
    document.querySelector('#landing .nav-links').remove()
    const originalLogin = document.querySelector('#landing .login-link')
    const login = document.createElement('a')
    login.className = 'login-link'; login.textContent = originalLogin.textContent
    login.setAttribute('href', '/dang-nhap'); originalLogin.remove()
    document.querySelector('#landing .nav-actions').append(login)
    document.querySelectorAll('#landing .brand-icon span').forEach(e => { e.textContent = 't' })
    const copy = document.createElement('div')
    copy.className = 'footer-copy'; copy.textContent = '© 2026 TheOU. All rights reserved.'
    document.querySelector('#landing .footer-copy').after(copy)
  })
  for (const sort of ['new', 'hot']) for (const tag of ['all', 'confession', 'review', 'documents', 'housing', 'urgent']) {
    for (const p of [page, reference]) { await p.locator(`#landing [data-sort="${sort}"]`).click(); await p.locator(`#landing [data-tag="${tag}"]`).click() }
    assert.deepEqual(await postText(page), await postText(reference))
    assert.equal(await page.locator(`#landing [data-tag="${tag}"]`).getAttribute('aria-pressed'), 'true')
    assert.equal(await page.locator(`#landing [data-sort="${sort}"]`).getAttribute('aria-pressed'), 'true')
  }
  for (const p of [page, reference]) { await p.locator('[data-sort="new"]').click(); await p.locator('[data-tag="all"]').click() }
  function metrics() {
    const keys = ['display','position','fontFamily','fontSize','fontWeight','lineHeight','letterSpacing','color','backgroundColor','paddingTop','paddingRight','paddingBottom','paddingLeft','marginTop','marginRight','marginBottom','marginLeft','borderTopWidth','borderTopColor','borderRadius','boxShadow','gap','alignItems','justifyContent','gridTemplateColumns','whiteSpace','overflowX']
    return [...document.querySelectorAll('#landing, #landing *')].map(e => {
      const r = e.getBoundingClientRect(), c = getComputedStyle(e)
      return { node: `${e.tagName}.${e.getAttribute('class') ?? ''}`, box: [r.x, r.y + scrollY, r.width, r.height].map(x => Math.round(x * 100) / 100), style: Object.fromEntries(keys.map(k => [k, c[k]])) }
    })
  }
  let shots = 0
  for (const width of [1440, 1280, 768, 390, 360]) for (const theme of ['dark','light']) {
    for (const p of [page, reference]) {
      await p.setViewportSize({ width, height: 900 })
      if (p === page) await p.evaluate(theme => { document.documentElement.dataset.theme = theme }, theme)
      await p.evaluate(() => scrollTo(0, 0))
      await p.mouse.move(0, 0)
    }
    const actual = await page.evaluate(metrics), expected = await reference.evaluate(metrics)
    const differences = actual.flatMap((a, i) => {
      const e = expected[i]
      if (!e) return [{ index: i, actual: a, expected: null }]
      const styles = Object.keys(a.style).filter(k => a.style[k] !== e.style[k])
      return a.node !== e.node || a.box.some((v, n) => Math.abs(v - e.box[n]) > .3) || styles.length ? [{ index: i, node: a.node, boxes: [a.box, e.box], styles: styles.map(k => [k, a.style[k], e.style[k]]) }] : []
    })
    await writeFile(join(artifacts, `metrics-${width}-${theme}.json`), JSON.stringify({ actual, expected, differences }, null, 2))
    assert.equal(actual.length, expected.length, 'DOM structure matches modified approved reference')
    if (differences.length) console.log(JSON.stringify(differences.slice(0, 8)))
    assert.equal(differences.length, 0, `Geometry/styles differ at ${width}/${theme}`)
    for (const [name, target] of [['top', null], ['middle', '#ben-trong'], ['bottom', '.site-footer']]) {
      for (const p of [page, reference]) {
        const y = target ? await p.locator('#landing ' + target).evaluate(e => e.getBoundingClientRect().top + scrollY) : 0
        await p.evaluate(y => scrollTo({ top: y, behavior: 'instant' }), y)
      }
      const a = await page.screenshot({ path: join(artifacts, `react-${width}-${theme}-${name}.png`), animations: 'disabled' })
      const e = await reference.screenshot({ path: join(artifacts, `reference-${width}-${theme}-${name}.png`), animations: 'disabled' })
      comparisons.push({ width, theme, name, pngIdentical: a.equals(e) }); shots++
    }
  }
  await writeFile(join(artifacts, 'comparison.json'), JSON.stringify(comparisons, null, 2))
  assert.ok(comparisons.every(c => c.pngIdentical), 'Screenshots must match the modified approved HTML pixel-for-pixel')
  console.log(`PASS visual geometry/styles: 5 viewports x 2 themes; ${shots} React + ${shots} reference screenshots; identical PNG ${comparisons.filter(c => c.pngIdentical).length}/${shots}`)
  for (const [selector, target] of [['.hero-cta a[href="#ben-trong"]','#ben-trong'], ['.cta-panel a','#kham-pha'], ['.footer-links a[href="#dau-trang"]','#dau-trang']]) {
    await page.locator('#landing ' + selector).click()
    await page.waitForFunction(target => {
      const r = document.querySelector(target).getBoundingClientRect()
      return r.top < innerHeight && r.bottom > 0
    }, target)
  }
  assert.equal(calls.length, 0)
  await navCta.click(); await page.waitForURL('**/bang-tin')
  await page.waitForFunction(() => document.querySelector('.social-wrap') !== null)
  assert.ok(calls.includes('public-feed'), 'Guest discovery uses public feed')
  await page.goto(origin); await loginLink.waitFor()
  await loginLink.click(); await page.waitForURL('**/dang-nhap')
  await page.getByLabel('Email trường', { exact: true }).fill(user.email)
  await page.getByLabel('Mật khẩu', { exact: true }).fill('Offline-password!')
  await page.getByRole('button', { name: 'Đăng nhập', exact: true }).click(); await page.waitForURL('**/bang-tin')
  await page.goto(origin); await page.locator('#landing').waitFor()
  await page.waitForFunction(() => document.querySelector('#landing .nav-actions a')?.getAttribute('href') === '/bang-tin')
  assert.equal(new URL(page.url()).pathname, '/', 'Authenticated root must remain Landing')
  assert.equal(await loginLink.count(), 0, 'Member does not need a login link')
  await navCta.click(); await page.waitForURL('**/bang-tin')
  await page.getByRole('link', { name: 'Cá nhân', exact: true }).click()
  await page.getByRole('button', { name: 'Đăng xuất', exact: true }).click(); await page.waitForURL('**/bang-tin')
  await page.goto(origin); await page.locator('#landing').waitFor()
  await loginLink.waitFor()
  assert.equal(await navCta.getAttribute('href'), '/bang-tin')
  for (const p of ['/bai-viet/moi', '/bai-viet/' + id, '/ca-nhan', '/admin']) { await page.goto(origin + p); await page.waitForURL('**/dang-nhap') }
  await context.addInitScript(session => { localStorage.setItem('sb-offline-auth-token', JSON.stringify(session)) }, session)
  holdMe = true
  await page.goto(origin); await page.locator('#landing').waitFor()
  assert.equal(await navCta.getAttribute('href'), '/bang-tin')
  assert.equal(await navCta.getAttribute('aria-disabled'), null)
  for (let n = 0; n < 100 && !releaseMe; n++) await page.waitForTimeout(10)
  assert.ok(releaseMe, 'Restoring session has reached getMe')
  holdMe = false; releaseMe()
  await page.waitForFunction(() => document.querySelector('#landing .nav-actions a')?.getAttribute('href') === '/bang-tin')
  await page.reload(); await page.locator('#landing').waitFor()
  assert.equal(new URL(page.url()).pathname, '/')
  assert.deepEqual(errors, []); assert.deepEqual(blocked, [])
  console.log('PASS routing/Auth CTA/restore/demo/scroll: Landing has zero posts/media API requests; no Cloud calls')
} finally {
  await browser?.close()
  server.kill()
}
