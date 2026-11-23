import { useState } from 'react'
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '../auth/AuthProvider.tsx'
import { feedKey, feedOptions, resetFeed, uniquePosts, type FeedFilter } from './feed-query.ts'

export function useFeed() {
  const { api, publicApi, state, scope, controller } = useAuth()
  const guest = state.phase === 'guest'
  const cache = useQueryClient()
  const [filter, setFilter] = useState<FeedFilter>({ sort: 'NEW', tag: null })
  const query = useInfiniteQuery({ ...feedOptions(guest ? publicApi : api, scope, filter, () => controller.getScope() === scope,
    guest ? () => {} : controller.reject, guest), enabled: guest || state.phase === 'ready' })
  function changeFilter(next: FeedFilter) {
    if (next.sort === filter.sort && next.tag === filter.tag) return
    // Không tái hiện trang/cursor đã lưu của filter khác trong lần chọn mới.
    const key = feedKey(scope, next, guest)
    void cache.cancelQueries({ queryKey: key, exact: true })
    cache.removeQueries({ queryKey: key, exact: true })
    setFilter(next); window.scrollTo({ top: 0, behavior: 'instant' })
  }
  return { query, filter, changeFilter, guest, posts: uniquePosts(query.data?.pages),
    refresh: () => resetFeed(cache, scope, filter, guest),
    loadMore: () => { if (query.hasNextPage && !query.isFetching) void query.fetchNextPage({ cancelRefetch: false }) },
  }
}
