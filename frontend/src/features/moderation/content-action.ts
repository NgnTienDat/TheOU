import type { InfiniteData, QueryClient } from '@tanstack/react-query'
import type { Page, PostPublic } from '../../shared/api/SocialApiClient.ts'
import { SocialApiError } from '../../shared/api/social-api.ts'

export function moderationTarget(value: string, type: 'POST' | 'COMMENT', origin: string): string | null {
  let id = value.trim()
  const uuid = /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i
  if (!uuid.test(id) && type === 'POST') {
    try {
      const url = new URL(id)
      if (url.origin !== origin || url.username || url.password || url.search || url.hash) return null
      id = /^\/bai-viet\/([^/]+)$/.exec(url.pathname)?.[1] ?? ''
    } catch { return null }
  }
  return uuid.test(id) ? id.toLowerCase() : null
}
export function moderationReasonError(value: string) {
  return !value.trim() || [...value.trim()].length > 500 || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(value)
    ? 'Nhập lý do từ 1–500 ký tự, không chứa ký tự điều khiển.' : ''
}
export async function runContentAction(cache: QueryClient, scope: number, target: { type: 'POST' | 'COMMENT'; id: string },
  execute: () => Promise<{ success: true }>, current: () => boolean, reject: (error: unknown) => void, onSuccess: () => void) {
  if (!current()) return
  try { await execute() }
  catch (error) {
    if (!current()) return
    const safe = error instanceof SocialApiError ? error : new SocialApiError('INTERNAL_ERROR')
    if (safe.code === 'UNAUTHENTICATED') reject(safe)
    throw safe
  }
  if (!current()) return
  await cache.cancelQueries({ predicate: query => query.queryKey[1] === scope && ['posts', 'post', 'comments'].includes(String(query.queryKey[0])) })
  if (!current()) return
  if (target.type === 'POST') {
    cache.setQueriesData<InfiniteData<Page<PostPublic>>>({ queryKey: ['posts', scope] }, data => data && ({ ...data,
      pages: data.pages.map(page => ({ ...page, items: page.items.filter(post => post.id !== target.id) })) }))
    cache.removeQueries({ queryKey: ['post', scope, target.id], exact: true })
    cache.removeQueries({ queryKey: ['comments', scope, target.id], exact: true })
  }
  // ACK trước khi đổi UI; callback chạy trước invalidation có thể unmount caller.
  onSuccess()
  await Promise.all([
    cache.invalidateQueries({ queryKey: ['posts', scope] }),
    ...(target.type === 'COMMENT' ? [cache.resetQueries({ queryKey: ['comments', scope] }), cache.invalidateQueries({ queryKey: ['post', scope] })] : []),
  ])
}
