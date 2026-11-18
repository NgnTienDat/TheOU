import type { PostPublic } from '../../shared/api/SocialApiClient.ts'
import { postTags } from '../../shared/constants/posts.ts'
import { relativeTime } from '../../shared/lib/time.ts'
import { Link } from 'react-router'
import { Icon } from '../../shared/components/Icon.tsx'
import { useAuth } from '../auth/AuthProvider.tsx'
import { useToggleUpvote } from '../votes/useToggleUpvote.ts'
import { PostImages } from '../posts/PostImages.tsx'
export function PostCard({ post, detailLink = false }: { post: PostPublic; detailLink?: boolean }) {
  const { notify } = useAuth()
  const vote = useToggleUpvote(post)
  const hasImages = post.images.length > 0
  const metadata = <div className="post-meta"><span className="post-tag">#{postTags[post.tag]}</span>{post.isMine && <span className="owner-pill">Bài của bạn</span>}
    {post.contactUrl && <a className="contact-link" href={post.contactUrl} target="_blank" rel="noopener noreferrer">Liên hệ người đăng <span className="sr-only"> (mở tab mới)</span></a>}</div>
  return <article className={`card post-card${detailLink ? ' post-card-linked' : ''}${hasImages ? ' post-card-media' : ''}`} aria-label={`Bài viết ${postTags[post.tag]}`}>
    <div className={`post-avatar${post.displayMode === 'NICKNAME' ? ' nickname' : ''}`} aria-hidden="true">{post.displayMode === 'ANONYMOUS' ? <Icon name="anon" /> : 'OU'}</div>
    <div className="post-content-column">
    <header className="post-header">
      <div className="post-byline"><strong>{post.authorLabel}</strong><span className="post-time"> · <time dateTime={post.publishedAt} title={new Date(post.publishedAt).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}>{relativeTime(post.publishedAt)}</time></span></div>
    </header>
    <p className="post-body">{detailLink ? <Link className="post-detail-link" to={`/bai-viet/${post.id}`} aria-label="Mở bài viết và bình luận" draggable={false} onClick={event=>{
      // React Router không được điều hướng khi người đọc vừa kéo chọn nội dung để copy.
      const selection=window.getSelection()
      if(selection&&!selection.isCollapsed&&event.currentTarget.contains(selection.anchorNode))event.preventDefault()
    }}><span className="post-link-text">{post.body}</span></Link> : post.body}</p>
    <PostImages postId={post.id} images={post.images} detailLink={detailLink}/>
    {!hasImages && metadata}
    <footer className="post-stats" aria-label="Số liệu bài viết và liên kết">
      <button type="button" className="post-stat upvote-button" aria-pressed={vote.hasUpvoted} aria-busy={vote.pending} aria-label={vote.hasUpvoted ? 'Bỏ upvote bài viết' : 'Upvote bài viết'} title={`${vote.upvoteCount} lượt bình chọn`} disabled={vote.pending || !!vote.error} onClick={() => void vote.toggle()}>{vote.pending ? <span className="spinner" aria-hidden="true" /> : <Icon name="heart" />}<span>{vote.upvoteCount}</span><span className="sr-only"> bình chọn</span></button>
      <span className="post-stat"><Icon name="message" /><span>{post.commentCount}</span><span className="sr-only"> bình luận</span></span>
      <button type="button" className="icon-button post-share" aria-label="Sao chép liên kết bài" title="Sao chép liên kết bài" onClick={async () => {
        try { await navigator.clipboard.writeText(new URL(`/bai-viet/${post.id}`, location.origin).href); notify('Đã sao chép liên kết bài viết.') }
        catch { notify('Không thể sao chép tự động. Mở bài viết và sao chép liên kết trên thanh địa chỉ.') }
      }}><Icon name="share" /></button>
    </footer>
    {hasImages && metadata}
    {vote.error && <div className="vote-error" role="alert"><p>{vote.error} Chưa xác nhận kết quả bình chọn.</p><button type="button" className="ghost" disabled={vote.pending} onClick={() => void vote.retry()}>Thử lại bình chọn</button></div>}
    </div>
  </article>
}
