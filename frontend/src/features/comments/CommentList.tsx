import { useEffect, useRef, useState } from 'react'
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '../auth/AuthProvider.tsx'
import { SocialApiError } from '../../shared/api/social-api.ts'
import { relativeTime } from '../../shared/lib/time.ts'
import { commentOptions, commentsKey, refreshComments, uniqueComments } from './comment-query.ts'
import { CommentComposer } from './CommentComposer.tsx'
import { Icon } from '../../shared/components/Icon.tsx'

export function CommentList({postId,onMissing}:{postId:string;onMissing:(error:unknown)=>void}) {
  const {api,scope,controller}=useAuth();const cache=useQueryClient()
  const active=useRef(true);const deleting=useRef(new Set<string>())
  const [busy,setBusy]=useState<string[]>([]);const [error,setError]=useState('')
  useEffect(()=>{active.current=true;return()=>{active.current=false}},[])
  const current=()=>active.current&&controller.getScope()===scope
  const query=useInfiniteQuery(commentOptions(api,scope,postId,()=>controller.getScope()===scope,controller.reject))
  useEffect(()=>{if(query.error instanceof SocialApiError&&query.error.code==='NOT_FOUND')onMissing(query.error)},[query.error,onMissing])
  const comments=uniqueComments(query.data?.pages)
  const cursorError=query.error instanceof SocialApiError&&query.error.code==='VALIDATION_ERROR'
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
  return <section className="comments-section" aria-labelledby="comments-heading">
    <div className="comments-title"><h2 id="comments-heading">Bình luận</h2><button type="button" className="icon-button" aria-label="Làm mới bình luận" title="Làm mới bình luận" disabled={query.isFetching} onClick={()=>void cache.resetQueries({queryKey:commentsKey(scope,postId),exact:true})}><Icon name="refresh"/></button></div>
    <CommentComposer postId={postId} onMissing={onMissing} onSuccess={()=>refreshComments(cache,scope,postId)}/>
    <div className="comments-content">
    {query.isPending?<p className="state-message" role="status">Đang tải bình luận…</p>:query.isError&&!comments.length?<div role="alert" className="comment-error"><p>Không tải được bình luận</p><button type="button" className="ghost" onClick={()=>void cache.resetQueries({queryKey:commentsKey(scope,postId),exact:true})}>Thử lại</button></div>:!comments.length?<p className="state-message">Chưa có bình luận nào</p>:<ol className="comment-list">{comments.map(comment=><li className="comment-card" key={comment.id}>
      <span className="comment-avatar" aria-hidden="true"><Icon name="anon"/></span><div className="comment-content"><div className="comment-byline"><strong className={comment.isOriginalPoster?'op-label':''}>{comment.authorLabel}</strong><time dateTime={comment.createdAt} title={new Date(comment.createdAt).toLocaleString('vi-VN',{timeZone:'Asia/Ho_Chi_Minh'})}>{relativeTime(comment.createdAt)}</time>
        {comment.isMine&&<button type="button" className="icon-button comment-delete" aria-label="Xóa bình luận của bạn" aria-busy={busy.includes(comment.id)} title="Xóa bình luận của bạn" disabled={busy.includes(comment.id)} onClick={()=>void remove(comment.id)}>{busy.includes(comment.id)?<span className="spinner" aria-hidden="true"/>:<Icon name="trash"/>}</button>}</div>
      <p className="comment-body">{comment.body}</p></div>
    </li>)}</ol>}
    {query.isError&&!!comments.length&&<p role="alert" className="comment-error">{cursorError?'Phiên phân trang không còn hợp lệ. Làm mới bình luận để tiếp tục.':'Không tải được bình luận tiếp theo. Hãy thử lại.'}</p>}
    {cursorError?<button className="ghost" type="button" onClick={()=>void cache.resetQueries({queryKey:commentsKey(scope,postId),exact:true})}>Tải lại bình luận</button>:query.hasNextPage&&<button className="ghost comments-more" type="button" disabled={query.isFetching} onClick={()=>{if(!query.isFetching)void query.fetchNextPage({cancelRefetch:false})}}><Icon name="more"/>{query.isFetchingNextPage?'Đang tải thêm…':query.isFetchNextPageError?'Thử tải thêm':'Tải thêm bình luận'}</button>}
    {error&&<p className="form-alert visible" role="alert">{error}</p>}
    </div>
  </section>
}
