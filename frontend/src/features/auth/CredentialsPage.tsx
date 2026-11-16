import { useTask } from './use-task.ts'
import { useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { useAuth } from './AuthProvider.tsx'
import { Alert, Field, Note, Submit } from './components.tsx'
import { isOuEmail, normalizeEmail, passwordError } from './validation.ts'

export function CredentialsPage({ signup = false }: { signup?: boolean }) {
  const { auth, setPending, notify } = useAuth()
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [submitted, setSubmitted] = useState(false)
  const task = useTask()
  const emailError = isOuEmail(normalizeEmail(email)) ? '' : 'Vui lòng nhập email thuộc tên miền @ou.edu.vn.'
  const passError = signup ? passwordError(password) : password ? '' : 'Vui lòng nhập mật khẩu.'
  const confirmError = confirm === password ? '' : 'Hai mật khẩu chưa khớp nhau.'
  async function handleSubmit() {
    setSubmitted(true)
    if (emailError || passError || (signup && confirmError)) return
    if (signup) {
      const pendingEmail = await auth.signup(email, password, confirm)
      setPending({ email: pendingEmail, sentAt: Date.now() })
      setPassword(''); setConfirm('')
      notify('Nếu đăng ký hợp lệ, mã xác minh sẽ được gửi đến email trường.'); navigate('/xac-thuc')
    } else {
      await auth.login(email, password)
      setPassword('')
    }
  }
  return <div className="screen active">
    <form noValidate onSubmit={event => { event.preventDefault(); void task.run(handleSubmit) }} aria-busy={task.busy}>
      <Alert message={task.error} />
      <Field label="Email trường" name="email" type="email" inputMode="email" autoComplete={signup ? 'email' : 'username'} placeholder="tenban@ou.edu.vn" required value={email} onChange={e => setEmail(e.target.value)} disabled={task.busy} error={submitted ? emailError : ''} />
      <Field label={signup ? 'Tạo mật khẩu' : 'Mật khẩu'} name="password" type="password" autoComplete={signup ? 'new-password' : 'current-password'} placeholder={signup ? 'Ít nhất 8 ký tự' : 'Nhập mật khẩu của bạn'} required value={password} onChange={e => setPassword(e.target.value)} disabled={task.busy} error={submitted ? passError : ''} hint={signup ? 'Mật khẩu cần có ít nhất 8 ký tự.' : undefined} />
      {signup && <Field label="Nhập lại mật khẩu" type="password" autoComplete="new-password" placeholder="Nhập lại mật khẩu vừa tạo" required value={confirm} onChange={e => setConfirm(e.target.value)} disabled={task.busy} error={submitted ? confirmError : ''} />}
      <Submit busy={task.busy}>{signup ? 'Tạo tài khoản' : 'Đăng nhập'}</Submit>
    </form>
    <div className="form-footer">{signup ? 'Đã có tài khoản?' : 'Chưa có tài khoản?'} <Link className="link-button" to={signup ? '/dang-nhap' : '/dang-ky'}>{signup ? 'Đăng nhập' : 'Đăng ký ngay'}</Link></div>
    {!signup && <div className="divider" />}
    <Note>{signup ? 'Email của bạn chỉ được dùng để xác thực quyền tham gia, không hiển thị với cộng đồng.' : <>Chỉ dành cho tài khoản <strong>@ou.edu.vn</strong>. Bạn không cần công khai tên thật khi tham gia.</>}</Note>
    {!signup && task.error.includes('chưa được xác minh') && <div className="form-footer"><button type="button" className="link-button" onClick={() => { setPending({ email: normalizeEmail(email), sentAt: 0 }); setPassword(''); navigate('/xac-thuc') }}>Tiếp tục xác minh email</button></div>}
  </div>
}
