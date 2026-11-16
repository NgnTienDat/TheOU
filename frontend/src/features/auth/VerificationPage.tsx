import { useTask } from './use-task.ts'
import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import { useAuth } from './AuthProvider.tsx'
import { Alert, Field, Submit } from './components.tsx'
import { fillOtp, isOuEmail, normalizeEmail } from './validation.ts'
import { verificationTime } from './pending-verification.ts'

export function VerificationPage() {
  const { auth, pending, setPending, notify } = useAuth()
  const [email, setEmail] = useState('')
  const [digits, setDigits] = useState(Array<string>(6).fill(''))
  const [now, setNow] = useState(Date.now)
  const inputs = useRef<(HTMLInputElement | null)[]>([])
  const task = useTask()
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  const time = verificationTime(pending?.sentAt ?? 0, now)
  const cooldown = Math.max(0, Math.ceil(((pending?.resendAt ?? (pending?.sentAt ?? 0) + 60_000) - now) / 1000))
  function enter(index: number, text: string) {
    const next = fillOtp(digits, index, text)
    setDigits(next.digits); inputs.current[next.focus]?.focus(); task.setError('')
  }
  const verify = task.submit(async () => {
    if (!pending) return
    if (!/^[0-9]{6}$/.test(digits.join(''))) { task.setError('Hãy nhập đủ 6 chữ số trong mã xác minh.'); return }
    const token = digits.join('')
    setDigits(Array<string>(6).fill(''))
    await auth.verify(pending.email, token)
    setPending(null); notify('Email đã được xác minh.')
  })
  async function resend() {
    if (!pending || cooldown > 0) return
    const started = Date.now()
    setPending({ ...pending, resendAt: started + 60_000 }); setNow(started)
    await auth.resend(pending.email)
    const sentAt = Date.now()
    setPending({ email: pending.email, sentAt, resendAt: sentAt + 60_000 }); setNow(sentAt)
    setDigits(Array<string>(6).fill('')); notify('Nếu yêu cầu hợp lệ, mã xác minh mới sẽ được gửi đến email trường.')
  }
  return <div className="screen active">
    <Alert message={task.error} />
    {!pending ? <form noValidate onSubmit={task.submit(async () => {
      const normalized = normalizeEmail(email)
      if (!isOuEmail(normalized)) { task.setError('Vui lòng nhập email @ou.edu.vn đã dùng đăng ký.'); return }
      setPending({ email: normalized, sentAt: 0 })
    })}>
      <p className="microcopy mb-4">Nhập email đã dùng đăng ký để tiếp tục. Thao tác này không đăng ký lại tài khoản.</p>
      <Field label="Email trường đã đăng ký" type="email" autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="tenban@ou.edu.vn" required />
      <Submit busy={task.busy}>Tiếp tục xác minh</Submit>
    </form> : <>
      <form noValidate onSubmit={verify} aria-busy={task.busy}>
        <label htmlFor="otp-0">Mã xác minh gồm 6 chữ số</label>
        <div className="otp-grid" role="group" aria-label="Nhập mã xác minh gồm 6 chữ số">
          {digits.map((digit, index) => <input key={index} id={`otp-${index}`} ref={element => { inputs.current[index] = element }} className="otp-box" type="text" inputMode="numeric" autoComplete={index === 0 ? 'one-time-code' : 'off'} maxLength={6} pattern="[0-9]*" aria-label={`Số thứ ${index + 1}`} aria-invalid={!!task.error} disabled={task.busy} value={digit} onFocus={e => e.target.select()} onChange={e => enter(index, e.target.value)} onPaste={e => { e.preventDefault(); enter(index, e.clipboardData.getData('text')) }} onKeyDown={e => {
            if (e.key === 'ArrowLeft' && index > 0) { e.preventDefault(); inputs.current[index - 1]?.focus() }
            if (e.key === 'ArrowRight' && index < 5) { e.preventDefault(); inputs.current[index + 1]?.focus() }
            if (e.key === 'Backspace' && !digit && index > 0) { e.preventDefault(); setDigits(digits.map((value, i) => i === index - 1 ? '' : value)); inputs.current[index - 1]?.focus() }
          }} />)}
        </div>
        <div className="otp-sublabel"><span>Hiệu lực trong 10 phút</span><span className="countdown">{pending.sentAt ? `${String(Math.floor(time.expires / 60)).padStart(2, '0')}:${String(time.expires % 60).padStart(2, '0')}` : 'Chưa yêu cầu mã'}</span></div>
        <Submit busy={task.busy}>Xác minh email</Submit>
      </form>
      <div className="otp-resend">Chưa nhận được mã? <button type="button" className="link-button" disabled={task.busy || cooldown > 0} onClick={() => void task.run(resend)}>{cooldown > 0 ? `Gửi lại sau ${cooldown} giây` : 'Gửi lại mã'}</button></div>
      <div className="form-footer"><button className="link-button" type="button" disabled={task.busy} onClick={() => { setPending(null); setDigits(Array<string>(6).fill('')) }}>Đổi email xác minh</button></div>
    </>}
    <div className="form-footer"><Link className="link-button" to="/dang-nhap">← Quay lại đăng nhập</Link></div>
  </div>
}
