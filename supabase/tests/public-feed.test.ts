import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { approvedPublicPostIds, createPublicFeedHandler } from '../functions/public-feed/handler.ts'
import { a, b, cursorSecret, postFixture, publicKeys, serverKey, userEmail } from './helpers/post-fixture.ts'

test('Guest public-feed uses exact approved PUBLISHED ANONYMOUS IDs, safe DTO/no media or identity; NEW/HOT/filter/pages', async (t) => {
  const f = await postFixture()
  let ids = '', secret = cursorSecret
  const handler = createPublicFeedHandler({
    createAdminClient: () => f.adminClient,
    allowedOrigins: ['http://localhost:5173'],
    readApprovedIds: () => ids,
    readCursorSecret: () => secret,
    now: () => f.state.now,
  })
  const input = { sort: 'NEW', tag: null, cursor: null, limit: 1 }
  const request = (action = 'listPosts', payload: unknown = input, headers = {}) =>
    new Request('https://offline.example.invalid/functions/v1/public-feed', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://localhost:5173', ...headers },
      body: JSON.stringify({ action, payload }),
    })
  const page = async (patch = {}) => {
    const response = await handler(request('listPosts', { ...input, ...patch }))
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    return (await response.json()).data
  }
  try {
    const old = await f.seed({ time: new Date(f.state.now - 172_800_000).toISOString() })
    const first = await f.seed({ time: new Date(f.state.now - 20_000).toISOString(), count: 2 })
    const second = await f.seed({
      time: new Date(f.state.now - 10_000).toISOString(),
      tag: 'HOI_GAP',
      count: 1,
    })
    const unapproved = await f.seed(),
      draft = await f.seed({ status: 'DRAFT' }),
      nickname = await f.seed({ mode: 'NICKNAME' })
    await t.test('empty scope is empty, never all historical posts', async () => {
      f.calls.length = 0
      assert.deepEqual(await page(), { items: [], nextCursor: null })
      assert.equal(f.calls.length, 0)
    })
    ids = [old, first, second, draft, nickname].join(',')
    await t.test('scoped query and pagination/filter/order, no Storage/profiles/votes calls', async () => {
      const one = await page()
      assert.equal(one.items[0].id, second)
      assert.ok(one.nextCursor)
      const two = await page({ cursor: one.nextCursor })
      assert.equal(two.items[0].id, first)
      const three = await page({ cursor: two.nextCursor })
      assert.equal(three.items[0].id, old)
      assert.equal(three.nextCursor, null)
      assert.equal((await page({ sort: 'HOT' })).items[0].id, first)
      assert.equal((await page({ tag: 'HOI_GAP' })).items[0].id, second)
      const all = await page({ limit: 20 })
      assert.deepEqual(all.items.map((p: { id: string }) => p.id), [second, first, old])
      assert.ok(!all.items.some((p: { id: string }) => [unapproved, draft, nickname].includes(p.id)))
      for (const p of all.items) {
        assert.deepEqual(Object.keys(p).sort(), publicKeys)
        assert.deepEqual(p.images, [])
        assert.equal(p.isMine, false)
        assert.equal(p.hasUpvoted, false)
        assert.equal(p.authorLabel, 'OUer ẩn danh')
        assert.equal(p.contactUrl, null)
      }
      assert.ok(f.calls.every((c) => c.method === 'GET' && c.table === 'posts'))
      assert.equal(f.storage.calls.length, 0)
      assert.doesNotMatch(
        JSON.stringify(all),
        /author_id|nickname_snapshot|storage_path|signedUrl|email|idempotency_key/,
      )
    })
    await t.test('missing/wrong/expired-looking bearer has same public DTO, no Auth request', async () => {
      for (const authorization of ['', 'Bearer invalid', 'Bearer eyJ.expired.signature']) {
        const r = await handler(request('listPosts', input, { authorization }))
        assert.equal(r.status, 200)
        assert.equal((await r.json()).data.items[0].isMine, false)
      }
    })
    await t.test('social-api still denies every protected action without/with invalid JWT; member and cross-owner unchanged', async () => {
      const actions: [string, unknown][] = [
        ['getMe', {}],
        ['getPost', { postId: first }],
        ['listPosts', input],
        ['listComments', { postId: first, cursor: null, limit: 20 }],
        ['createComment', { postId: first, body: 'Bình luận thử', idempotencyKey: a }],
        ['deleteComment', { commentId: a }],
        ['toggleUpvote', { postId: first, desiredState: true }],
        ['createPost', {
          body: 'Nội dung thử',
          tag: 'CONFESSION',
          displayMode: 'ANONYMOUS',
          idempotencyKey: a,
        }],
        ['publishPost', { postId: first }],
        ['deletePost', { postId: first }],
        ['createImageUpload', { postId: first, mimeType: 'image/png', sizeBytes: 10, position: 1 }],
        ['finalizeImage', { postId: first, imageId: a }],
        ['removeDraftImage', { postId: first, imageId: a }],
        ['updateNickname', { nickname: 'Biệt danh thử' }],
        ['adminHideContent', { targetType: 'POST', targetId: first, reason: 'Lý do thử' }],
      ]
      const before = f.calls.length
      for (const authorization of ['', 'Bearer invalid', 'Bearer eyJ.expired.signature']) {
        for (const [action, payload] of actions) {
          assert.equal(
            (await f.handler(f.request(action, payload, null, { authorization }))).status,
            401,
            action,
          )
        }
      }
      assert.equal(f.calls.length, before)
      const member = await f.handler(f.request('getPost', { postId: unapproved }))
      assert.equal(member.status, 200)
      assert.equal((await member.json()).data.isMine, true)
      assert.equal((await f.handler(f.request('deletePost', { postId: first }, b))).status, 404)
      assert.equal(
        (await f.handler(
          f.request('adminHideContent', { targetType: 'POST', targetId: first, reason: 'Lý do thử' }),
        )).status,
        403,
      )
    })
    await t.test('no protected action, invalid/oversized input, method or disallowed CORS origin reaches DB', async () => {
      const before = f.calls.length
      for (
        const action of [
          'getMe',
          'getPost',
          'createPost',
          'publishPost',
          'deletePost',
          'listComments',
          'createComment',
          'deleteComment',
          'toggleUpvote',
          'createImageUpload',
          'finalizeImage',
          'removeDraftImage',
          'updateNickname',
          'adminHideContent',
          'unknown',
        ]
      ) {
        assert.equal((await handler(request(action, {}))).status, 400)
      }
      for (const patch of [{ limit: 0 }, { limit: 21 }, { sort: 'bad' }, { tag: 'bad' }, { authorId: a }]) {
        assert.equal((await handler(request('listPosts', { ...input, ...patch }))).status, 400)
      }
      assert.equal(
        (await handler(request('listPosts', { ...input, padding: 'x'.repeat(17000) }))).status,
        400,
      )
      assert.equal((await handler(new Request('https://offline.example.invalid/'))).status, 400)
      assert.equal(
        (await handler(request('listPosts', input, { origin: 'https://unapproved.invalid' }))).status,
        403,
      )
      assert.equal(f.calls.length, before)
    })
    await t.test('cursor rejects tamper, wrong filter, expiry and revoked scope', async () => {
      const cursor = (await page()).nextCursor
      for (const patch of [{ cursor: cursor + 'a' }, { cursor, sort: 'HOT' }, { cursor, tag: 'HOI_GAP' }]) {
        assert.equal((await handler(request('listPosts', { ...input, ...patch }))).status, 400)
      }
      f.state.now += 901_000
      assert.equal((await handler(request('listPosts', { ...input, cursor }))).status, 400)
      f.state.now -= 901_000
      const saved = ids
      ids = first
      assert.equal((await handler(request('listPosts', { ...input, cursor }))).status, 400)
      ids = saved
    })
    await t.test('hidden/deleted after approval are not returned; misconfig/errors fail closed without raw output', async () => {
      await f.db.query("update posts set status='HIDDEN' where id=$1", [second])
      assert.equal((await page()).items[0].id, first)
      await f.db.query("update posts set status='DELETED' where id=$1", [first])
      assert.equal((await page()).items[0].id, old)
      for (const bad of ['*', 'not-a-uuid', `${old},${old}`]) {
        const saved = ids
        ids = bad
        assert.equal((await handler(request())).status, 500)
        ids = saved
      }
      secret = ''
      assert.equal((await handler(request())).status, 500)
      secret = cursorSecret
      f.state.failTable = 'posts'
      const r = await handler(request())
      assert.equal(r.status, 500)
      const text = await r.text()
      for (const sensitive of [a, serverKey, userEmail, 'SQL stack']) assert.ok(!text.includes(sensitive))
    })
  } finally {
    await f.db.close()
  }
})

test('Public allowlist is bounded/canonical/exact; gateway social-api kept protected, guest only endpoint', async () => {
  assert.deepEqual(approvedPublicPostIds(''), [])
  assert.deepEqual(approvedPublicPostIds(a.toUpperCase()), [a])
  assert.throws(() => approvedPublicPostIds(Array.from({ length: 101 }, () => a).join(',')))
  const config = await readFile(new URL('../config.toml', import.meta.url), 'utf8')
  const block = (name: string) => config.split(`[functions.${name}]`)[1].split(/\n\[/)[0]
  assert.match(block('social-api'), /verify_jwt = true/)
  assert.match(block('public-feed'), /verify_jwt = false/)
})
