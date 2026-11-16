import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createClient } from '@supabase/supabase-js'
import { createSocialApi, parseSocialResponse, SocialApiError } from '../src/shared/api/social-api.ts'

const me = { nickname: 'OUer offline', emailMasked: '***@ou.edu.vn', isAdmin: false }
const envelope = (data: unknown) => ({ data, error: null, meta: { requestId: '00000000-0000-4000-8000-000000000001' } })
test('adapter gắn JWT phiên lúc tạo, không dùng ngầm JWT hiện tại của SDK', async () => {
  const headers: string[] = []
  const client = createClient('https://offline.example.invalid', 'sb_publishable_offline', {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: 'Bearer different-sdk-session' }, fetch: async (_input, init) => {
      headers.push(new Headers(init?.headers).get('authorization')!); return Response.json(envelope(me))
    } },
  })
  await createSocialApi(client, 'offline-captured-session').getMe()
  assert.deepEqual(headers, ['Bearer offline-captured-session'])
})
test('adapter getMe/updateNickname gọi functions.invoke, data đúng allowlist', async () => {
  const calls: unknown[] = []
  const client = createClient('https://offline.example.invalid', 'sb_publishable_offline', {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: async (input, init) => {
      assert.equal(new URL(String(input)).pathname, '/functions/v1/social-api')
      const body = JSON.parse(String(init?.body)); calls.push(body)
      return Response.json(envelope(body.action === 'getMe' ? me : { nickname: body.payload.nickname }))
    } },
  })
  const api = createSocialApi(client)
  assert.deepEqual(await api.getMe(), me)
  assert.deepEqual(await api.updateNickname('Tên mới'), { nickname: 'Tên mới' })
  assert.deepEqual(calls, [{ action: 'getMe', payload: {} }, { action: 'updateNickname', payload: { nickname: 'Tên mới' } }])
})
test('adapter loại DTO rò email/id/metadata, envelope malformed và phản hồi không đúng contract', () => {
  for (const body of [
    envelope({ ...me, id: 'private' }), envelope({ ...me, email: 'private@ou.edu.vn' }),
    envelope({ ...me, metadata: { role: 'ADMIN' } }), envelope({ ...me, emailMasked: 'private@ou.edu.vn' }),
    envelope({ ...me, isAdmin: 'true' }), { ...envelope(me), meta: {} }, { data: me }, envelope(null),
  ]) assert.throws(() => parseSocialResponse(body, 200, 'getMe'), SocialApiError)
  assert.deepEqual(parseSocialResponse(envelope(me), 200, 'getMe'), me)
  assert.throws(() => parseSocialResponse(envelope({ nickname: 'Tên mới', status: 'ACTIVE' }), 200, 'updateNickname'))
})
test('handler/gateway 401 và 403 an toàn, server/network không lộ raw errors', async () => {
  for (const [status, expected] of [[401, 'UNAUTHENTICATED'], [403, 'FORBIDDEN'], [400, 'VALIDATION_ERROR'], [404, 'NOT_FOUND'], [409, 'CONFLICT'], [503, 'INTERNAL_ERROR']] as const) {
    const client = createClient('https://offline.example.invalid', 'sb_publishable_offline', {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch: async () => Response.json({ code: 'SECRET', message: 'email password JWT SQL' }, { status }) },
    })
    await assert.rejects(createSocialApi(client).getMe(), error => {
      assert.ok(error instanceof SocialApiError)
      assert.equal(error.code, expected)
      assert.doesNotMatch(error.message, /SECRET|email password|JWT|SQL/); return true
    })
  }
})

const post = { id: '10000000-0000-4000-8000-000000000001', tag: 'CONFESSION', body: 'Bài text offline',
  displayMode: 'ANONYMOUS', authorLabel: 'OUer ẩn danh', contactUrl: null, publishedAt: '2026-11-16T12:00:00.123456Z',
  upvoteCount: 0, commentCount: 0, hasUpvoted: false, isMine: true, images: [] }
test('adapter bốn action post dùng invoke, payload đúng contract và DTO được kiểm tra runtime', async () => {
  const calls: unknown[] = []
  const client = createClient('https://offline.example.invalid', 'sb_publishable_offline', {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: async (_input, init) => {
      const body = JSON.parse(String(init?.body)); calls.push(body)
      const data = body.action === 'createPost' ? { postId: post.id, status: 'DRAFT' }
        : body.action === 'listPosts' ? { items: [post], nextCursor: null } : post
      return Response.json(envelope(data))
    } },
  })
  const api = createSocialApi(client)
  const input = { body: post.body, tag: 'CONFESSION' as const, displayMode: 'ANONYMOUS' as const, idempotencyKey: post.id }
  assert.deepEqual(await api.createPost(input), { postId: post.id, status: 'DRAFT' })
  assert.deepEqual(await api.publishPost(post.id), post)
  assert.deepEqual(await api.getPost(post.id), post)
  const page = { sort: 'NEW' as const, tag: null, cursor: null, limit: 20 }
  assert.deepEqual(await api.listPosts(page), { items: [post], nextCursor: null })
  assert.deepEqual(calls, [{ action: 'createPost', payload: input }, { action: 'publishPost', payload: { postId: post.id } },
    { action: 'getPost', payload: { postId: post.id } }, { action: 'listPosts', payload: page }])
})
test('adapter từ chối post DTO rò identity, media chưa hỗ trợ và page/ACK malformed', () => {
  for (const changes of [{ author_id: 'private' }, { email: 'private@ou.edu.vn' }, { nickname_snapshot: 'private' },
    { authorLabel: 'Nickname private' }, { contactUrl: 'https://zalo.me/private' }, { images: [{ storagePath: 'private' }] },
    { tag: { toString: 'CONFESSION' } }, { displayMode: 'PRIVATE' }, { upvoteCount: -1 }, { hasUpvoted: 'true' }]) {
    for (const action of ['getPost', 'publishPost'] as const)
      assert.throws(() => parseSocialResponse(envelope({ ...post, ...changes }), 200, action), SocialApiError)
  }
  for (const data of [{ items: [post], nextCursor: 'x'.repeat(1025) }, { items: Array(21).fill(post), nextCursor: null },
    { items: [{ ...post, authorId: 'private' }], nextCursor: null }, { items: [], nextCursor: null, authorId: 'private' }])
    assert.throws(() => parseSocialResponse(envelope(data), 200, 'listPosts'), SocialApiError)
  assert.throws(() => parseSocialResponse(envelope({ postId: post.id, status: 'PUBLISHED' }), 200, 'createPost'), SocialApiError)
  assert.deepEqual(parseSocialResponse(envelope({ items: [], nextCursor: null }), 200, 'listPosts'), { items: [], nextCursor: null })
  const nickname = { ...post, tag: 'TAI_LIEU', displayMode: 'NICKNAME', authorLabel: 'Nickname snapshot', contactUrl: 'https://zalo.me/offline' }
  assert.deepEqual(parseSocialResponse(envelope(nickname), 200, 'getPost'), nickname)
  assert.throws(() => parseSocialResponse(envelope({ ...nickname, contactUrl: 'https://zalo.me.evil.invalid/' }), 200, 'getPost'), SocialApiError)
})
