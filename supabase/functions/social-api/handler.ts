import type { SupabaseClient } from '@supabase/supabase-js'
import { getMe, getOrCreateProfile } from './modules/profile/get-me.ts'
import { authenticate } from './shared/authentication.ts'
import { authorizeAccount } from './shared/authorization.ts'
import { ApiError, failure, success } from './shared/response.ts'
import { validateRequest } from './shared/validation.ts'

interface Dependencies {
  createAuthClient: () => SupabaseClient
  createAdminClient: () => SupabaseClient
  allowedOrigins: string[]
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
      await validateRequest(request)
      const user = await authenticate(request, deps.createAuthClient)
      const admin = deps.createAdminClient()
      const profile = await getOrCreateProfile(admin, user.id)
      const isAdmin = await authorizeAccount(admin, user.id, profile)
      return success(getMe(user, profile, isAdmin), requestId, headers)
    } catch (error) {
      // Không log error/response thô: có thể chứa SQL, email hoặc bearer token.
      return failure(error, requestId, headers)
    }
  }
}
