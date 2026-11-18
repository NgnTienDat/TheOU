import { ApiError } from './response.ts'
import { type PostRequest, validatePostRequest } from '../modules/posts/post-validation.ts'
import { type CommentRequest, validateCommentRequest } from '../modules/comments/comment-validation.ts'
import { type UpvoteInput, validateUpvote } from '../modules/votes/vote-validation.ts'
import { type MediaRequest, validateMedia } from '../modules/media/media-validation.ts'

export type SocialRequest =
  | PostRequest
  | MediaRequest
  | CommentRequest
  | { action: 'toggleUpvote'; payload: UpvoteInput }
  | { action: 'getMe'; payload: Record<string, never> }
  | {
    action: 'updateNickname'
    payload: { nickname: string }
  }

export function validateNickname(value: unknown): string {
  if (typeof value !== 'string' || /[\p{Cc}\p{Cf}]/u.test(value)) {
    throw new ApiError('VALIDATION_ERROR')
  }
  const nickname = value.trim()
  if (
    [...nickname].length < 3 || [...nickname].length > 30 ||
    /(?:https?:\/\/|www\.|[\p{L}\p{N}-]+\.[a-z]{2,}(?:\b|\/))/iu.test(nickname)
  ) throw new ApiError('VALIDATION_ERROR')
  return nickname
}

export async function validateRequest(request: Request): Promise<SocialRequest> {
  if (
    request.method !== 'POST' ||
    request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json'
  ) {
    throw new ApiError('VALIDATION_ERROR')
  }
  // Giới hạn cả stream để không tin Content-Length do client khai báo.
  const reader = request.body?.getReader()
  if (!reader) throw new ApiError('VALIDATION_ERROR')
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > 16384) {
        await reader.cancel()
        throw new ApiError('VALIDATION_ERROR')
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  let body: unknown
  try {
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    throw new ApiError('VALIDATION_ERROR')
  }
  if (
    !isObject(body) || Object.keys(body).length !== 2 || !isObject(body.payload)
  ) {
    throw new ApiError('VALIDATION_ERROR')
  }
  if (body.action === 'getMe' && Object.keys(body.payload).length === 0) {
    return { action: 'getMe', payload: {} }
  }
  if (body.action === 'toggleUpvote') {
    return { action: 'toggleUpvote', payload: validateUpvote(body.payload) }
  }
  if (
    typeof body.action === 'string' &&
    ['createImageUpload', 'finalizeImage', 'removeDraftImage'].includes(body.action)
  ) return validateMedia(body.action, body.payload)
  if (
    body.action === 'updateNickname' && Object.keys(body.payload).length === 1 && 'nickname' in body.payload
  ) {
    return { action: 'updateNickname', payload: { nickname: validateNickname(body.payload.nickname) } }
  }
  return typeof body.action === 'string' &&
      ['listComments', 'createComment', 'deleteComment'].includes(body.action)
    ? validateCommentRequest(body.action, body.payload)
    : validatePostRequest(body.action, body.payload)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
