import { ApiError } from '../../shared/response.ts'
import { signCursor, verifyCursor } from '../../shared/cursor.ts'
import { timestampPattern, uuidPattern } from '../posts/post-validation.ts'

interface CommentCursor {
  v: 1
  kind: 'comments'
  postId: string
  asOf: number
  createdAt: string
  id: string
}
export async function encodeCommentCursor(value: Omit<CommentCursor, 'v' | 'kind'>, secret: string) {
  return await signCursor({ v: 1, kind: 'comments', ...value }, secret)
}
export async function decodeCommentCursor(value: string, postId: string, secret: string, now: number) {
  const cursor = await verifyCursor(value, secret) as CommentCursor
  if (
    !cursor || Object.keys(cursor).sort().join(',') !== 'asOf,createdAt,id,kind,postId,v' || cursor.v !== 1 ||
    cursor.kind !== 'comments' ||
    cursor.postId !== postId || !Number.isSafeInteger(cursor.asOf) || cursor.asOf > now + 60_000 ||
    now - cursor.asOf > 900_000 ||
    typeof cursor.id !== 'string' || !uuidPattern.test(cursor.id) || typeof cursor.createdAt !== 'string' ||
    !timestampPattern.test(cursor.createdAt) ||
    !Number.isFinite(Date.parse(cursor.createdAt)) || Date.parse(cursor.createdAt) > cursor.asOf
  ) throw new ApiError('VALIDATION_ERROR')
  return cursor
}
