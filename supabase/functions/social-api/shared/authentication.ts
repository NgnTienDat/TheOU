import type { SupabaseClient } from '@supabase/supabase-js'
import { ApiError } from './response.ts'

export interface AuthenticatedUser {
  id: string
  email: string
}

const ouEmailPattern = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:[.][a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@ou[.]edu[.]vn$/i

export async function authenticate(
  request: Request,
  createAuthClient: () => SupabaseClient,
): Promise<AuthenticatedUser> {
  const header = request.headers.get('authorization') ?? ''
  const match = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i.exec(header)
  if (!match || header.length > 16384) throw new ApiError('UNAUTHENTICATED')

  // getUser(jwt) xác minh với Auth server; không dùng JWT decode hoặc session cache.
  const { data, error } = await createAuthClient().auth.getUser(match[1])
  if (error) {
    if (
      error.status === 401 || error.status === 403 ||
      ['bad_jwt', 'session_not_found', 'user_not_found'].includes(error.code ?? '')
    ) {
      throw new ApiError('UNAUTHENTICATED')
    }
    throw new ApiError('INTERNAL_ERROR')
  }
  const user = data.user
  if (!user || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(user.id)) {
    throw new ApiError('UNAUTHENTICATED')
  }
  const email = user.email
  if (
    user.is_anonymous || !email || email !== email.trim() || email.length > 254 ||
    email.split('@')[0].length > 64 ||
    !ouEmailPattern.test(email) || !user.email_confirmed_at ||
    !Number.isFinite(Date.parse(user.email_confirmed_at))
  ) {
    throw new ApiError('FORBIDDEN')
  }
  return { id: user.id, email }
}
