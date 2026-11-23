import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createPublicFeed } from '../src/shared/api/public-feed.ts'
import { feedKey } from '../src/features/feed/feed-query.ts'
import { post } from './post-fixture.ts'

test('Guest adapter sends no JWT/credentials, only public-feed listPosts and safe DTO', async () => {
  const guest = { ...post(), displayMode: 'ANONYMOUS' as const, authorLabel: 'OUer ẩn danh', contactUrl: null, images: [], isMine: false, hasUpvoted: false }
  const input = { sort: 'NEW' as const, tag: null, limit: 20, cursor: null }
  const envelope = (item: unknown) => ({ data: { items: [item], nextCursor: null }, error: null, meta: { requestId: '11111111-1111-4111-8111-111111111111' } })
  let value: unknown = guest, requests = 0
  const api = createPublicFeed('https://offline.example.invalid', 'sb_publishable_offline', async (url, init) => {
    requests++
    assert.equal(url, 'https://offline.example.invalid/functions/v1/public-feed')
    assert.equal(init?.credentials, 'omit'); assert.equal(new Headers(init?.headers).get('authorization'), null)
    assert.deepEqual(JSON.parse(String(init?.body)), { action: 'listPosts', payload: input })
    return Response.json(envelope(value))
  })
  assert.deepEqual((await api.listPosts(input)).items, [guest])
  for (const patch of [{ isMine: true }, { hasUpvoted: true }, { author_id: 'private' }, { displayMode: 'NICKNAME', authorLabel: 'private' }, { images: [{ signedUrl: 'private' }] }]) {
    value = { ...guest, ...patch }
    await assert.rejects(() => api.listPosts(input))
  }
  assert.equal(requests, 6)
  assert.notDeepEqual(feedKey(1, input, true), feedKey(1, input))
})
