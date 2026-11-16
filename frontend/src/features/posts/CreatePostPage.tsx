import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Link, useNavigate } from 'react-router'
import { useQueryClient } from '@tanstack/react-query'
import { useAuth } from '../auth/AuthProvider.tsx'
import { Alert } from '../auth/components.tsx'
import { postTags } from '../../shared/constants/posts.ts'
import { allowsContact, bodyLength, changeDraft, emptyDraft, validateDraft, type PostDraft } from './post-draft.ts'
import { createPostSubmission } from './post-submission.ts'

export function CreatePostPage() {
  const { api, scope, controller, state: authState, notify } = useAuth()
  const cache = useQueryClient()
  const navigate = useNavigate()
  const active = useRef(true)
  const leaveWarning = useRef(false)
  const [draft, setDraft] = useState<PostDraft>({ ...emptyDraft })
  const [submitted, setSubmitted] = useState(false)
  // Callback này chỉ chạy trong submit bất đồng bộ, constructor không đọc ref.
  // eslint-disable-next-line react-hooks/refs
  const [submission] = useState(() => createPostSubmission(api, () => active.current && controller.getScope() === scope, controller.reject))
  const state = useSyncExternalStore(submission.subscribe, submission.getSnapshot)
  const busy = state.phase === 'creating' || state.phase === 'publishing'
  const errors = validateDraft(draft)
  const dirty = !!draft.body || !!draft.contactUrl || state.locked
  useEffect(() => {
    active.current = true
    return () => { active.current = false }
  }, [])
  useEffect(() => { leaveWarning.current = dirty && state.phase !== 'success' }, [dirty, state.phase])
  useEffect(() => {
    function unload(event: BeforeUnloadEvent) { if (leaveWarning.current) { event.preventDefault(); event.returnValue = '' } }
    function click(event: MouseEvent) {
      if (!leaveWarning.current || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
      const link = (event.target as Element).closest('a[href]') as HTMLAnchorElement | null
      if (!link || link.target === '_blank' || link.hasAttribute('download') || link.origin !== location.origin || link.pathname === location.pathname) return
      if (!window.confirm('Rời trang viết bài? Nội dung chưa gửi hoặc kết quả chưa xác nhận sẽ không được khôi phục khi quay lại.')) { event.preventDefault(); event.stopPropagation() }
    }
    // shortcut: BrowserRouter chưa chặn nút Back/Forward của trình duyệt; dùng data router khi cần khôi phục draft qua điều hướng.
    window.addEventListener('beforeunload', unload); document.addEventListener('click', click, true)
    return () => { window.removeEventListener('beforeunload', unload); document.removeEventListener('click', click, true) }
  }, [])
  function update(patch: Partial<PostDraft>) { setDraft(value => changeDraft(value, patch)) }
  const showError = (field: keyof PostDraft) => submitted && errors[field] ? <p id={`error-${field}`} className="error visible" role="alert">{errors[field]}</p> : null
  return <>
    <div className="composer-heading"><div className="eyebrow"><span className="dot" /> Một câu chuyện mới</div><h1>Hôm nay bạn muốn kể gì?</h1><p className="social-lede">Không cần tên thật. Chỉ cần là một OUer.</p></div>
    <form className="card composer-card" noValidate aria-busy={busy} onSubmit={async event => {
      event.preventDefault(); setSubmitted(true)
      if (!state.locked && Object.keys(errors).length) {
        document.getElementById(errors.body ? 'post-body' : errors.tag ? 'post-tag' : 'post-contact')?.focus(); return
      }
      const post = await submission.submit(draft)
      if (!post || !active.current || controller.getScope() !== scope) return
      leaveWarning.current = false
      await cache.cancelQueries({ queryKey: ['posts', scope] })
      await cache.invalidateQueries({ queryKey: ['posts', scope], refetchType: 'none' })
      cache.removeQueries({ queryKey: ['posts', scope] })
      if (!active.current || controller.getScope() !== scope) return
      notify('Đã đăng bài. Câu chuyện của bạn đã lên bảng tin.'); navigate('/', { replace: true })
    }}>
      <Alert message={state.error} />
      <fieldset disabled={state.locked} className="composer-fields">
        <legend className="sr-only">Nội dung và cách hiển thị bài viết</legend>
        <div className="field"><label htmlFor="post-body" className="label">Câu chuyện của bạn</label><textarea id="post-body" className="input post-textarea" rows={7} placeholder="Có điều gì bạn muốn chia sẻ với người OU?" value={draft.body} onChange={e => update({ body: e.target.value })} aria-invalid={!!errors.body && submitted} aria-describedby={`body-counter${submitted && errors.body ? ' error-body' : ''}`} autoFocus />
          <div className="textarea-caption"><span>Chỉ chia sẻ thông tin bạn cảm thấy thoải mái.</span><span id="body-counter" className={bodyLength(draft.body) > 1000 ? 'over-limit' : ''}>{bodyLength(draft.body)}/1000</span></div>{showError('body')}</div>
        <div className="field"><label className="label" htmlFor="post-tag">Chủ đề</label><select className="input post-select" id="post-tag" value={draft.tag} onChange={e => update({ tag: e.target.value as PostDraft['tag'] })} aria-invalid={!!errors.tag && submitted} aria-describedby={submitted && errors.tag ? 'error-tag' : undefined}>{Object.entries(postTags).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select>{showError('tag')}</div>
        <fieldset className="display-options"><legend className="label">Bạn muốn xuất hiện thế nào?</legend>
          {(['ANONYMOUS', 'NICKNAME'] as const).map(mode => <label className={`display-option${draft.displayMode === mode ? ' selected' : ''}`} key={mode}><input type="radio" name="display-mode" value={mode} checked={draft.displayMode === mode} onChange={() => update({ displayMode: mode })} /><span><strong>{mode === 'ANONYMOUS' ? 'Ẩn danh' : 'Biệt danh'}</strong><small>{mode === 'ANONYMOUS' ? 'Giữ tên ở phía sau câu chuyện' : 'Chia sẻ bằng biệt danh của bạn'}</small></span></label>)}
        </fieldset>
        <p className="author-preview">Hiển thị là <strong>{draft.displayMode === 'ANONYMOUS' ? 'OUer ẩn danh' : authState.me?.nickname}</strong></p>
        {allowsContact(draft) && <div className="field"><label className="label" htmlFor="post-contact">Liên kết liên hệ <span className="text-muted">(không bắt buộc)</span></label><input id="post-contact" className="input" type="url" autoComplete="off" placeholder="https://zalo.me/..." value={draft.contactUrl} onChange={e => update({ contactUrl: e.target.value })} aria-invalid={submitted && !!errors.contactUrl} aria-describedby={submitted && errors.contactUrl ? 'error-contactUrl' : undefined} />{showError('contactUrl')}<p className="microcopy">Liên kết này sẽ công khai cùng bài viết.</p></div>}
      </fieldset>
      {state.locked && state.phase !== 'success' && <p className="submission-note" role="status">{busy ? state.phase === 'creating' ? 'Đang tạo bản nháp…' : 'Đang hoàn tất đăng bài…' : 'Giữ nguyên nội dung để thử lại an toàn. Không tạo bài mới khi chưa rõ kết quả.'}</p>}
      <div className="composer-actions"><Link className="ghost" to="/">Quay lại bảng tin</Link><button className="primary" type="submit" disabled={busy || state.phase === 'success'}>{busy ? <><span className="spinner" aria-hidden="true" /> Đang đăng…</> : state.phase === 'failed' ? state.postId ? 'Thử lại hoàn tất đăng bài' : 'Thử lại đăng bài' : 'Đăng bài'}<span aria-hidden="true">↗</span></button></div>
      <p className="composer-note">Đừng đưa email, MSSV hoặc thông tin riêng tư vào nội dung. Bài viết chỉ hiển thị sau khi đăng thành công.</p>
    </form>
  </>
}
