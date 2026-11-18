import type { QueryClient } from '@tanstack/react-query'
import type { Page, PostPublic, SocialApiClient } from '../../shared/api/SocialApiClient.ts'

type Reader = Pick<SocialApiClient, 'getPost'>
// API client gắn với Auth scope; chỉ giữ request đang chạy, không cache URL ngoài phiên.
const pending = new WeakMap<Reader, Map<string, Promise<PostPublic>>>()
export function readPost(api: Reader, postId: string): Promise<PostPublic> {
  let requests = pending.get(api)
  if (!requests) { requests = new Map(); pending.set(api, requests) }
  const existing = requests.get(postId)
  if (existing) return existing
  const request = api.getPost(postId).finally(() => { if (requests.get(postId) === request) requests.delete(postId) })
  requests.set(postId, request)
  return request
}

export async function readPostImages(cache: QueryClient, api: Reader, scope: number, postId: string): Promise<PostPublic> {
  // Chờ query đang ký URL; chỉ lấy images ở caller, không ghi đè counts/optimistic cache.
  const detail = cache.getQueryCache().find({ queryKey: ['post', scope, postId], exact: true })
  if (detail?.state.fetchStatus === 'fetching' && detail.promise) return detail.promise as Promise<PostPublic>
  for (const query of cache.getQueryCache().findAll({ queryKey: ['posts', scope] })) {
    const data = query.state.data as { pages: Page<PostPublic>[] } | undefined
    if (query.state.fetchStatus !== 'fetching' || !query.promise || !data?.pages.some(page => page.items.some(post => post.id === postId))) continue
    const result = await query.promise as { pages: Page<PostPublic>[] }
    const post = result.pages.flatMap(page => page.items).find(post => post.id === postId)
    if (post) return post
  }
  return readPost(api, postId)
}
