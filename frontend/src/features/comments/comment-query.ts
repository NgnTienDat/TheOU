import { CancelledError, infiniteQueryOptions, queryOptions, type QueryClient } from '@tanstack/react-query'
import type { CommentPublic, Page, SocialApiClient } from '../../shared/api/SocialApiClient.ts'
import { readPost } from '../posts/post-read.ts'

export const commentsKey = (scope: number, postId: string) => ['comments', scope, postId] as const
export const detailKey = (scope: number, postId: string) => ['post', scope, postId] as const
export function detailOptions(api: Pick<SocialApiClient,'getPost'>, scope: number, postId: string, isCurrent: () => boolean, reject: (error: unknown) => void) {
  return queryOptions({ queryKey: detailKey(scope,postId), retry: false, refetchOnWindowFocus: false, queryFn: async ({ signal }) => {
    try { const post = await readPost(api,postId); if (signal.aborted || !isCurrent()) throw new CancelledError(); return post }
    catch (error) { if (signal.aborted || !isCurrent()) throw new CancelledError(); reject(error); throw error }
  } })
}
export function commentOptions(api: Pick<SocialApiClient,'listComments'>, scope: number, postId: string, isCurrent: () => boolean, reject: (error: unknown) => void) {
  return infiniteQueryOptions({ queryKey: commentsKey(scope,postId), initialPageParam: null as string|null, retry: false, refetchOnWindowFocus: false,
    queryFn: async ({ pageParam, signal }) => {
      try { const page = await api.listComments({ postId,cursor:pageParam,limit:20 }); if (signal.aborted || !isCurrent()) throw new CancelledError(); return page }
      catch (error) { if (signal.aborted || !isCurrent()) throw new CancelledError(); reject(error); throw error }
    }, getNextPageParam: (last: Page<CommentPublic>) => last.nextCursor ?? undefined,
  })
}
export function uniqueComments(pages: Page<CommentPublic>[] = []) {
  const seen = new Set<string>()
  return pages.flatMap(page => page.items).filter(comment => { if (seen.has(comment.id)) return false; seen.add(comment.id); return true })
}
export async function refreshComments(cache: QueryClient, scope: number, postId: string) {
  await cache.cancelQueries({queryKey:commentsKey(scope,postId),exact:true})
  await Promise.all([cache.resetQueries({queryKey:commentsKey(scope,postId),exact:true}),cache.invalidateQueries({queryKey:detailKey(scope,postId),exact:true}),cache.invalidateQueries({queryKey:['posts',scope]})])
}
