export const domainRejectionMessage = 'TheOU chỉ cho phép đăng ký bằng email @ou.edu.vn.'

const ouEmailPattern = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:[.][a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@ou[.]edu[.]vn$/i

export function isOuEmail(email: string): boolean {
  return email.length <= 254 && email.split('@')[0].length <= 64 && ouEmailPattern.test(email)
}

export class ManualAuthError extends Error {}

export function normalizeOuEmail(value: string): string {
  const email = value.trim().toLowerCase()
  if (!isOuEmail(email)) throw new ManualAuthError('Hãy nhập email hợp lệ thuộc chính xác domain @ou.edu.vn.')
  return email
}

export function parseOtp(value: string): string {
  const token = value.trim()
  if (!/^[0-9]{6}$/.test(token)) throw new ManualAuthError('OTP phải gồm đúng 6 chữ số.')
  return token
}

export function parsePassword(value: string, mode: 'signup' | 'login'): string {
  if (!value || /[\u0000-\u001f\u007f]/.test(value) || Buffer.byteLength(value, 'utf8') > 72) {
    throw new ManualAuthError('Mật khẩu không được rỗng, chứa ký tự điều khiển hoặc vượt 72 byte UTF-8.')
  }
  if (mode === 'signup' && ([...value].length < 8 || !value.trim())) {
    throw new ManualAuthError('Mật khẩu đăng ký cần ít nhất 8 ký tự; hãy dùng mật khẩu riêng cho TheOU.')
  }
  // Không trim hoặc chuẩn hóa mật khẩu: khoảng trắng cũng là một phần của giá trị.
  return value
}

export function createRejectionEmail(value: string, runId: string): string {
  const email = value.trim().toLowerCase()
  if (!/^[a-z0-9][a-z0-9.]{4,28}[a-z0-9]@gmail[.]com$/.test(email) || email.includes('..')) {
    throw new ManualAuthError('Test từ chối cần Gmail gốc do bạn quản lý, username 6–30 ký tự và chưa có +alias.')
  }
  if (!/^[a-f0-9]{20}$/.test(runId)) throw new ManualAuthError('Run ID kiểm thử không hợp lệ.')
  // Alias mới để yêu cầu đi qua hook tạo tài khoản, không dùng lại Gmail có sẵn.
  return email.replace('@gmail.com', `+theou-t03-${runId}@gmail.com`)
}

export function readManualAuthConfig(env: NodeJS.ProcessEnv, linkedRef: string) {
  if (env.THEOU_ALLOW_AUTH_TESTS !== 'theou-dev') {
    throw new ManualAuthError('Chưa xác nhận manual test Cloud: đặt THEOU_ALLOW_AUTH_TESTS=theou-dev sau khi được phê duyệt.')
  }
  const ref = 'puhkisyehspcmgzerutm'
  const url = env.THEOU_AUTH_SUPABASE_URL?.trim()
  const publishableKey = env.THEOU_AUTH_PUBLISHABLE_KEY?.trim()
  if (linkedRef.trim() !== ref || url !== `https://${ref}.supabase.co`) {
    throw new ManualAuthError('Chỉ chạy manual Auth trên URL và CLI linked ref của TheOU-dev đã xác nhận.')
  }
  if (!publishableKey || !/^sb_publishable_[A-Za-z0-9_-]+$/.test(publishableKey)) {
    throw new ManualAuthError('Manual Auth chỉ chấp nhận publishable key, không dùng secret/service-role key.')
  }
  return { url, publishableKey }
}
