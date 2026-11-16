import { useState } from 'react'
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '../auth/AuthProvider.tsx'
import { feedKey, feedOptions, resetFeed, uniquePosts, type FeedFilter } from './feed-query.ts'

export function useFeed() {
  const { api, scope, controller } = useAuth()
  const cache = useQueryClient()
  const [filter, setFilter] = useState<FeedFilter>({ sort: 'NEW', tag: null })
  const query = useInfiniteQuery(feedOptions(api, scope, filter, () => controller.getScope() === scope, controller.reject))
  function changeFilter(next: FeedFilter) {
    if (next.sort === filter.sort && next.tag === filter.tag) return
    // Không tái hiện trang/cursor đã lưu của filter khác trong lần chọn mới.
    const key = feedKey(scope, next)
    void cache.cancelQueries({ queryKey: key, exact: true })
    cache.removeQueries({ queryKey: key, exact: true })
    setFilter(next); window.scrollTo({ top: 0, behavior: 'instant' })
  }
  return { query, filter, changeFilter, posts: uniquePosts(query.data?.pages),
    refresh: () => resetFeed(cache, scope, filter),
    loadMore: () => { if (query.hasNextPage && !query.isFetching) void query.fetchNextPage({ cancelRefetch: false }) },
  }
}
