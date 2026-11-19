import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createClient } from '@supabase/supabase-js'
import { QueryClient } from '@tanstack/react-query'
import { createSocialApi, parseSocialResponse, SocialApiError } from '../src/shared/api/social-api.ts'
import { moderationReasonError, moderationTarget, runContentAction } from '../src/features/moderation/content-action.ts'
import { post, deferred } from './post-fixture.ts'

const origin = 'http://localhost:5173'
const envelope = (data: unknown) => ({ data, error: null, meta: { requestId: post().id } })
test('T11 adapter action/strict ACK/explicit session, no extra identity fields', async () => {
  const calls: unknown[] = []
  const client = createClient('https://offline.example.invalid', 'sb_publishable_offline', { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: async (_input, init) => {
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer offline-session')
    calls.push(JSON.parse(String(init?.body))); return Response.json(envelope({ success: true }))
  } } })
  const api = createSocialApi(client, 'offline-session')
  await api.deletePost(post().id); await api.adminHideContent({ targetType: 'COMMENT', targetId: post(2).id, reason: 'Vi phạm' })
  assert.deepEqual(calls, [{ action: 'deletePost', payload: { postId: post().id } }, { action: 'adminHideContent', payload: { targetType: 'COMMENT', targetId: post(2).id, reason: 'Vi phạm' } }])
  for (const action of ['deletePost', 'adminHideContent'] as const) for (const bad of [{ success: false }, { success: true, adminId: post().id }, { success: true, reason: 'private' }, {}]) assert.throws(() => parseSocialResponse(envelope(bad), 200, action))
})
test('T11 target parser exact UUID or same-origin post URL, never foreign credentials/query/hash', () => {
  assert.equal(moderationTarget(` ${post().id.toUpperCase()} `, 'COMMENT', origin), post().id)
  assert.equal(moderationTarget(`${origin}/bai-viet/${post().id}`, 'POST', origin), post().id)
  for (const value of ['x', `${origin}/bai-viet/${post().id}?secret=x`, `${origin}/bai-viet/${post().id}#x`, `https://evil.invalid/bai-viet/${post().id}`, `${origin}/admin/${post().id}`, `http://u:p@localhost:5173/bai-viet/${post().id}`]) assert.equal(moderationTarget(value, 'POST', origin), null)
  assert.equal(moderationTarget(`${origin}/bai-viet/${post().id}`, 'COMMENT', origin), null)
})
test('T11 reason 1–500 Unicode code points, trim and no controls/format/surrogates', () => {
  assert.equal(moderationReasonError(` ${'👋'.repeat(500)} `), '')
  for (const value of ['', '  ', 'x\n', 'x\u200B', '\uD800', '👋'.repeat(501)]) assert.ok(moderationReasonError(value))
})
function seed() {
  const cache = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } })
  for (const scope of [1, 2]) {
    cache.setQueryData(['posts', scope, 'NEW', null], { pages: [{ items: [post(), post(2)], nextCursor: 'opaque' }], pageParams: [null] })
    cache.setQueryData(['post', scope, post().id], post())
    cache.setQueryData(['comments', scope, post().id], { pages: [], pageParams: [null] })
  }
  return cache
}
test('delete ACK only: remove target Feed/Detail/comments, preserve other post and account', async () => {
  const cache = seed(), response = deferred<{ success: true }>()
  let success = 0
  const old = cache.getQueryData(['posts', 2, 'NEW', null])
  const action = runContentAction(cache, 1, { type: 'POST', id: post().id }, () => response.promise, () => true, () => {}, () => { success++ })
  assert.ok(cache.getQueryData(['post', 1, post().id]), 'no optimistic delete before ACK')
  response.resolve({ success: true }); await action
  assert.equal(success, 1); assert.equal(cache.getQueryData(['post', 1, post().id]), undefined)
  assert.equal(cache.getQueryData(['comments', 1, post().id]), undefined)
  assert.deepEqual(cache.getQueryData<{ pages: { items: { id: string }[] }[] }>(['posts', 1, 'NEW', null])?.pages[0].items.map(p => p.id), [post(2).id])
  assert.deepEqual(cache.getQueryData(['posts', 2, 'NEW', null]), old)
  cache.clear()
})
test('failure preserves UI/cache, safe messages; revoked ADMIN does not turn into account ban', async () => {
  const cache = seed(), before = cache.getQueryData(['post', 1, post().id])
  for (const cause of [new Error('private SQL JWT'), new SocialApiError('FORBIDDEN')]) {
    await assert.rejects(runContentAction(cache, 1, { type: 'POST', id: post().id }, async () => { throw cause }, () => true, () => assert.fail('not account Auth failure'), () => assert.fail()), (e: Error) => !/private|SQL|JWT/.test(e.message))
    assert.deepEqual(cache.getQueryData(['post', 1, post().id]), before)
  }
  cache.clear()
})
test('late success/error after logout/account switch/unmount does not navigate/update/reject', async () => {
  for (const fails of [true, false]) {
    const cache = seed(), response = deferred<{ success: true }>(); let current = true
    const action = runContentAction(cache, 1, { type: 'POST', id: post().id }, () => response.promise, () => current, () => assert.fail(), () => assert.fail())
    current = false
    if (fails) response.reject(new SocialApiError('UNAUTHENTICATED')); else response.resolve({ success: true })
    await action; assert.ok(cache.getQueryData(['post', 1, post().id])); cache.clear()
  }
})
test('COMMENT hide invalidates server counts/comments only within current scope', async () => {
  const cache = seed()
  await runContentAction(cache, 1, { type: 'COMMENT', id: post(3).id }, async () => ({ success: true }), () => true, () => {}, () => {})
  assert.equal(cache.getQueryState(['post', 1, post().id])?.isInvalidated, true)
  assert.equal(cache.getQueryState(['post', 2, post().id])?.isInvalidated, false)
  assert.equal(cache.getQueryData<{ commentCount: number }>(['post', 1, post().id])?.commentCount, 0, 'never decrement counts manually')
  cache.clear()
})
