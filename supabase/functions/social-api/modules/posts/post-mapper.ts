import { ApiError } from '../../shared/response.ts'
import {
  contactUrl,
  type DisplayMode,
  type PostTag,
  postTags,
  timestampPattern,
  uuidPattern,
} from './post-validation.ts'

// Chỉ các cột cần ở Edge; không select * hoặc serialize row qua response.
export const postColumns =
  'id,author_id,tag,body,display_mode,nickname_snapshot,contact_url,status,published_at,upvote_count,comment_count,post_images(count)'
export interface PostRow {
  id: string
  author_id: string
  tag: PostTag
  body: string
  display_mode: DisplayMode
  nickname_snapshot: string | null
  contact_url: string | null
  status: string
  published_at: string
  upvote_count: number
  comment_count: number
  post_images: { count: number }[]
}
export interface PostPublic {
  id: string
  tag: PostTag
  body: string
  displayMode: DisplayMode
  authorLabel: string
  contactUrl: string | null
  publishedAt: string
  upvoteCount: number
  commentCount: number
  hasUpvoted: boolean
  isMine: boolean
  images: never[]
}
export function mapPost(row: PostRow, viewerId: string, hasUpvoted: boolean): PostPublic {
  if (
    !row || !uuidPattern.test(row.id) || !uuidPattern.test(row.author_id) || row.status !== 'PUBLISHED' ||
    !postTags.includes(row.tag) || typeof row.body !== 'string' || [...row.body].length < 1 ||
    [...row.body].length > 1000 ||
    !['ANONYMOUS', 'NICKNAME'].includes(row.display_mode) || typeof row.published_at !== 'string' ||
    !timestampPattern.test(row.published_at) || !Number.isFinite(Date.parse(row.published_at)) ||
    !Number.isSafeInteger(row.upvote_count) || row.upvote_count < 0 ||
    !Number.isSafeInteger(row.comment_count) || row.comment_count < 0 ||
    !Array.isArray(row.post_images) || row.post_images.length !== 1 || row.post_images[0].count !== 0
  ) throw new ApiError('INTERNAL_ERROR')
  let url: string | null
  try {
    url = contactUrl(row.contact_url, row.display_mode, row.tag)
  } catch {
    throw new ApiError('INTERNAL_ERROR')
  }
  if (row.display_mode === 'ANONYMOUS' && row.nickname_snapshot !== null) throw new ApiError('INTERNAL_ERROR')
  if (
    row.display_mode === 'NICKNAME' && (typeof row.nickname_snapshot !== 'string' ||
      [...row.nickname_snapshot].length < 3 || [...row.nickname_snapshot].length > 30)
  ) throw new ApiError('INTERNAL_ERROR')
  return {
    id: row.id,
    tag: row.tag,
    body: row.body,
    displayMode: row.display_mode,
    authorLabel: row.display_mode === 'ANONYMOUS' ? 'OUer ẩn danh' : row.nickname_snapshot!,
    contactUrl: url,
    publishedAt: row.published_at.replace('+00:00', 'Z'),
    upvoteCount: row.upvote_count,
    commentCount: row.comment_count,
    hasUpvoted,
    isMine: row.author_id === viewerId,
    images: [],
  }
}
