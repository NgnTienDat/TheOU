import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useAuth } from '../auth/AuthProvider.tsx'
import { useTask } from '../auth/use-task.ts'
import { moderationReasonError, moderationTarget, runContentAction } from './content-action.ts'

export function AdminPage() {
  const { state, api, controller, scope } = useAuth()
  const [type, setType] = useState<'POST' | 'COMMENT'>('POST'), [target, setTarget] = useState(''), [reason, setReason] = useState('')
  const [message, setMessage] = useState(''), [validation, setValidation] = useState('')
  const task = useTask(), cache = useQueryClient(), active = useRef(true)
  useEffect(() => { active.current = true; return () => { active.current = false } }, [])
  if (!state.me?.isAdmin) return <section className="admin-panel"><h1>Không có quyền kiểm duyệt</h1><p>Chỉ quản trị viên được phép mở trang này.</p></section>
  return <section className="admin-panel"><header className="admin-header"><h1>Kiểm duyệt nội dung</h1></header>
    <p>Ẩn nội dung theo ID và lưu lý do vào lịch sử kiểm duyệt. Chưa có chức năng khôi phục.</p>
    <form noValidate aria-busy={task.busy} onSubmit={event => { event.preventDefault(); void task.run(async () => {
      setMessage(''); setValidation('')
      const id = moderationTarget(target, type, location.origin), reasonError = moderationReasonError(reason)
      if (!id || reasonError) { setValidation(!id ? 'Nhập UUID hợp lệ hoặc URL bài viết thuộc TheOU. Bình luận chỉ nhận UUID.' : reasonError); return }
      if (!window.confirm('Ẩn nội dung này? Thao tác sẽ được ghi audit và chưa có chức năng khôi phục.')) return
      await runContentAction(cache, scope, { type, id }, () => api.adminHideContent({ targetType: type, targetId: id, reason: reason.trim() }),
        () => active.current && controller.getScope() === scope, controller.reject, () => { setMessage('Đã ẩn nội dung và ghi lịch sử kiểm duyệt.'); setTarget(''); setReason('') })
    }) }}>
      <label htmlFor="moderation-type">Loại nội dung</label><select id="moderation-type" value={type} disabled={task.busy} onChange={e => setType(e.target.value as typeof type)}><option value="POST">Bài viết</option><option value="COMMENT">Bình luận</option></select>
      <label htmlFor="moderation-target">{type === 'POST' ? 'UUID hoặc URL bài viết' : 'UUID bình luận'}</label><input id="moderation-target" value={target} disabled={task.busy} autoComplete="off" onChange={e => setTarget(e.target.value)} />
      <label htmlFor="moderation-reason">Lý do ẩn nội dung</label><textarea id="moderation-reason" value={reason} disabled={task.busy} rows={4} aria-describedby="moderation-reason-help" onChange={e => setReason(e.target.value)} />
      <p id="moderation-reason-help">1–500 ký tự. Không nhập thông tin nhận dạng không cần thiết.</p>
      {(validation || task.error) && <p role="alert" className="content-action-error">{validation || task.error}</p>}
      {message && <p role="status">{message}</p>}
      <button className="primary" type="submit" disabled={task.busy}>{task.busy ? 'Đang ẩn nội dung…' : 'Ẩn nội dung'}</button>
    </form>
  </section>
}
