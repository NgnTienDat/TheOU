import assert from 'node:assert/strict'
import { test } from 'node:test'
import { InfiniteQueryObserver, QueryClient } from '@tanstack/react-query'
import { feedKey, feedOptions, resetFeed, uniquePosts } from '../src/features/feed/feed-query.ts'
import { tagFilters } from '../src/shared/constants/posts.ts'
import { SocialApiError } from '../src/shared/api/social-api.ts'
import type { ListPostsInput, Page, PostPublic } from '../src/shared/api/SocialApiClient.ts'
import { deferred, post } from './post-fixture.ts'

const filter = { sort: 'NEW' as const, tag: null }
const cache = () => new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
test('Feed mapping NEW/HOT/sáu tag; keys tách filter và session, first cursor=null limit=20', async () => {
  assert.deepEqual(tagFilters.map(tag => tag.value), [null, 'CONFESSION', 'REVIEW_MON', 'TAI_LIEU', 'TIM_TRO', 'HOI_GAP'])
  const calls: ListPostsInput[] = []; const client = cache()
  for (const sort of ['NEW', 'HOT'] as const) for (const tag of tagFilters) {
    const next = { sort, tag: tag.value }
    const options = feedOptions({ listPosts: async input => { calls.push(input); return { items: [], nextCursor: null } } }, 1, next, () => true, () => {})
    await client.fetchInfiniteQuery(options)
    assert.deepEqual(calls.at(-1), { ...next, cursor: null, limit: 20 })
  }
  assert.notDeepEqual(feedKey(1, filter), feedKey(2, filter)); assert.equal(client.getQueryCache().getAll().length, 12)
  client.clear()
})
test('Opaque cursor, trang cuối, dedupe giữ thứ tự server; đồng thời next page chỉ gọi một request', async () => {
  const calls: ListPostsInput[] = []; const pending = deferred<Page<PostPublic>>(); const client = cache()
  const options = feedOptions({ listPosts: async input => { calls.push(input); return input.cursor ? pending.promise : { items: [post(2), post(1)], nextCursor: 'opaque-next-cursor' } } }, 1, filter, () => true, () => {})
  const observer = new InfiniteQueryObserver(client, options)
  const stop = observer.subscribe(() => {})
  await observer.refetch()
  assert.equal(observer.getCurrentResult().hasNextPage, true)
  const first = observer.fetchNextPage({ cancelRefetch: false }); const second = observer.fetchNextPage({ cancelRefetch: false })
  assert.equal(observer.getCurrentResult().isFetchingNextPage, true)
  pending.resolve({ items: [post(1), post(3)], nextCursor: null }); await Promise.all([first, second])
  assert.equal(calls.length, 2); assert.equal(calls[1].cursor, 'opaque-next-cursor')
  assert.deepEqual(uniquePosts(observer.getCurrentResult().data?.pages).map(value => value.id), [post(2).id, post(1).id, post(3).id])
  assert.equal(observer.getCurrentResult().hasNextPage, false)
  stop(); client.clear()
})
test('Reset refresh hai trang bắt đầu lại cursor null, không refetch cursor cũ', async () => {
  const calls: (string | null)[] = []; const client = cache()
  const options = feedOptions({ listPosts: async input => { calls.push(input.cursor); return { items: [post()], nextCursor: input.cursor ? null : 'old-cursor' } } }, 1, filter, () => true, () => {})
  const observer = new InfiniteQueryObserver(client, options); const stop = observer.subscribe(() => {})
  await observer.refetch(); await observer.fetchNextPage(); await resetFeed(client, 1, filter)
  assert.deepEqual(calls, [null, 'old-cursor', null]); assert.equal(observer.getCurrentResult().data?.pages.length, 1)
  stop(); client.clear()
})
test('Chuyển filter không giữ previous data; response muộn không ghi đè filter mới', async () => {
  const old = deferred<Page<PostPublic>>(); const client = cache()
  const api = { listPosts: async (input: ListPostsInput) => input.sort === 'NEW' ? old.promise : { items: [post(2)], nextCursor: null } }
  const observer = new InfiniteQueryObserver(client, feedOptions(api, 1, filter, () => true, () => {}))
  const stop = observer.subscribe(() => {})
  observer.setOptions(feedOptions(api, 1, { sort: 'HOT', tag: 'HOI_GAP' }, () => true, () => {}))
  assert.equal(observer.getCurrentResult().data, undefined)
  await observer.refetch(); old.resolve({ items: [post(1)], nextCursor: 'stale' }); await Promise.resolve()
  assert.deepEqual(observer.getCurrentResult().data?.pages[0].items, [post(2)])
  stop(); client.clear()
})
test('Loading/empty/error không retry tự động; cursor error giữ trang đã tải và refresh về null', async () => {
  let calls = 0; const client = cache()
  const options = feedOptions({ listPosts: async input => { calls++; if (input.cursor) throw new SocialApiError('VALIDATION_ERROR'); return { items: [], nextCursor: 'expired' } } }, 1, filter, () => true, () => {})
  const observer = new InfiniteQueryObserver(client, options)
  assert.equal(observer.getCurrentResult().isPending, true)
  const stop = observer.subscribe(() => {})
  await observer.refetch(); assert.deepEqual(observer.getCurrentResult().data?.pages[0].items, [])
  await observer.fetchNextPage(); assert.equal(calls, 2); assert.equal(observer.getCurrentResult().isFetchNextPageError, true)
  assert.equal(observer.getCurrentResult().data?.pages.length, 1)
  await resetFeed(client, 1, filter); assert.equal(calls, 3); assert.equal(observer.getCurrentResult().isError, false)
  stop(); client.clear()
})
test('Logout/cache clear hoặc session change cô lập data và lỗi 401 tới muộn', async () => {
  const client = cache(); const pending = deferred<Page<PostPublic>>(); let current = true; let rejected = 0
  const first = client.fetchInfiniteQuery(feedOptions({ listPosts: async () => pending.promise }, 1, filter, () => current, () => { rejected++ })).catch(() => undefined)
  current = false; await client.cancelQueries(); client.clear()
  await client.fetchInfiniteQuery(feedOptions({ listPosts: async () => ({ items: [post(2)], nextCursor: null }) }, 2, filter, () => true, () => {}))
  pending.reject(new SocialApiError('UNAUTHENTICATED')); await first
  assert.equal(rejected, 0); assert.equal(client.getQueryData(feedKey(1, filter)), undefined)
  assert.deepEqual(uniquePosts(client.getQueryData<{ pages: Page<PostPublic>[] }>(feedKey(2, filter))?.pages), [post(2)])
  client.clear()
})
test('401/403 trong phiên hiện tại đi qua Auth Guard; không nuốt thành empty', async () => {
  for (const code of ['UNAUTHENTICATED', 'FORBIDDEN'] as const) {
    const client = cache(); let rejected: unknown
    await assert.rejects(client.fetchInfiniteQuery(feedOptions({ listPosts: async () => { throw new SocialApiError(code) } }, 1, filter, () => true, error => { rejected = error })), SocialApiError)
    assert.ok(rejected instanceof SocialApiError); assert.equal(rejected.code, code); client.clear()
  }
})
