import type { SupabaseClient } from '@supabase/supabase-js'
import { ApiError, failure, success } from '../social-api/shared/response.ts'
import { validateRequest } from '../social-api/shared/validation.ts'
import { queryPostPage } from '../social-api/modules/posts/post-service.ts'
import { mapGuestPost } from '../social-api/modules/posts/post-mapper.ts'
import { uuidPattern } from '../social-api/modules/posts/post-validation.ts'

export function approvedPublicPostIds(value: string) {
  if (!value.trim()) return []
  const ids = value.split(',').map((id) => id.trim().toLowerCase())
  if (ids.length > 100 || ids.some((id) => !uuidPattern.test(id)) || new Set(ids).size !== ids.length) {
    throw new ApiError('INTERNAL_ERROR')
  }
  return ids.sort()
}

interface Dependencies {
  createAdminClient(): SupabaseClient
  allowedOrigins: string[]
  readApprovedIds(): string
  readCursorSecret(): string
  now?: () => number
}

export function createPublicFeedHandler(deps: Dependencies) {
  return async (request: Request): Promise<Response> => {
    const headers = new Headers({ 'cache-control': 'no-store', vary: 'Origin' }),
      requestId = crypto.randomUUID()
    try {
      const origin = request.headers.get('origin')
      if (origin && !deps.allowedOrigins.includes(origin)) throw new ApiError('FORBIDDEN')
      if (origin) headers.set('access-control-allow-origin', origin)
      headers.set('access-control-allow-methods', 'POST, OPTIONS')
      headers.set('access-control-allow-headers', 'authorization, apikey, content-type, x-client-info')
      if (request.method === 'OPTIONS') {
        if (
          (request.headers.get('access-control-request-method') ?? 'POST') !== 'POST' ||
          (request.headers.get('access-control-request-headers') ?? '').toLowerCase().split(',').filter(
            Boolean,
          )
            .some((h) => !['authorization', 'apikey', 'content-type', 'x-client-info'].includes(h.trim()))
        ) {
          throw new ApiError('VALIDATION_ERROR')
        }
        return new Response(null, { status: 204, headers })
      }
      const body = await validateRequest(request)
      if (body.action !== 'listPosts') throw new ApiError('VALIDATION_ERROR')
      const ids = approvedPublicPostIds(deps.readApprovedIds()), secret = deps.readCursorSecret()
      if (!/^[A-Za-z0-9_-]{43,128}$/.test(secret)) throw new ApiError('INTERNAL_ERROR')
      // Cursor guest tách namespace và bị vô hiệu khi owner đổi phạm vi public.
      const scopeKey = Array.from(
        new Uint8Array(
          await crypto.subtle.digest(
            'SHA-256',
            new TextEncoder().encode(`public-feed/v1\n${secret}\n${ids.join(',')}`),
          ),
        ),
        (b) => b.toString(16).padStart(2, '0'),
      ).join('')
      const signal = AbortSignal.any([request.signal, AbortSignal.timeout(10_000)])
      const client = deps.createAdminClient()
      const page = await queryPostPage(
        client,
        body.payload,
        scopeKey,
        deps.now?.() ?? Date.now(),
        signal,
        ids,
      )
      const items = page.rows.map(mapGuestPost)
      if (!items.length) return success({ items, nextCursor: page.nextCursor }, requestId, headers)
      const visible = await client.from('posts').select('id').in('id', items.map((p) => p.id))
        .eq('status', 'PUBLISHED').eq('display_mode', 'ANONYMOUS').abortSignal(signal)
      if (visible.error || !Array.isArray(visible.data)) throw new ApiError('INTERNAL_ERROR')
      const current = new Set(visible.data.map((p) => p.id))
      return success(
        { items: items.filter((p) => ids.includes(p.id) && current.has(p.id)), nextCursor: page.nextCursor },
        requestId,
        headers,
      )
    } catch (error) {
      return failure(error, requestId, headers)
    }
  }
}
