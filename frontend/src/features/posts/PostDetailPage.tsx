import { useCallback, useEffect, useState } from 'react'
import { Link, useLocation, useParams } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { useAuth } from '../auth/AuthProvider.tsx'
import { SocialApiError } from '../../shared/api/social-api.ts'
import { PostCard } from '../feed/PostCard.tsx'
import { CommentList } from '../comments/CommentList.tsx'
import { detailOptions } from '../comments/comment-query.ts'
import { Icon } from '../../shared/components/Icon.tsx'

export function PostDetailPage() {
  const {id=''}=useParams()
  // Remount khi đổi bài để snapshot submit không bị dùng cho post khác.
  return <PostDetail key={id} postId={id}/>
}
function PostDetail({postId}:{postId:string}) {
  const {api,scope,controller}=useAuth()
  const {hash}=useLocation()
  const [missing,setMissing]=useState(false)
  const invalid=!/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(postId)
  const onMissing=useCallback((error:unknown)=>{if(error instanceof SocialApiError&&error.code==='NOT_FOUND')setMissing(true)},[])
  const query=useQuery({...detailOptions(api,scope,postId,()=>controller.getScope()===scope,controller.reject),enabled:!invalid&&!missing})
  useEffect(()=>{if(hash==='#comments-heading'&&query.isSuccess)document.getElementById('comments-heading')?.focus()},[hash,query.isSuccess])
  const notFound=invalid||missing||(query.error instanceof SocialApiError&&query.error.code==='NOT_FOUND')
  return <div className="card post-thread">
    <header className="detail-header"><Link className="icon-button detail-back" to="/bang-tin" aria-label="Quay về bảng tin" title="Quay về bảng tin"><Icon name="back"/></Link><h1>Bài viết</h1></header>
    {notFound?<div className="feed-state" role="alert"><h2>Không tìm thấy bài viết</h2><p>Bài viết không còn hiển thị hoặc bạn không được phép xem.</p></div>:query.isPending?<div className="state-message" role="status" aria-busy="true">Đang tải bài viết…</div>:query.isError?<div className="feed-state" role="alert"><h2>Không tải được bài viết</h2><button type="button" className="ghost" onClick={()=>void query.refetch()}>Thử lại</button></div>:<><PostCard post={query.data}/><CommentList key={`${scope}:${postId}`} postId={postId} commentCount={query.data.commentCount} onMissing={onMissing}/></>}
  </div>
}
