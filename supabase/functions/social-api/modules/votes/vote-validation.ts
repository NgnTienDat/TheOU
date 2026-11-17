import { ApiError } from '../../shared/response.ts'
import { postId } from '../posts/post-validation.ts'

export interface UpvoteInput {
  postId: string
  desiredState: boolean
}
export function validateUpvote(payload: Record<string, unknown>): UpvoteInput {
  if (
    Object.keys(payload).sort().join(',') !== 'desiredState,postId' ||
    typeof payload.desiredState !== 'boolean'
  ) throw new ApiError('VALIDATION_ERROR')
  return { postId: postId(payload.postId), desiredState: payload.desiredState }
}
