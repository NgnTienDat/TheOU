import type { SupabaseClient } from '@supabase/supabase-js'
import { getMe, getOrCreateProfile } from './modules/profile/get-me.ts'
import { updateNickname } from './modules/profile/update-nickname.ts'
import { createPost, getPost, listPosts, publishPost } from './modules/posts/post-service.ts'
import { createComment, deleteComment, listComments } from './modules/comments/comment-service.ts'
import { toggleUpvote } from './modules/votes/vote-service.ts'
import { authenticate } from './shared/authentication.ts'
import { authorizeAccount } from './shared/authorization.ts'
import { ApiError, failure, success } from './shared/response.ts'
import { validateRequest } from './shared/validation.ts'

interface Dependencies {
  createAuthClient: () => SupabaseClient
  createAdminClient: () => SupabaseClient
  allowedOrigins: string[]
  readCursorSecret?: () => string
  now?: () => number
}

export function createSocialApiHandler(deps: Dependencies) {
  return async (request: Request): Promise<Response> => {
    const requestId = crypto.randomUUID()
    const headers = new Headers({ 'cache-control': 'no-store', vary: 'Origin' })
    try {
      const origin = request.headers.get('origin')
      if (origin && !deps.allowedOrigins.includes(origin)) throw new ApiError('FORBIDDEN')
      if (origin) headers.set('access-control-allow-origin', origin)
      headers.set('access-control-allow-methods', 'POST, OPTIONS')
      headers.set('access-control-allow-headers', 'authorization, apikey, content-type, x-client-info')
      if (request.method === 'OPTIONS') {
        const method = request.headers.get('access-control-request-method')
        const requestedHeaders =
          request.headers.get('access-control-request-headers')?.toLowerCase().split(',') ?? []
        if (
          (method && method !== 'POST') ||
          requestedHeaders.some((name) =>
            !['authorization', 'apikey', 'content-type', 'x-client-info'].includes(name.trim())
          )
        ) {
          throw new ApiError('VALIDATION_ERROR')
        }
        return new Response(null, { status: 204, headers })
      }
      const body = await validateRequest(request)
      const user = await authenticate(request, deps.createAuthClient)
      const admin = deps.createAdminClient()
      const profile = await getOrCreateProfile(admin, user.id)
      const isAdmin = await authorizeAccount(admin, user.id, profile)
      if (body.action === 'updateNickname') {
        return success(await updateNickname(admin, user.id, body.payload.nickname), requestId, headers)
      }
      const ctx = {
        client: admin,
        userId: user.id,
        profile,
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(10_000)]),
      }
      if (body.action === 'createPost') {
        return success(await createPost(ctx, body.payload), requestId, headers)
      }
      if (body.action === 'toggleUpvote') {
        return success(await toggleUpvote(ctx, body.payload), requestId, headers)
      }
      if (body.action === 'publishPost') {
        return success(await publishPost(ctx, body.payload.postId), requestId, headers)
      }
      if (body.action === 'getPost') {
        return success(await getPost(ctx, body.payload.postId), requestId, headers)
      }
      if (body.action === 'listPosts') {
        return success(
          await listPosts(ctx, body.payload, deps.readCursorSecret?.() ?? '', deps.now?.() ?? Date.now()),
          requestId,
          headers,
        )
      }
      if (body.action === 'createComment') {
        return success(await createComment(ctx, body.payload), requestId, headers)
      }
      if (body.action === 'deleteComment') {
        return success(await deleteComment(ctx, body.payload.commentId), requestId, headers)
      }
      if (body.action === 'listComments') {
        return success(
          await listComments(ctx, body.payload, deps.readCursorSecret?.() ?? '', deps.now?.() ?? Date.now()),
          requestId,
          headers,
        )
      }
      return success(getMe(user, profile, isAdmin), requestId, headers)
    } catch (error) {
      // Không log error/response thô: có thể chứa SQL, email hoặc bearer token.
      return failure(error, requestId, headers)
    }
  }
}
