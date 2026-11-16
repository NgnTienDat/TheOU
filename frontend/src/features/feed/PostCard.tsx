import type { PostPublic } from '../../shared/api/SocialApiClient.ts'
import { postTags } from '../../shared/constants/posts.ts'

function relativeTime(timestamp: string, now = Date.now()) {
  const seconds = Math.max(0, Math.floor((now - Date.parse(timestamp)) / 1000))
  if (seconds < 60) return 'Vừa xong'
  if (seconds < 3600) return `${Math.floor(seconds / 60)} phút trước`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} giờ trước`
  return `${Math.floor(seconds / 86400)} ngày trước`
}
export function PostCard({ post }: { post: PostPublic }) {
  return <article className="card post-card" aria-label={`Bài viết ${postTags[post.tag]}`}>
    <header className="post-header">
      <div className="post-avatar" aria-hidden="true">{post.displayMode === 'ANONYMOUS' ? '○' : 'OU'}</div>
      <div className="post-byline"><strong>{post.authorLabel}</strong><div className="post-time"><time dateTime={post.publishedAt} title={new Date(post.publishedAt).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}>{relativeTime(post.publishedAt)}</time>{post.isMine && <span> · Bài của bạn</span>}</div></div>
      <span className="post-tag">{postTags[post.tag]}</span>
    </header>
    <p className="post-body">{post.body}</p>
    {post.contactUrl && <a className="contact-link" href={post.contactUrl} target="_blank" rel="noopener noreferrer">Liên hệ người đăng <span aria-hidden="true">↗</span><span className="sr-only"> (mở tab mới)</span></a>}
    <footer className="post-stats" aria-label="Số liệu bài viết, chỉ đọc"><span aria-label={`${post.upvoteCount} lượt bình chọn${post.hasUpvoted ? ', bạn đã bình chọn' : ''}`}>↑ <span>{post.upvoteCount}</span> bình chọn</span><span>{post.commentCount} bình luận</span></footer>
  </article>
}
