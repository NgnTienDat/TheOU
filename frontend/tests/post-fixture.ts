import type { PostPublic } from '../src/shared/api/SocialApiClient.ts'
export const post = (number = 1): PostPublic => ({
  id: `10000000-0000-4000-8000-${String(number).padStart(12, '0')}`, tag: 'CONFESSION', body: `Bài viết offline ${number}`,
  displayMode: 'ANONYMOUS', authorLabel: 'OUer ẩn danh', contactUrl: null, publishedAt: '2026-11-16T12:00:00Z',
  upvoteCount: 0, commentCount: 0, hasUpvoted: false, isMine: false, images: [],
})
export function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
