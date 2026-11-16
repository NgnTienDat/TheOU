export function normalizeEmail(value: string) { return value.trim().toLowerCase() }
export function isOuEmail(value: string) {
  return value.length <= 254 && value.split('@')[0].length <= 64 &&
    /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@ou\.edu\.vn$/i.test(value)
}
export function passwordError(password: string) {
  return [...password].length < 8 || new TextEncoder().encode(password).length > 72
    ? 'Mật khẩu cần ít nhất 8 ký tự và không quá 72 byte.' : ''
}
export function nicknameError(value: string) {
  const length = [...value.trim()].length
  return length < 3 || length > 30 || /[\p{Cc}\p{Cf}]/u.test(value) ||
    /(?:https?:\/\/|www\.|[\p{L}\p{N}-]+\.[a-z]{2,}(?:\b|\/))/iu.test(value)
    ? 'Biệt danh dài 3–30 ký tự, không chứa URL hoặc ký tự điều khiển.' : ''
}
export function fillOtp(current: string[], index: number, text: string) {
  const next = [...current]
  const digits = text.replace(/[^0-9]/g, '').slice(0, 6 - index)
  if (!digits) next[index] = ''
  else [...digits].forEach((digit, offset) => { next[index + offset] = digit })
  return { digits: next, focus: Math.min(5, index + digits.length) }
}
