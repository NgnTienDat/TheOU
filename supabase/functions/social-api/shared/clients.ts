import { createClient } from '@supabase/supabase-js'
import { ApiError } from './response.ts'

type ReadEnv = (name: string) => string | undefined
const authOptions = { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }

export function createSupabaseClients(readEnv: ReadEnv) {
  function required(name: string): string {
    const value = readEnv(name)
    if (!value) throw new ApiError('INTERNAL_ERROR')
    return value
  }
  return {
    createAuthClient: () => {
      const key = required('THEOU_PUBLISHABLE_KEY')
      if (!/^sb_publishable_[A-Za-z0-9_-]+$/.test(key)) throw new ApiError('INTERNAL_ERROR')
      return createClient(required('SUPABASE_URL'), key, {
        auth: authOptions,
      })
    },
    // Client riêng, không gắn Authorization/JWT hoặc session do người dùng cung cấp.
    createAdminClient: () =>
      createClient(required('SUPABASE_URL'), required('SUPABASE_SERVICE_ROLE_KEY'), {
        auth: authOptions,
      }),
  }
}

export function readAllowedOrigins(readEnv: ReadEnv): string[] {
  const values = (readEnv('THEOU_ALLOWED_ORIGINS') ?? 'http://localhost:5173,http://127.0.0.1:5173').split(
    ',',
  )
  return values.map((value) => {
    const origin = value.trim()
    const url = new URL(origin)
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin) {
      throw new ApiError('INTERNAL_ERROR')
    }
    return origin
  })
}
