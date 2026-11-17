import { ApiError } from '../../shared/response.ts'
import { postId } from '../posts/post-validation.ts'

export interface CreateCommentInput {
  postId: string
  body: string
  idempotencyKey: string
}
export interface ListCommentsInput {
  postId: string
  cursor: string | null
  limit: number
}
export type CommentRequest =
  | { action: 'createComment'; payload: CreateCommentInput }
  | { action: 'listComments'; payload: ListCommentsInput }
  | { action: 'deleteComment'; payload: { commentId: string } }

export function validateCommentRequest(action: unknown, payload: Record<string, unknown>): CommentRequest {
  const keys = Object.keys(payload).sort().join(',')
  if (action === 'deleteComment' && keys === 'commentId') {
    return { action, payload: { commentId: postId(payload.commentId) } }
  }
  if (
    action === 'createComment' && keys === 'body,idempotencyKey,postId' && typeof payload.body === 'string'
  ) {
    const body = payload.body.trim()
    if (
      [...body].length < 1 || [...body].length > 500 || body.includes(String.fromCharCode(0)) ||
      /[\uD800-\uDFFF]/u.test(body)
    ) throw new ApiError('VALIDATION_ERROR')
    return {
      action,
      payload: { postId: postId(payload.postId), body, idempotencyKey: postId(payload.idempotencyKey) },
    }
  }
  if (
    action === 'listComments' && keys === 'cursor,limit,postId' && Number.isInteger(payload.limit) &&
    Number(payload.limit) >= 1 && Number(payload.limit) <= 20 &&
    (payload.cursor === null ||
      (typeof payload.cursor === 'string' && payload.cursor.length >= 1 && payload.cursor.length <= 1024))
  ) {
    return {
      action,
      payload: {
        postId: postId(payload.postId),
        limit: Number(payload.limit),
        cursor: payload.cursor as string | null,
      },
    }
  }
  throw new ApiError('VALIDATION_ERROR')
}
