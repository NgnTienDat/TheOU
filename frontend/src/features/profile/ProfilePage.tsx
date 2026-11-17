import { useTask } from '../auth/use-task.ts'
import { useState } from 'react'
import { useAuth } from '../auth/AuthProvider.tsx'
import { Alert, Field, Submit } from '../auth/components.tsx'
import { nicknameError } from '../auth/validation.ts'

export function ProfilePage() {
  const { state, controller, api, notify, setPending } = useAuth()
  const [editing, setEditing] = useState(false)
  const [nickname, setNickname] = useState('')
  const [submitted, setSubmitted] = useState(false)
  const task = useTask()
  const me = state.me
  if (!me) return null
  const validation = nicknameError(nickname)
  return <><header className="page-header"><h1>Cá nhân</h1></header><section className="card profile-panel" aria-label="Thông tin cá nhân">
    <Alert message={task.error} />
    <div className="profile-top">
      <div className="avatar" aria-hidden="true">OU</div>
      <div className="min-w-0"><div className="profile-name wrap-anywhere">{me.nickname}</div><div className="profile-info">{me.emailMasked}</div><div className="status-pill"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="m5 12 4 4L19 6" /></svg> Email đã xác minh</div></div>
    </div>
    <div className="divider" />
    <div className="profile-row"><span className="section-label">Biệt danh của bạn</span>{!editing && <button className="ghost" type="button" disabled={task.busy} onClick={() => { setEditing(true); setNickname(me.nickname); setSubmitted(false); task.setError('') }}>Chỉnh sửa</button>}</div>
    <div className="read-value wrap-anywhere">{me.nickname}</div>
    <div className="profile-caption">Biệt danh chỉ xuất hiện khi bạn chọn đăng bài công khai bằng biệt danh. Bài ẩn danh vẫn giữ riêng tư.</div>
    {editing && <form className="profile-edit open" noValidate aria-busy={task.busy} onSubmit={task.submit(async () => {
      setSubmitted(true)
      if (validation) return
      try {
        const data = await api.updateNickname(nickname.trim())
        controller.replaceNickname(data.nickname, me)
        setEditing(false); notify('Đã lưu biệt danh.')
      } catch (error) { controller.reject(error); throw error }
    })}>
      <Field label="Biệt danh mới" type="text" autoComplete="off" placeholder="3–30 ký tự" value={nickname} onChange={e => setNickname(e.target.value)} error={submitted ? validation : ''} disabled={task.busy} autoFocus />
      <div className="action-row"><Submit busy={task.busy}>Lưu biệt danh</Submit><button type="button" className="ghost" disabled={task.busy} onClick={() => { setEditing(false); task.setError('') }}>Hủy</button></div>
    </form>}
    <div className="divider" />
    <button type="button" className="logout" disabled={task.busy} onClick={() => void task.run(async () => { setPending(null); await controller.logout(); notify('Đã đăng xuất.') })}>Đăng xuất</button>
  </section></>
}
