import type { InfiniteData, QueryClient, QueryKey } from '@tanstack/react-query'
import type { Page, PostPublic, SocialApiClient, UpvoteState } from '../../shared/api/SocialApiClient.ts'
import { SocialApiError } from '../../shared/api/social-api.ts'
import { detailKey } from '../comments/comment-query.ts'

export interface UpvoteInput { postId: string; desiredState: boolean }
export const upvoteKey = (scope: number, postId: string) => ['upvote', scope, postId] as const
type CachedPosts = PostPublic | InfiniteData<Page<PostPublic>>
interface Snapshot { key: QueryKey; queryHash: string; refetched: boolean; before: PostPublic[]; optimistic: PostPublic[] }

function mapPosts(data: CachedPosts | undefined, map: (post: PostPublic) => PostPublic): CachedPosts | undefined {
  if (!data) return data
  return 'pages' in data ? { ...data, pages: data.pages.map(page => ({ ...page, items: page.items.map(map) })) } : map(data)
}
function matching(data: CachedPosts | undefined, id: string) {
  const posts: PostPublic[] = []
  mapPosts(data, post => { if (post.id === id) posts.push(post); return post })
  return posts
}
function reconcile(cache: QueryClient, snapshots: Snapshot[], result?: UpvoteState) {
  for (const snapshot of snapshots.filter(value => !value.refetched)) cache.setQueryData<CachedPosts>(snapshot.key, data => mapPosts(data, post => {
    // Chỉ sửa object optimistic còn nguyên; không rollback/refill đè dữ liệu vừa refetch.
    const index = snapshot.optimistic.indexOf(post)
    if (index < 0) return post
    const vote = result ?? snapshot.before[index]
    return { ...post, hasUpvoted: vote.hasUpvoted, upvoteCount: vote.upvoteCount }
  }))
}

export async function runUpvote(cache: QueryClient, api: Pick<SocialApiClient, 'setUpvote'>, scope: number,
  input: UpvoteInput, isCurrent: () => boolean, reject: (error: unknown) => void) {
  const key = upvoteKey(scope, input.postId)
  const mutations = cache.getMutationCache()
  let unsubscribe: (() => void) | undefined
  if (!isCurrent() || mutations.find({ mutationKey: key, exact: true, status: 'pending' })) return
  // Giữ tối đa một intent/post/phiên, gồm lỗi chưa ACK; Auth clear() dọn cả mutation cache.
  for (const previous of mutations.findAll({ mutationKey: key, exact: true })) mutations.remove(previous)
  const mutation = mutations.build<UpvoteState, SocialApiError, UpvoteInput, Snapshot[]>(cache, {
    mutationKey: key, retry: false, gcTime: Infinity,
    mutationFn: async value => {
      if (!isCurrent()) throw new SocialApiError('UNAUTHENTICATED')
      try { return await api.setUpvote(value.postId, value.desiredState) }
      catch (error) { throw error instanceof SocialApiError ? error : new SocialApiError('INTERNAL_ERROR') }
    },
    onMutate: async value => {
      await Promise.all([cache.cancelQueries({ queryKey: ['posts', scope] }), cache.cancelQueries({ queryKey: detailKey(scope, value.postId), exact: true })])
      if (!isCurrent()) return []
      const snapshots: Snapshot[] = []
      for (const [queryKey, data] of cache.getQueriesData<CachedPosts>({ predicate: query =>
        query.queryKey[1] === scope && (query.queryKey[0] === 'posts' || (query.queryKey[0] === 'post' && query.queryKey[2] === value.postId)) })) {
        const before = matching(data, value.postId)
        if (!before.length) continue
        cache.setQueryData<CachedPosts>(queryKey, old => mapPosts(old, post => post.id !== value.postId ? post : {
          ...post, hasUpvoted: value.desiredState,
          upvoteCount: Math.max(0, post.upvoteCount + Number(value.desiredState) - Number(post.hasUpvoted)),
        }))
        snapshots.push({ key: queryKey, queryHash: cache.getQueryCache().find({ queryKey, exact: true })!.queryHash, refetched: false,
          before, optimistic: matching(cache.getQueryData<CachedPosts>(queryKey), value.postId) })
      }
      unsubscribe = cache.getQueryCache().subscribe(event => {
        // Structural sharing có thể giữ reference khi response mới giống optimistic.
        if (event.type === 'updated' && event.action.type === 'success' && !event.action.manual)
          for (const snapshot of snapshots) if (snapshot.queryHash === event.query.queryHash) snapshot.refetched = true
      })
      return snapshots
    },
    onSuccess: (result, _value, snapshots) => { if (isCurrent()) reconcile(cache, snapshots ?? [], result) },
    onError: (error, _value, snapshots) => {
      if (!isCurrent()) return
      reconcile(cache, snapshots ?? []); reject(error)
    },
  })
  try { return await mutation.execute(input) }
  catch { /* Lỗi an toàn và desiredState được giữ trong mutation để UI retry. */ }
  finally {
    unsubscribe?.()
    if (isCurrent()) {
      await cache.invalidateQueries({ queryKey: ['posts', scope], refetchType: 'none' })
      if (!cache.isMutating({ mutationKey: key, exact: true })) await cache.invalidateQueries({ queryKey: detailKey(scope, input.postId), exact: true })
      // Chờ mọi post pending kết thúc trước refetch Feed để không xóa optimistic của post khác.
      if (!cache.isMutating({ mutationKey: ['upvote', scope] })) {
        await Promise.all([
          cache.resetQueries({ predicate: query => query.queryKey[0] === 'posts' && query.queryKey[1] === scope && query.queryKey[2] === 'HOT' }),
          cache.invalidateQueries({ predicate: query => query.queryKey[0] === 'posts' && query.queryKey[1] === scope && query.queryKey[2] === 'NEW' }),
        ])
      }
    }
  }
}
