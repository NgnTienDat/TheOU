import { CancelledError, infiniteQueryOptions, type QueryClient } from '@tanstack/react-query'
import type { ListPostsInput, Page, PostPublic, SocialApiClient } from '../../shared/api/SocialApiClient.ts'

export type FeedFilter = Pick<ListPostsInput, 'sort' | 'tag'>
export const feedKey = (scope: number, filter: FeedFilter) => ['posts', scope, filter.sort, filter.tag] as const
export function feedOptions(api: Pick<SocialApiClient, 'listPosts'>, scope: number, filter: FeedFilter, isCurrent: () => boolean, reject: (error: unknown) => void) {
  return infiniteQueryOptions({
    queryKey: feedKey(scope, filter), initialPageParam: null as string | null,
    queryFn: async ({ pageParam, signal }) => {
      try {
        const page = await api.listPosts({ ...filter, cursor: pageParam, limit: 20 })
        if (signal.aborted || !isCurrent()) throw new CancelledError()
        return page
      } catch (error) {
        if (signal.aborted || !isCurrent()) throw new CancelledError()
        reject(error); throw error
      }
    },
    getNextPageParam: (last: Page<PostPublic>) => last.nextCursor ?? undefined,
    retry: false, refetchOnWindowFocus: false,
  })
}
export function uniquePosts(pages: Page<PostPublic>[] = []) {
  const seen = new Set<string>()
  return pages.flatMap(page => page.items).filter(post => {
    if (seen.has(post.id)) return false
    seen.add(post.id); return true
  })
}
export async function resetFeed(cache: QueryClient, scope: number, filter: FeedFilter) {
  await cache.resetQueries({ queryKey: feedKey(scope, filter), exact: true })
}
