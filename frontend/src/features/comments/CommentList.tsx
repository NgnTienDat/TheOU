import { useEffect, useRef, useState } from 'react'
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '../auth/AuthProvider.tsx'
import { SocialApiError } from '../../shared/api/social-api.ts'
import { relativeTime } from '../../shared/lib/time.ts'
import { commentOptions, commentsKey, refreshComments, uniqueComments } from './comment-query.ts'
import { CommentComposer } from './CommentComposer.tsx'
import { Icon } from '../../shared/components/Icon.tsx'

export function CommentList({postId,commentCount,onMissing}:{postId:string;commentCount:number;onMissing:(error:unknown)=>void}) {
  const {api,scope,controller}=useAuth();const cache=useQueryClient()
  const active=useRef(true);const deleting=useRef(new Set<string>());const section=useRef<HTMLElement>(null)
  const [busy,setBusy]=useState<string[]>([]);const [error,setError]=useState('')
  useEffect(()=>{active.current=true;return()=>{active.current=false}},[])
  const current=()=>active.current&&controller.getScope()===scope
  const options=commentOptions(api,scope,postId,()=>controller.getScope()===scope,controller.reject)
  const query=useInfiniteQuery(options)
  useEffect(()=>{if(query.error instanceof SocialApiError&&query.error.code==='NOT_FOUND')onMissing(query.error)},[query.error,onMissing])
  const comments=uniqueComments(query.data?.pages)
  const cursorError=query.error instanceof SocialApiError&&query.error.code==='VALIDATION_ERROR'
  async function reveal(id:string) {
    await refreshComments(cache,scope,postId)
    const seen=new Set<string>()
    while(current()) {
      const data=cache.getQueryData(options.queryKey)
      if(!data)return
      if(uniqueComments(data.pages).some(comment=>comment.id===id)) {
        await new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve())))
        if(current())section.current?.querySelector<HTMLElement>(`[data-comment-id="${id}"]`)?.scrollIntoView({block:'center',behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'})
        return
      }
      const cursor=data.pages.at(-1)?.nextCursor
      if(!cursor||seen.has(cursor))return
      seen.add(cursor)
      const result=await query.fetchNextPage({cancelRefetch:false})
      if(result.isError)return
    }
  }
  async function remove(id:string) {
    if(deleting.current.has(id)||!window.confirm('Xóa bình luận này? Thao tác này không thể hoàn tác.'))return
    deleting.current.add(id);setBusy([...deleting.current]);setError('')
    try {
      await api.deleteComment(id)
      if(!current())return
      await refreshComments(cache,scope,postId)
    }catch(cause){
      if(!current())return
      controller.reject(cause);onMissing(cause)
      setError(cause instanceof SocialApiError?cause.message:'Chưa xác nhận được kết quả xóa. Bạn có thể thử lại; bình luận hiện tại vẫn được giữ.')
    }finally{deleting.current.delete(id);if(current())setBusy([...deleting.current])}
  }
  return <section ref={section} className="comments-section" aria-labelledby="comments-heading">
    <div className="comments-title"><h2 id="comments-heading" tabIndex={-1}>Thảo luận</h2><span>{commentCount} bình luận</span></div>
    <CommentComposer postId={postId} onMissing={onMissing} onSuccess={reveal}/>
    <div className="comments-content">
    {query.isPending?<p className="state-message" role="status">Đang tải bình luận…</p>:query.isError&&!comments.length?<div role="alert" className="comment-error"><p>Không tải được bình luận</p><button type="button" className="ghost" onClick={()=>void cache.resetQueries({queryKey:commentsKey(scope,postId),exact:true})}>Thử lại</button></div>:!comments.length?<p className="state-message">Chưa có bình luận nào</p>:<ol className="comment-list">{comments.map(comment=><li className="comment-card" data-comment-id={comment.id} key={comment.id}>
      <span className="comment-avatar" aria-hidden="true"><Icon name="anon"/></span><div className="comment-content"><div className="comment-byline"><strong className={comment.isOriginalPoster?'op-label':''}>{comment.authorLabel}</strong><time dateTime={comment.createdAt} title={new Date(comment.createdAt).toLocaleString('vi-VN',{timeZone:'Asia/Ho_Chi_Minh'})}>{relativeTime(comment.createdAt)}</time>
        {comment.isMine&&<button type="button" className="icon-button comment-delete" aria-label="Xóa bình luận của bạn" aria-busy={busy.includes(comment.id)} title="Xóa bình luận của bạn" disabled={busy.includes(comment.id)} onClick={()=>void remove(comment.id)}>{busy.includes(comment.id)?<span className="spinner" aria-hidden="true"/>:<Icon name="trash"/>}</button>}</div>
      <p className="comment-body">{comment.body}</p><div className="reply-footer" aria-hidden="true"><Icon name="message"/></div></div>
    </li>)}</ol>}
    {query.isError&&!!comments.length&&<p role="alert" className="comment-error">{cursorError?'Phiên phân trang không còn hợp lệ. Làm mới bình luận để tiếp tục.':'Không tải được bình luận tiếp theo. Hãy thử lại.'}</p>}
    {cursorError?<button className="ghost" type="button" onClick={()=>void cache.resetQueries({queryKey:commentsKey(scope,postId),exact:true})}>Tải lại bình luận</button>:query.hasNextPage&&<button className="ghost comments-more" type="button" disabled={query.isFetching} onClick={()=>{if(!query.isFetching)void query.fetchNextPage({cancelRefetch:false})}}><Icon name="chevron"/>{query.isFetchingNextPage?'Đang tải thêm…':query.isFetchNextPageError?'Thử tải thêm':'Tải thêm bình luận'}</button>}
    {error&&<p className="form-alert visible" role="alert">{error}</p>}
    <footer className="comments-footer"><span>{query.isSuccess&&!query.isFetching&&!query.hasNextPage?'Đã hiển thị hết bình luận.':''}</span><button type="button" className="icon-button" aria-label="Làm mới bình luận" title="Làm mới bình luận" disabled={query.isFetching} onClick={()=>void refreshComments(cache,scope,postId)}><Icon name="refresh"/></button></footer>
    </div>
  </section>
}
