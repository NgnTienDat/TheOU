import { randomUUID } from 'node:crypto'
import { createRejectionEmail, domainRejectionMessage, ManualAuthError, normalizeOuEmail, parseOtp, parsePassword } from './auth-helpers.ts'
import type { SocialApiIdentity } from './social-api-manual.ts'

type AuthError = { code?: string; status?: number; message?: string } | null
type User = { id: string; email?: string; email_confirmed_at?: string }
type Session = { access_token: string; user: User }
type SessionResponse = { error: AuthError; data: { session: Session | null } }

// Chỉ Auth API công khai; không dùng admin API hoặc đọc bảng nghiệp vụ.
export interface ManualAuthClient {
  signUp(input: { email: string; password: string }): Promise<SessionResponse>
  signInWithPassword(input: { email: string; password: string }): Promise<SessionResponse>
  signInWithOtp(input: { email: string; options: { shouldCreateUser: false } }): Promise<SessionResponse>
  verifyOtp(input: { email: string; token: string; type: 'email' }): Promise<SessionResponse>
  getSession(): Promise<SessionResponse>
  getUser(): Promise<{ error: AuthError; data: { user: User | null } }>
  signOut(input: { scope: 'local' }): Promise<{ error: AuthError }>
}

export const manualAuthModes = ['signup', 'verify-signup', 'login', 'reject', 'passwordless-denied', 'get-me'] as const
export type ManualAuthMode = typeof manualAuthModes[number]

function requireSuccess(error: AuthError, message: string): void {
  if (!error) return
  if (error.status === 429) throw new ManualAuthError('Đã chạm rate limit. Chờ cooldown trên Dashboard trước khi thử lại.')
  if (error.code === 'otp_expired') throw new ManualAuthError('OTP sai hoặc đã hết hạn. Dừng, kiểm tra trạng thái đăng ký và cooldown.')
  if (error.code === 'email_not_confirmed') throw new ManualAuthError('Email chưa được xác minh. Hoàn tất OTP đăng ký trước khi đăng nhập.')
  if (error.code === 'invalid_credentials') throw new ManualAuthError('Email hoặc mật khẩu không đúng; tài khoản OTP cũ có thể chưa có mật khẩu. Không tự đăng ký lại để đổi mật khẩu.')
  if (error.code === 'weak_password') throw new ManualAuthError('Mật khẩu chưa đạt chính sách Auth. Kiểm tra yêu cầu trên Dashboard, không in mật khẩu hoặc response thô.')
  throw new ManualAuthError(message)
}

function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new ManualAuthError(message)
}

async function requireNoSession(auth: ManualAuthClient): Promise<void> {
  const current = await auth.getSession()
  requireSuccess(current.error, 'Không kiểm tra được session.')
  requireCondition(!current.data.session, 'FAIL: thao tác bị từ chối hoặc đăng ký chưa xác minh vẫn có session.')
}

async function requireVerifiedSession(auth: ManualAuthClient, response: SessionResponse, email: string): Promise<Session> {
  requireSuccess(response.error, 'Xác thực thất bại. Kiểm tra cấu hình Auth; không in response thô.')
  requireCondition(response.data.session?.access_token, 'FAIL: Auth không trả session hợp lệ.')
  const current = await auth.getUser()
  requireSuccess(current.error, 'Không xác nhận được người dùng với Auth server.')
  requireCondition(current.data.user && current.data.user.id === response.data.session.user.id
    && current.data.user.email_confirmed_at && normalizeOuEmail(current.data.user.email ?? '') === email,
  'FAIL: session không khớp tài khoản OU đã xác minh.')
  const stored = await auth.getSession()
  requireSuccess(stored.error, 'Không đọc được session trong bộ nhớ.')
  requireCondition(stored.data.session?.user.id === current.data.user.id, 'FAIL: không tìm thấy session sau xác thực.')
  requireCondition(stored.data.session?.access_token === response.data.session.access_token, 'FAIL: session trong bộ nhớ không khớp phiên vừa xác thực.')
  return stored.data.session
}

