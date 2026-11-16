import { ApiError } from '../../shared/response.ts'

export const postTags = ['CONFESSION', 'REVIEW_MON', 'TAI_LIEU', 'TIM_TRO', 'HOI_GAP'] as const
export type PostTag = typeof postTags[number]
export type DisplayMode = 'ANONYMOUS' | 'NICKNAME'
export const uuidPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i
export const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$/
export interface CreatePostInput {
  body: string
  tag: PostTag
  displayMode: DisplayMode
  contactUrl: string | null
  idempotencyKey: string
}
export interface ListPostsInput {
  sort: 'NEW' | 'HOT'
  tag: PostTag | null
  cursor: string | null
  limit: number
}
export type PostRequest = { action: 'createPost'; payload: CreatePostInput } | {
  action: 'publishPost' | 'getPost'
  payload: { postId: string }
} | { action: 'listPosts'; payload: ListPostsInput }

function invalid(): never {
  throw new ApiError('VALIDATION_ERROR')
}
export function postId(value: unknown): string {
  if (typeof value !== 'string' || !uuidPattern.test(value)) invalid()
  return value.toLowerCase()
}
export function contactUrl(value: unknown, mode: DisplayMode, tag: PostTag): string | null {
  if (value === undefined || value === null) return null
  if (
    mode !== 'NICKNAME' || !['TAI_LIEU', 'TIM_TRO'].includes(tag) || typeof value !== 'string' ||
    value.length > 2048 || /[\s\p{Cc}]/u.test(value)
  ) invalid()
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return invalid()
  }
  if (
    url.protocol !== 'https:' || url.username || url.password || url.port ||
    !['zalo.me', 'facebook.com', 'www.facebook.com', 'm.facebook.com', 'm.me'].includes(url.hostname)
  ) invalid()
  // URL.href chuẩn hóa hostname, path và cổng HTTPS mặc định trước khi đối chiếu idempotency.
  return url.href
}
export function validatePostRequest(action: unknown, payload: Record<string, unknown>): PostRequest {
  const keys = Object.keys(payload)
  if (action === 'createPost') {
    if (
      keys.some((key) => !['body', 'tag', 'displayMode', 'contactUrl', 'idempotencyKey'].includes(key)) ||
      typeof payload.body !== 'string' || typeof payload.tag !== 'string' ||
      !postTags.includes(payload.tag as PostTag) || typeof payload.displayMode !== 'string' ||
      !['ANONYMOUS', 'NICKNAME'].includes(payload.displayMode)
    ) invalid()
    const body = payload.body.trim()
    if (
      [...body].length < 1 || [...body].length > 1000 || body.includes(String.fromCharCode(0)) ||
      /[\uD800-\uDFFF]/u.test(body)
    ) invalid()
    const tag = payload.tag as PostTag
    const displayMode = payload.displayMode as DisplayMode
    return {
      action,
      payload: {
        body,
        tag,
        displayMode,
        contactUrl: contactUrl(payload.contactUrl, displayMode, tag),
        idempotencyKey: postId(payload.idempotencyKey),
      },
    }
  }
  if (action === 'getPost' || action === 'publishPost') {
    if (keys.length !== 1 || keys[0] !== 'postId') invalid()
    return { action, payload: { postId: postId(payload.postId) } }
  }
  if (action === 'listPosts') {
    if (
      keys.length !== 4 || keys.some((key) => !['sort', 'tag', 'cursor', 'limit'].includes(key)) ||
      typeof payload.sort !== 'string' || !['NEW', 'HOT'].includes(payload.sort) ||
      (payload.tag !== null && !postTags.includes(payload.tag as PostTag)) ||
      (payload.cursor !== null &&
        (typeof payload.cursor !== 'string' || payload.cursor.length < 1 || payload.cursor.length > 1024)) ||
      !Number.isInteger(payload.limit) || Number(payload.limit) < 1 || Number(payload.limit) > 20
    ) invalid()
    return { action, payload: payload as unknown as ListPostsInput }
  }
  return invalid()
}
