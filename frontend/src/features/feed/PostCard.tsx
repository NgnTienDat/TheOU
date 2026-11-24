import type { PostPublic } from '../../shared/api/SocialApiClient.ts'
import { postTags } from '../../shared/constants/posts.ts'
import { relativeTime } from '../../shared/lib/time.ts'
import { Link } from 'react-router'
import { Icon } from '../../shared/components/Icon.tsx'
import { useAuth } from '../auth/AuthProvider.tsx'
import { useToggleUpvote } from '../votes/useToggleUpvote.ts'
import { PostImages } from '../posts/PostImages.tsx'
import { DeletePostButton } from '../posts/DeletePostButton.tsx'
import { useEffect, useId, useRef, useState } from 'react'

function PostMenu({post,detailLink,copy}:{post:PostPublic;detailLink:boolean;copy:()=>Promise<void>}) {
  const [open,setOpen]=useState(false), id=useId(), root=useRef<HTMLDivElement>(null), trigger=useRef<HTMLButtonElement>(null)
  useEffect(()=>{
    if(!open)return
    const outside=(event:PointerEvent)=>{if(!root.current?.contains(event.target as Node))setOpen(false)}
    document.addEventListener('pointerdown',outside)
    root.current?.querySelector<HTMLButtonElement>('[role=menuitem]')?.focus()
    return()=>document.removeEventListener('pointerdown',outside)
  },[open])
  return <div ref={root} className="post-menu" onKeyDown={event=>{
    if(event.key==='Escape'){event.preventDefault();setOpen(false);trigger.current?.focus()}
    if(event.key==='Tab')setOpen(false)
    if(!open||!['ArrowDown','ArrowUp','Home','End'].includes(event.key))return
    event.preventDefault()
    const items=Array.from(root.current?.querySelectorAll<HTMLButtonElement>('[role=menuitem]:not(:disabled)')??[])
    const index=items.indexOf(document.activeElement as HTMLButtonElement)
    items[event.key==='Home'?0:event.key==='End'?items.length-1:(index+(event.key==='ArrowDown'?1:-1)+items.length)%items.length]?.focus()
  }}>
    <button ref={trigger} className="icon-button" type="button" aria-label="Tùy chọn bài viết" aria-haspopup="menu" aria-expanded={open} aria-controls={id} onClick={()=>setOpen(value=>!value)} onKeyDown={event=>{if(event.key==='ArrowDown'){event.preventDefault();setOpen(true)}}}><Icon name="more"/></button>
    <div id={id} role="menu" aria-label="Tùy chọn bài viết" className="post-menu-panel" hidden={!open}>
      <button type="button" role="menuitem" className="post-menu-action" onClick={()=>{void copy();setOpen(false);trigger.current?.focus()}}><Icon name="copy"/>Sao chép liên kết</button>
      {post.isMine&&<DeletePostButton key={post.id} postId={post.id} detailLink={detailLink}/>}
    </div>
  </div>
}
export function PostCard({ post, detailLink = false, readOnly = false }: { post: PostPublic; detailLink?: boolean; readOnly?: boolean }) {
  const { notify } = useAuth()
  const vote = useToggleUpvote(post)
  const hasImages = !readOnly && post.images.length > 0
  async function copy() {
    try { await navigator.clipboard.writeText(new URL(`/bai-viet/${post.id}`, location.origin).href); notify('Đã sao chép liên kết bài viết.') }
    catch { notify('Không thể sao chép tự động. Mở bài viết và sao chép liên kết trên thanh địa chỉ.') }
  }
  const metadata = <div className="post-meta"><span className="post-tag">#{postTags[post.tag]}</span>{!readOnly && post.isMine && <span className="owner-pill">Bài của bạn</span>}
    {!readOnly && post.contactUrl && <a className="contact-link" href={post.contactUrl} target="_blank" rel="noopener noreferrer"><Icon name="link"/>Liên hệ người đăng <span className="sr-only"> (mở tab mới)</span></a>}</div>
  return <article className={`card post-card${detailLink ? ' post-card-linked' : ''}${hasImages ? ' post-card-media' : ''}`} aria-label={`Bài viết ${postTags[post.tag]}`}>
    <div className={`post-avatar${post.displayMode === 'NICKNAME' ? ' nickname' : ''}`} aria-hidden="true">{post.displayMode === 'ANONYMOUS' ? <Icon name="anon" /> : 'OU'}</div>
    <div className="post-content-column">
    <header className="post-header">
      <div className="post-byline"><strong>{post.authorLabel}</strong><span className="post-time"> · <time dateTime={post.publishedAt} title={new Date(post.publishedAt).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}>{relativeTime(post.publishedAt)}</time></span></div>
      {!readOnly && <PostMenu post={post} detailLink={detailLink} copy={copy}/>}
    </header>
    <p className="post-body">{detailLink ? <Link className="post-detail-link" to={`/bai-viet/${post.id}`} aria-label="Mở bài viết và bình luận" draggable={false} onClick={event=>{
      // React Router không được điều hướng khi người đọc vừa kéo chọn nội dung để copy.
      const selection=window.getSelection()
      if(selection&&!selection.isCollapsed&&event.currentTarget.contains(selection.anchorNode))event.preventDefault()
    }}><span className="post-link-text">{post.body}</span></Link> : post.body}</p>
    {!readOnly && <PostImages postId={post.id} images={post.images} detailLink={detailLink}/>}
    {!hasImages && metadata}
    <footer className="post-stats" aria-label="Số liệu bài viết và liên kết">
      {readOnly ? <span className="post-stat"><Icon name="heart" /><span>{post.upvoteCount}</span><span className="sr-only"> bình chọn</span></span> : <button type="button" className="post-stat upvote-button" aria-pressed={vote.hasUpvoted} aria-busy={vote.pending} aria-label={vote.hasUpvoted ? 'Bỏ upvote bài viết' : 'Upvote bài viết'} title={`${vote.upvoteCount} lượt bình chọn`} disabled={vote.pending || !!vote.error} onClick={() => void vote.toggle()}>{vote.pending ? <span className="spinner" aria-hidden="true" /> : <Icon name="heart" />}<span>{vote.upvoteCount}</span><span className="sr-only"> bình chọn</span></button>}
      {readOnly?<span className="post-stat"><Icon name="message"/><span>{post.commentCount}</span><span className="sr-only"> bình luận</span></span>:<Link className="post-stat post-comments-link" to={`/bai-viet/${post.id}#comments-heading`} aria-label={`${post.commentCount} bình luận — mở thảo luận`} onClick={()=>document.getElementById('comments-heading')?.focus()}><Icon name="message"/><span>{post.commentCount}</span><span className="sr-only"> bình luận</span></Link>}
      {!readOnly && <button type="button" className="icon-button post-share" aria-label="Sao chép liên kết bài" title="Sao chép liên kết bài" onClick={()=>void copy()}><Icon name="share" /></button>}
    </footer>
    {hasImages && metadata}
    {!readOnly && vote.error && <div className="vote-error" role="alert"><p>{vote.error} Chưa xác nhận kết quả bình chọn.</p><button type="button" className="ghost" disabled={vote.pending} onClick={() => void vote.retry()}>Thử lại bình chọn</button></div>}
    </div>
  </article>
}
