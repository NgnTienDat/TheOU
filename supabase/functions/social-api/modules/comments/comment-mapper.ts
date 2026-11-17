import { ApiError } from '../../shared/response.ts'
import { timestampPattern, uuidPattern } from '../posts/post-validation.ts'

export const commentColumns = 'id,post_id,author_id,body,status,created_at'
export interface CommentRow {
  id: string
  post_id: string
  author_id: string
  body: string
  status: string
  created_at: string
}
export interface CommentPublic {
  id: string
  postId: string
  body: string
  authorLabel: string
  isOriginalPoster: boolean
  isMine: boolean
  createdAt: string
}
export function mapComment(row: CommentRow, postAuthorId: string, viewerId: string): CommentPublic {
  if (
    !row || !uuidPattern.test(row.id) || !uuidPattern.test(row.post_id) || !uuidPattern.test(row.author_id) ||
    !uuidPattern.test(postAuthorId) || row.status !== 'VISIBLE' || typeof row.body !== 'string' ||
    [...row.body].length < 1 || [...row.body].length > 500 ||
    typeof row.created_at !== 'string' || !timestampPattern.test(row.created_at) ||
    !Number.isFinite(Date.parse(row.created_at))
  ) throw new ApiError('INTERNAL_ERROR')
  const op = row.author_id === postAuthorId
  return {
    id: row.id,
    postId: row.post_id,
    body: row.body,
    authorLabel: op ? 'Chủ bài' : 'OUer ẩn danh',
    isOriginalPoster: op,
    isMine: row.author_id === viewerId,
    createdAt: row.created_at.replace('+00:00', 'Z'),
  }
}
