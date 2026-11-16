import type { Session, SupabaseClient } from '@supabase/supabase-js'
import { isOuEmail, normalizeEmail, passwordError } from './validation.ts'

export class AuthUiError extends Error {
  readonly code: string
  constructor(code: string) {
    const messages: Record<string, string> = {
      invalid_credentials: 'Email hoặc mật khẩu không đúng.',
      email_not_confirmed: 'Email chưa được xác minh. Hãy hoàn tất xác minh đăng ký.',
      otp_expired: 'Mã xác minh sai hoặc đã hết hạn. Vui lòng thử lại hoặc gửi mã mới.',
      rate_limit: 'Bạn thao tác quá nhanh. Vui lòng chờ ít nhất 60 giây rồi thử lại.',
      validation: 'Vui lòng kiểm tra email OU, mật khẩu và mã xác minh.',
      unexpected_session: 'Cấu hình xác minh đăng ký chưa phù hợp. Vui lòng thử lại sau.',
    }
    super(messages[code] ?? 'Không thể hoàn tất yêu cầu. Kiểm tra kết nối và thử lại.')
    this.code = code
  }
}
function authError(error: { code?: string; status?: number } | null) {
  if (!error) return
  const code = error.status === 429 || error.code?.includes('rate_limit') ? 'rate_limit' : error.code
  throw new AuthUiError(['invalid_credentials', 'email_not_confirmed', 'otp_expired', 'rate_limit'].includes(code ?? '') ? code! : 'network')
}
export interface AuthIdentity { userId: string; token: string }
function identity(session: Session | null): AuthIdentity | null {
  return session ? { userId: session.user.id, token: session.access_token } : null
}
export function createAuthService(client: SupabaseClient) {
  async function safe<T>(action: () => Promise<T>) {
    try { return await action() }
    catch (error) { throw error instanceof AuthUiError ? error : new AuthUiError('network') }
  }
  function emailInput(value: string) {
    const email = normalizeEmail(value)
    if (!isOuEmail(email)) throw new AuthUiError('validation')
    return email
  }
  async function confirmed(session: Session | null) {
    if (!session) throw new AuthUiError('invalid_credentials')
    const { data, error } = await client.auth.getUser()
    authError(error)
    if (!data.user || data.user.id !== session.user.id || !data.user.email ||
      !isOuEmail(data.user.email) || !data.user.email_confirmed_at) {
      await client.auth.signOut({ scope: 'local' })
      throw new AuthUiError('email_not_confirmed')
    }
  }
  return {
    login: (value: string, password: string) => safe(async () => {
      const email = emailInput(value)
      if (!password) throw new AuthUiError('validation')
      const { data, error } = await client.auth.signInWithPassword({ email, password })
      authError(error)
      await confirmed(data.session)
    }),
    signup: (value: string, password: string, confirm: string) => safe(async () => {
      const email = emailInput(value)
      if (passwordError(password) || confirm !== password) throw new AuthUiError('validation')
      const { data, error } = await client.auth.signUp({ email, password })
      authError(error)
      if (data.session) {
        await client.auth.signOut({ scope: 'local' })
        throw new AuthUiError('unexpected_session')
      }
      // Không dựa vào user/identities để tiết lộ email đã tồn tại hay đăng ký mới.
      return email
    }),
    verify: (value: string, token: string) => safe(async () => {
      const email = emailInput(value)
      if (!/^[0-9]{6}$/.test(token)) throw new AuthUiError('validation')
      const { data, error } = await client.auth.verifyOtp({ email, token, type: 'email' })
      authError(error)
      await confirmed(data.session)
    }),
    resend: (value: string) => safe(async () => {
      const { error } = await client.auth.resend({ type: 'signup', email: emailInput(value) })
      authError(error)
    }),
    restore: () => safe(async () => {
      const { data, error } = await client.auth.getSession()
      authError(error)
      return identity(data.session)
    }),
    subscribe: (listener: (value: AuthIdentity | null) => void) => {
      const { data } = client.auth.onAuthStateChange((_event, session) => { listener(identity(session)) })
      return () => data.subscription.unsubscribe()
    },
    logout: () => safe(async () => {
      const { error } = await client.auth.signOut({ scope: 'local' })
      authError(error)
      const { data, error: sessionError } = await client.auth.getSession()
      authError(sessionError)
      if (data.session) throw new AuthUiError('network')
    }),
  }
}
export type AuthService = ReturnType<typeof createAuthService>
