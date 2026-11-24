import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Link, useNavigate } from 'react-router'
import { useQueryClient } from '@tanstack/react-query'
import { useAuth } from '../auth/AuthProvider.tsx'
import { Alert } from '../auth/components.tsx'
import { postTags } from '../../shared/constants/posts.ts'
import { allowsContact, bodyLength, changeDraft, emptyDraft, validateDraft, type PostDraft } from './post-draft.ts'
import { createPostSubmission } from './post-submission.ts'
import { Icon } from '../../shared/components/Icon.tsx'
import { processImage } from './image-processing.ts'

export function CreatePostPage() {
  const { api, scope, controller, state: authState, notify } = useAuth()
  const cache = useQueryClient()
  const navigate = useNavigate()
  const active = useRef(true)
  const leaveWarning = useRef(false)
  const [draft, setDraft] = useState<PostDraft>({ ...emptyDraft })
  const [submitted, setSubmitted] = useState(false)
  const [preparing,setPreparing]=useState(false)
  const [imageError,setImageError]=useState('')
  // Callback này chỉ chạy trong submit bất đồng bộ, constructor không đọc ref.
  // eslint-disable-next-line react-hooks/refs
  const [submission] = useState(() => createPostSubmission(api, () => active.current && controller.getScope() === scope, controller.reject))
  const state = useSyncExternalStore(submission.subscribe, submission.getSnapshot)
  const busy = preparing || state.phase === 'creating' || state.phase === 'uploading' || state.phase === 'publishing' || state.images.some(image=>image.status==='removing')
  const errors = validateDraft(draft)
  const dirty = !!draft.body || !!draft.contactUrl || state.locked || !!state.images.length
  useEffect(() => {
    active.current = true
    return () => { active.current = false; submission.dispose() }
  }, [submission])
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
    <header className="page-header composer-heading"><Link className="icon-button" to="/bang-tin" aria-label="Quay lại bảng tin"><Icon name="back" /></Link><h1>Viết bài</h1><span className="microcopy">Chỉ sinh viên OU</span></header>
    <form className="card composer-card" noValidate aria-busy={busy} onSubmit={async event => {
      event.preventDefault(); setSubmitted(true)
      if(busy) return
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
      notify('Đã đăng bài. Câu chuyện của bạn đã lên bảng tin.'); navigate('/bang-tin', { replace: true })
    }}>
      <Alert message={state.error} />
      <fieldset disabled={busy} className="composer-fields">
        <legend className="sr-only">Nội dung và cách hiển thị bài viết</legend>
        <div className="compose-area"><div className="compose-by"><span className={`post-avatar${draft.displayMode === 'NICKNAME' ? ' nickname' : ''}`} aria-hidden="true"><Icon name={draft.displayMode === 'ANONYMOUS' ? 'anon' : 'user'} /></span><div><strong>{draft.displayMode === 'ANONYMOUS' ? 'OUer ẩn danh' : authState.me?.nickname}</strong><p className="microcopy">Đăng lên cộng đồng TheOU</p></div></div>
        <div className="field"><label htmlFor="post-body" className="sr-only">Câu chuyện của bạn</label><textarea id="post-body" disabled={state.locked} className="input post-textarea" rows={5} placeholder="Có chuyện gì ở OU hôm nay?" value={draft.body} onChange={e => update({ body: e.target.value })} aria-invalid={!!errors.body && submitted} aria-describedby={`body-counter${submitted && errors.body ? ' error-body' : ''}`} autoFocus />
          <div className="textarea-caption"><span>Chỉ chia sẻ thông tin bạn cảm thấy thoải mái.</span><span id="body-counter" className={bodyLength(draft.body) > 1000 ? 'over-limit' : ''}>{bodyLength(draft.body)}/1000</span></div>{showError('body')}</div>
        <section className="image-picker" aria-label="Ảnh đính kèm bản nháp">
          <label className="ghost image-picker-label">Chọn ảnh (tối đa 2)<input className="sr-only" type="file" accept="image/jpeg,image/png,image/webp" multiple disabled={busy||state.attachmentsLocked||state.images.length>=2} onChange={async event=>{
            const files=Array.from(event.target.files??[]);event.target.value='';setImageError('')
            if(preparing||busy||files.length+state.images.length>2) {setImageError('Mỗi bài được đính kèm tối đa hai ảnh.');return}
            setPreparing(true)
            try {for(const file of files) {
              const processed=await processImage(file)
              if(!active.current||controller.getScope()!==scope)return
              const preview=URL.createObjectURL(processed)
              if(!submission.addImage(processed,preview))URL.revokeObjectURL(preview)
            }} catch {if(active.current&&controller.getScope()===scope)setImageError('Không thể xử lý ảnh. Hãy chọn JPG, PNG hoặc WebP tĩnh, tối đa 16 MiB và 40 triệu điểm ảnh.')}
            finally {if(active.current&&controller.getScope()===scope)setPreparing(false)}
          }}/></label>
          <p className="microcopy">JPG, PNG, WebP. Ảnh được xử lý lại và tối đa 2 MiB mỗi ảnh trước khi gửi. Hãy tự kiểm tra thông tin riêng tư trong hình.</p>
          {preparing&&<p role="status">Đang xử lý ảnh…</p>}{imageError&&<p role="alert" className="error visible">{imageError}</p>}
          <div className="draft-images">{state.images.map(image=><div className="draft-image" key={image.position}>
            <img src={image.preview} alt={`Ảnh đã chọn ở vị trí ${image.position}`}/>
            <p role="status">Ảnh {image.position}: {{selected:'Đã chuẩn bị',uploading:'Đang tải lên',finalizing:'Đang xác minh',ready:'Sẵn sàng',removing:'Đang gỡ',error:'Chưa hoàn tất, hãy thử lại hoặc gỡ'}[image.status]}</p>
            <button type="button" className="ghost" disabled={busy||state.attachmentsLocked} onClick={()=>void submission.removeImage(image.position)}>Gỡ ảnh {image.position}</button>
          </div>)}</div>
        </section></div><div className="compose-settings">
        <fieldset disabled={state.locked} className="display-options"><legend className="label">Bạn muốn xuất hiện thế nào?</legend>
          {(['ANONYMOUS', 'NICKNAME'] as const).map(mode => <label className={`display-option${draft.displayMode === mode ? ' selected' : ''}`} key={mode}><input type="radio" name="display-mode" value={mode} checked={draft.displayMode === mode} onChange={() => update({ displayMode: mode })} /><span><strong><Icon name={mode === 'ANONYMOUS' ? 'lock' : 'user'} />{mode === 'ANONYMOUS' ? 'Ẩn danh' : 'Biệt danh'}</strong><small>{mode === 'ANONYMOUS' ? 'Không hiện biệt danh của bạn.' : `Hiện ${authState.me?.nickname} dưới bài viết.`}</small></span></label>)}
        </fieldset>
        <fieldset disabled={state.locked} id="post-tag" className="compose-tags" tabIndex={-1} aria-describedby={submitted && errors.tag ? 'error-tag' : undefined}><legend className="label">Chủ đề</legend>{Object.entries(postTags).map(([value, label]) => <label className="tag-option" key={value}><input type="radio" name="post-tag" value={value} checked={draft.tag === value} onChange={() => update({ tag: value as PostDraft['tag'] })} /><span>{label}</span></label>)}</fieldset>{showError('tag')}
        {allowsContact(draft) && <div className="field"><label className="label" htmlFor="post-contact">Liên kết liên hệ <span className="text-muted">(không bắt buộc)</span></label><input id="post-contact" disabled={state.locked} className="input" type="url" autoComplete="off" placeholder="https://zalo.me/..." value={draft.contactUrl} onChange={e => update({ contactUrl: e.target.value })} aria-invalid={submitted && !!errors.contactUrl} aria-describedby={submitted && errors.contactUrl ? 'error-contactUrl' : undefined} />{showError('contactUrl')}<p className="microcopy">Liên kết này sẽ công khai cùng bài viết.</p></div>}
        </div></fieldset>
      {state.locked && state.phase !== 'success' && <p className="submission-note" role="status">{busy ? state.phase === 'creating' ? 'Đang tạo bản nháp…' : 'Đang hoàn tất đăng bài…' : 'Giữ nguyên nội dung để thử lại an toàn. Không tạo bài mới khi chưa rõ kết quả.'}</p>}
      <div className="composer-actions"><p className="composer-note">Đừng đưa email, MSSV hoặc thông tin riêng tư vào nội dung. Bài viết chỉ hiển thị sau khi đăng thành công.</p><Link className="ghost" to="/bang-tin">Hủy</Link><button className="primary" type="submit" disabled={busy || state.phase === 'success'}><Icon name="send" />{busy ? <><span className="spinner" aria-hidden="true" /> Đang đăng…</> : state.phase === 'failed' ? state.postId ? 'Thử lại hoàn tất đăng bài' : 'Thử lại đăng bài' : 'Đăng bài'}</button></div>
    </form>
  </>
}