export async function runManualAuth(
  auth: ManualAuthClient,
  mode: ManualAuthMode,
  askHidden: (prompt: string) => Promise<string>,
  report: (message: string) => void,
  checkGetMe?: (identity: SocialApiIdentity) => Promise<void>,
): Promise<void> {
  let failure: unknown
  let password = ''
  let token = ''
  try {
    requireCondition(mode !== 'get-me' || checkGetMe, 'FAIL: chưa kết nối bộ kiểm tra getMe; chưa gọi API.')
    if (mode === 'passwordless-denied') {
      const email = normalizeOuEmail(await askHidden('Email OU đã tồn tại (ẩn): '))
      await requireNoSession(auth)
      const { error, data } = await auth.signInWithOtp({ email, options: { shouldCreateUser: false } })
      const diagnosticCodes = ['otp_disabled', 'email_provider_disabled', 'signup_disabled', 'user_not_found',
        'validation_failed', 'email_address_invalid', 'email_address_not_authorized', 'otp_expired',
        'over_email_send_rate_limit', 'over_request_rate_limit', 'unexpected_failure', 'request_timeout', 'captcha_failed']
      const code = !error ? 'none' : diagnosticCodes.includes(error.code ?? '') ? error.code : 'unknown_or_missing'
      const httpStatus = error?.status
      const status = typeof httpStatus === 'number' && Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus < 600 ? httpStatus : 'unknown'
      const magicLinkDisabled = error?.code === 'email_provider_disabled' && error.message === 'Login with magic link is disabled'
      const otpDisabled = error?.code === 'otp_disabled' && error.message !== 'Signups not allowed for otp'
      // Chỉ in mã lỗi đã biết và HTTP status, không serialize error/message hoặc response.
      report(`Chẩn đoán Auth: error=${Boolean(error)}; code=${code}; http=${status}; responseSession=${Boolean(data.session)}; magicLinkDisabled=${magicLinkDisabled}.`)
      // Auth MagicLink dùng chung code với Email provider bị tắt: phải phân biệt đúng thông báo.
      requireCondition((otpDisabled || magicLinkDisabled) && error && error.status !== undefined
        && error.status >= 400 && error.status < 500 && error.status !== 429 && !data.session,
      'FAIL: chưa chứng minh passwordless bị tắt. Cần otp_disabled hoặc từ chối riêng Magic Link; tắt toàn bộ Email provider, lỗi mạng/SMTP/rate limit không được tính PASS. Nếu request thành công, email có thể đã được gửi; dừng và kiểm tra Dashboard.')
      await requireNoSession(auth)
      report(`PASS: Auth server từ chối OTP/Magic Link với ${code}; không có session.`)
    } else if (mode === 'reject') {
      const email = createRejectionEmail(await askHidden('Gmail gốc do bạn quản lý (ẩn): '), randomUUID().replaceAll('-', '').slice(0, 20))
      password = parsePassword(await askHidden('Mật khẩu test riêng cho đăng ký Gmail (ẩn): '), 'signup')
      // Bỏ qua validator OU để kiểm tra hook qua signUp công khai, không dùng Admin API.
      const { error, data } = await auth.signUp({ email, password })
      requireCondition(error?.status === 403 && error.message?.includes(domainRejectionMessage) && !data.session,
        'FAIL: chưa chứng minh hook từ chối đăng ký. Dừng và kiểm tra Users; yêu cầu có thể đã gửi email/tạo tài khoản nếu hook chưa bật.')
      await requireNoSession(auth)
      report('PASS: đăng ký Gmail bị hook từ chối domain. Kiểm tra Users trên Dashboard: không có alias +theou-t03- mới.')
    } else {
      const email = normalizeOuEmail(await askHidden('Email OU của bạn (ẩn): '))
      if (mode === 'signup') {
        password = parsePassword(await askHidden('Mật khẩu đăng ký, ít nhất 8 ký tự (ẩn): '), 'signup')
        requireCondition(password === await askHidden('Nhập lại mật khẩu (ẩn): '), 'Hai lần nhập mật khẩu không khớp; chưa gọi đăng ký.')
        const signedUp = await auth.signUp({ email, password })
        requireSuccess(signedUp.error, 'Đăng ký thất bại. Kiểm tra Email/SMTP/Hook và trạng thái tài khoản; không in response thô.')
        requireCondition(!signedUp.data.session, 'FAIL: đăng ký trả session trước OTP. Dừng và kiểm tra Confirm email trên Dashboard.')
        await requireNoSession(auth)
        const unconfirmed = await auth.signInWithPassword({ email, password })
        requireCondition(unconfirmed.error?.code === 'email_not_confirmed' && !unconfirmed.data.session,
          'FAIL: chưa chứng minh tài khoản chưa xác minh bị chặn. Email có thể đã tồn tại; không tự đổi mật khẩu hoặc xóa tài khoản.')
        await requireNoSession(auth)
        report('PASS: đăng ký chưa tạo session; đăng nhập bằng đúng mật khẩu bị email_not_confirmed trước OTP. Kiểm tra Inbox/Spam.')
      }
      if (mode === 'login' || mode === 'get-me') {
        password = parsePassword(await askHidden('Mật khẩu tài khoản OU đã xác minh (ẩn): '), 'login')
        if (mode === 'login') {
          // Sai ngay byte đầu để không trùng mật khẩu thật, kể cả với giới hạn bcrypt.
          const wrongPassword = `${password[0] === 'a' ? 'b' : 'a'}${password.slice(1)}`
          const wrong = await auth.signInWithPassword({ email, password: wrongPassword })
          requireCondition(wrong.error?.code === 'invalid_credentials' && !wrong.data.session,
            'FAIL: mật khẩu sai chưa bị từ chối đúng kiểu; không coi lỗi mạng/rate limit là test đạt.')
          await requireNoSession(auth)
          report('PASS: mật khẩu sai bị từ chối, không có session. Tiếp tục kiểm tra mật khẩu đúng.')
        }
        const session = await requireVerifiedSession(auth, await auth.signInWithPassword({ email, password }), email)
        password = ''
        report('PASS: đăng nhập bằng email/mật khẩu, getUser xác nhận OU đã xác minh; không yêu cầu OTP hoặc gửi email.')
        if (mode === 'get-me' && checkGetMe) {
          await checkGetMe({ userId: session.user.id, email, accessToken: session.access_token })
        }
      } else {
        token = parseOtp(await askHidden('OTP 6 số xác minh đăng ký đã nhận (ẩn): '))
        const wrongToken = `${(Number(token[0]) + 1) % 10}${token.slice(1)}`
        const wrong = await auth.verifyOtp({ email, token: wrongToken, type: 'email' })
        requireCondition(wrong.error?.code === 'otp_expired' && !wrong.data.session,
          'FAIL: OTP sai chưa bị từ chối đúng kiểu; không coi lỗi mạng/cấu hình là test đạt.')
        await requireNoSession(auth)
        report('PASS: OTP sai bị từ chối, không có session. Tiếp tục xác minh mã đúng đã nhập.')
        await requireVerifiedSession(auth, await auth.verifyOtp({ email, token, type: 'email' }), email)
        report('PASS: OTP đăng ký đúng; getUser xác nhận email OU đã xác minh và session hợp lệ.')
      }
    }
  } catch (error) {
    failure = error instanceof ManualAuthError ? error : new ManualAuthError('Test gặp lỗi kết nối hoặc SDK. Dừng, kiểm tra Dashboard; không in lỗi thô.')
  } finally {
    password = ''
    token = ''
    try {
      const signedOut = await auth.signOut({ scope: 'local' })
      requireSuccess(signedOut.error, 'Đăng xuất thất bại.')
      await requireNoSession(auth)
      report('Đã dọn phiên script: getSession=null. Không xóa tài khoản Auth.')
    } catch {
      report('FAIL: chưa xác nhận được cleanup session. Không tiếp tục thử liên tục.')
      failure ??= new ManualAuthError('Đăng xuất/kiểm tra session thất bại.')
    }
  }
  if (failure) throw failure
  report(`PASS: hoàn tất kiểm tra ${mode}.`)
}
