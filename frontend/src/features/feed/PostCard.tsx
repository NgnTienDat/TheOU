import type { PostPublic } from '../../shared/api/SocialApiClient.ts'
import { postTags } from '../../shared/constants/posts.ts'
import { relativeTime } from '../../shared/lib/time.ts'
import { Link } from 'react-router'
import { Icon } from '../../shared/components/Icon.tsx'
import { useAuth } from '../auth/AuthProvider.tsx'
export function PostCard({ post, detailLink = false }: { post: PostPublic; detailLink?: boolean }) {
  const { notify } = useAuth()
  return <article className={`card post-card${detailLink ? ' post-card-linked' : ''}`} aria-label={`Bài viết ${postTags[post.tag]}`}>
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
    <div className="post-meta"><span className="post-tag">#{postTags[post.tag]}</span>{post.isMine && <span className="owner-pill">Bài của bạn</span>}
    {post.contactUrl && <a className="contact-link" href={post.contactUrl} target="_blank" rel="noopener noreferrer">Liên hệ người đăng <span className="sr-only"> (mở tab mới)</span></a>}</div>
    <footer className="post-stats" aria-label="Số liệu bài viết và liên kết">
      <span className="post-stat" aria-label={`${post.upvoteCount} lượt bình chọn${post.hasUpvoted ? ', bạn đã bình chọn' : ''}; chỉ đọc, chưa hỗ trợ bình chọn`} title="Chỉ đọc — bình chọn chưa được triển khai"><Icon name="heart" /><span>{post.upvoteCount}</span><span className="sr-only"> bình chọn</span></span>
      <span className="post-stat"><Icon name="message" /><span>{post.commentCount}</span><span className="sr-only"> bình luận</span></span>
      <button type="button" className="icon-button post-share" aria-label="Sao chép liên kết bài" title="Sao chép liên kết bài" onClick={async () => {
        try { await navigator.clipboard.writeText(new URL(`/bai-viet/${post.id}`, location.origin).href); notify('Đã sao chép liên kết bài viết.') }
        catch { notify('Không thể sao chép tự động. Mở bài viết và sao chép liên kết trên thanh địa chỉ.') }
      }}><Icon name="share" /></button>
    </footer>
    </div>
  </article>
}
