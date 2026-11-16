import { isOuEmail } from './validation.ts'

export interface PendingVerification { email: string; sentAt: number; resendAt?: number }
const key = 'theou.pending-signup'
export function readPending(storage: Pick<Storage, 'getItem'>, now = Date.now()): PendingVerification | null {
  try {
    const value = JSON.parse(storage.getItem(key) ?? 'null')
    if (!value || typeof value.email !== 'string' || !isOuEmail(value.email) ||
      !Number.isSafeInteger(value.sentAt) || value.sentAt < 0 || value.sentAt > now ||
      (value.sentAt !== 0 && now - value.sentAt > 86_400_000)) return null
    const resendAt = Number.isSafeInteger(value.resendAt) && value.resendAt <= now + 60_000 ? value.resendAt as number : value.sentAt + 60_000
    return { email: value.email, sentAt: value.sentAt, resendAt }
  } catch { return null }
}
export function savePending(storage: Pick<Storage, 'setItem'>, value: PendingVerification) {
  try { storage.setItem(key, JSON.stringify({ email: value.email, sentAt: value.sentAt, resendAt: value.resendAt ?? value.sentAt + 60_000 })) } catch { /* Email còn trong bộ nhớ nếu storage bị chặn. */ }
}
export function clearPending(storage: Pick<Storage, 'removeItem'>) {
  try { storage.removeItem(key) } catch { /* Storage có thể bị trình duyệt chặn. */ }
}
export function verificationTime(sentAt: number, now: number) {
  return {
    resend: Math.max(0, Math.ceil((sentAt + 60_000 - now) / 1000)),
    expires: Math.max(0, Math.ceil((sentAt + 600_000 - now) / 1000)),
  }
}
