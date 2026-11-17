import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useAuth } from '../auth/AuthProvider.tsx'
import { Alert } from '../auth/components.tsx'
import { commentBodyError, createCommentSubmission } from './comment-submission.ts'
import { Icon } from '../../shared/components/Icon.tsx'

export function CommentComposer({postId,onSuccess,onMissing}:{postId:string;onSuccess:()=>Promise<void>;onMissing:(error:unknown)=>void}) {
  const {api,controller,scope,notify}=useAuth()
  const active=useRef(true)
  const form=useRef<HTMLFormElement>(null)
  const input=useRef<HTMLTextAreaElement>(null)
  const [body,setBody]=useState(''); const [submitted,setSubmitted]=useState(false)
  // Callback mount chỉ được đọc khi submit chạy, không phải trong constructor.
  // eslint-disable-next-line react-hooks/refs
  const [model]=useState(()=>createCommentSubmission(api,postId,()=>active.current&&controller.getScope()===scope,error=>{controller.reject(error);onMissing(error)}))
  const state=useSyncExternalStore(model.subscribe,model.getSnapshot)
  const pending=useRef(false)
  useEffect(()=>{active.current=true;return()=>{active.current=false}},[])
  useLayoutEffect(()=>{
    const field=input.current
    if(field){field.style.height='auto';field.style.height=`${field.scrollHeight}px`}
  },[body])
  useEffect(()=>{
    const element=form.current
    const app=element?.closest<HTMLElement>('.app')
    if(!element||!app)return
    const measure=()=>app.style.setProperty('--comment-composer-height',`${element.getBoundingClientRect().height}px`)
    const viewport=window.visualViewport
    const fitViewport=()=>{
      const offset=Math.max(0,innerHeight-(viewport?.height??innerHeight)-(viewport?.offsetTop??0))
      element.style.setProperty('--comment-keyboard-offset',`${offset}px`)
      // Ẩn nav khi bàn phím mở để giữ vùng nhập trong VisualViewport nhỏ.
      app.toggleAttribute('data-keyboard',offset>0)
      element.style.setProperty('--comment-viewport-height',`${viewport?.height??innerHeight}px`)
    }
    const observer=new ResizeObserver(measure)
    observer.observe(element);measure();fitViewport()
    viewport?.addEventListener('resize',fitViewport);viewport?.addEventListener('scroll',fitViewport)
    return()=>{observer.disconnect();viewport?.removeEventListener('resize',fitViewport);viewport?.removeEventListener('scroll',fitViewport);app.style.removeProperty('--comment-composer-height');app.removeAttribute('data-keyboard')}
  },[])
  const validation=commentBodyError(body)
  const count=[...body.trim()].length
  const showSend=!!body.trim()||state.locked
  return <form ref={form} className="comment-composer" noValidate aria-busy={state.busy} onSubmit={async event=>{
    event.preventDefault();setSubmitted(true)
    if(pending.current)return
    if(!state.locked&&validation){document.getElementById('comment-body')?.focus();return}
    pending.current=true
    try {
      const comment=await model.submit(body)
      if(!comment||!active.current||controller.getScope()!==scope)return
      setBody('');setSubmitted(false);notify('Đã gửi bình luận.');await onSuccess()
    } finally {pending.current=false}
  }}>
    <label className="sr-only" htmlFor="comment-body">Bình luận của bạn</label>
    <div className="comment-input-row">
      <span className="composer-avatar" aria-hidden="true"><Icon name="anon" /></span>
      <textarea ref={input} id="comment-body" className="comment-textarea" rows={1} value={body} onChange={event=>setBody(event.target.value)} onKeyDown={event=>{
        if((event.ctrlKey||event.metaKey)&&event.key==='Enter'&&!event.nativeEvent.isComposing){event.preventDefault();if(!state.busy&&(state.locked||!validation))event.currentTarget.form?.requestSubmit()}
      }} placeholder="Viết bình luận..." disabled={state.locked||state.busy} aria-invalid={(submitted||count>500)&&!!validation} aria-describedby={`comment-hint${body?' comment-count':''}${(submitted||count>500)&&validation?' comment-body-error':''}`} />
      {showSend&&<button type="submit" className="icon-button comment-send" disabled={state.busy||(!state.locked&&!!validation)} aria-label={state.busy?'Đang gửi bình luận':state.locked?'Thử gửi lại':'Gửi bình luận'} title={state.locked?'Thử gửi lại':'Gửi bình luận (Ctrl/Cmd+Enter)'}>{state.busy?<span className="spinner" aria-hidden="true"/>:<Icon name="send"/>}</button>}
    </div>
    <span id="comment-hint" className="sr-only">Hiển thị ẩn danh hoặc Chủ bài. Enter xuống dòng; Ctrl hoặc Command cùng Enter để gửi.</span>
    {body&&<div className="comment-caption"><span id="comment-count" className={count>500?'over-limit':''}>{count}/500</span></div>}
    {(submitted||count>500)&&validation&&<p className="error visible" id="comment-body-error" role="alert">{validation}</p>}
    <Alert message={state.error}/>
    {state.locked&&!state.busy&&<p className="microcopy">Giữ nguyên nội dung để thử lại an toàn. Đừng gửi lại như một bình luận mới khi chưa rõ kết quả.</p>}
  </form>
}
