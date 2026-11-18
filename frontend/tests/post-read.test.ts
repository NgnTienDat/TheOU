import assert from 'node:assert/strict'
import { test } from 'node:test'
import { InfiniteQueryObserver, QueryClient, QueryObserver } from '@tanstack/react-query'
import { detailOptions } from '../src/features/comments/comment-query.ts'
import { feedOptions } from '../src/features/feed/feed-query.ts'
import { readPost, readPostImages } from '../src/features/posts/post-read.ts'
import { createImageRefresh } from '../src/features/posts/image-refresh.ts'
import { deferred, post } from './post-fixture.ts'

const cache = () => new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
test('Detail and Feed ignore focus under TTL; explicit invalidation still refetches', async () => {
  const client = cache(); let reads = 0, lists = 0
  const api = { getPost: async () => { reads++; return post() }, listPosts: async () => { lists++; return { items: [post()], nextCursor: null } } }
  const detail = new QueryObserver(client, detailOptions(api, 1, post().id, () => true, () => {}))
  const feed = new InfiniteQueryObserver(client, feedOptions(api, 1, { sort: 'NEW', tag: null }, () => true, () => {}))
  const stops = [detail.subscribe(() => {}), feed.subscribe(() => {})]
  await detail.refetch(); await feed.refetch()
  const before = [reads, lists]
  client.getQueryCache().onFocus(); await new Promise(resolve => setTimeout(resolve, 10))
  assert.deepEqual([reads, lists], before)
  await client.invalidateQueries({ queryKey: ['post', 1] })
  assert.equal(reads, before[0] + 1)
  stops.forEach(stop => stop()); client.clear()
})
test('same post/client shares in-flight getPost; another session/post does not', async () => {
  let calls = 0
  const response = deferred<ReturnType<typeof post>>()
  const api = { getPost: () => { calls++; return response.promise } }
  const first = readPost(api, post().id)
  assert.equal(readPost(api, post().id), first)
  void readPost(api, post(2).id)
  void readPost({ getPost: api.getPost }, post().id)
  assert.equal(calls, 3)
  response.resolve(post()); await first
  await readPost(api, post().id); assert.equal(calls, 4)
})
test('gallery joins fetching Detail without publishing stale counts to cache', async () => {
  const client = cache(), response = deferred<ReturnType<typeof post>>()
  let calls = 0
  const api = { getPost: () => { calls++; return response.promise } }
  const detail = client.fetchQuery(detailOptions(api, 1, post().id, () => true, () => {}))
  const gallery = readPostImages(client, api, 1, post().id)
  response.resolve(post()); await Promise.all([detail, gallery])
  assert.equal(calls, 1)
  client.setQueryData(['post', 1, post().id], { ...post(), upvoteCount: 9, commentCount: 7, hasUpvoted: true })
  await readPostImages(client, api, 1, post().id)
  assert.equal(client.getQueryData<ReturnType<typeof post>>(['post', 1, post().id])?.upvoteCount, 9)
  assert.equal(client.getQueryData<ReturnType<typeof post>>(['post', 1, post().id])?.commentCount, 7)
  client.clear()
})
test('gallery waits for a fetching Feed instead of signing twice', async () => {
  const client = cache(), response = deferred<{ items: ReturnType<typeof post>[]; nextCursor: null }>()
  const options = feedOptions({ listPosts: () => response.promise }, 1, { sort: 'NEW', tag: null }, () => true, () => {})
  client.setQueryData(options.queryKey, { pages: [{ items: [post()], nextCursor: null }], pageParams: [null] })
  const query = client.fetchInfiniteQuery(options)
  let calls = 0
  const gallery = readPostImages(client, { getPost: async () => { calls++; return post() } }, 1, post().id)
  response.resolve({ items: [post()], nextCursor: null }); await query; await gallery
  assert.equal(calls, 0); client.clear()
})
test('failed in-flight read is cleared and stays isolated from another session', async () => {
  let calls = 0
  const api = { getPost: async () => { if (++calls === 1) throw new Error('private error'); return post() } }
  await assert.rejects(readPost(api, post().id)); await readPost(api, post().id)
  assert.equal(calls, 2)
})
test('two mounted galleries share API work but a disposed consumer cannot accept it', async () => {
  let calls = 0, accepted = 0
  const response = deferred<ReturnType<typeof post>>(), started = deferred<void>()
  const api = { getPost: () => { calls++; started.resolve(); return response.promise } }
  const options = { wait: async () => {}, isCurrent: () => true, load: () => readPost(api, post().id),
    accept: () => { accepted++ }, reject: () => assert.fail() }
  const a = createImageRefresh(options), b = createImageRefresh(options)
  const requests = [a.refresh(), b.refresh()]; await started.promise
  a.dispose(); response.resolve(post()); await Promise.all(requests)
  assert.equal(calls, 1); assert.equal(accepted, 1)
})
