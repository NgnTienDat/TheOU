import { Link } from 'react-router'
import { tagFilters } from '../../shared/constants/posts.ts'
import { SocialApiError } from '../../shared/api/social-api.ts'
import { useFeed } from './useFeed.ts'
import { PostCard } from './PostCard.tsx'
import { Icon } from '../../shared/components/Icon.tsx'

export function FeedPage() {
  const { query, filter, changeFilter, posts, refresh, loadMore } = useFeed()
  const cursorError = query.error instanceof SocialApiError && query.error.code === 'VALIDATION_ERROR'
  return <>
    <header className="page-header feed-header"><div className="brand-word" aria-hidden="true">theou<span>.</span></div><h1 className="sr-only">Bảng tin</h1><button className="icon-button refresh-button" aria-label="Làm mới bảng tin" type="button" disabled={query.isFetching} onClick={() => void refresh()}><Icon name="refresh" /></button></header>
    <div className="feed-heading"><div><div className="intro-mini">CHUYỆN CỦA OU, NGƯỜI OU CÙNG BÀN</div><h2>Hôm nay OU có chuyện gì?</h2><p className="social-lede">Góc nhỏ dành cho những câu chuyện đáng kể.</p></div><Link className="icon-button quick-write" to="/bai-viet/moi" aria-label="Viết bài mới" title="Viết bài mới"><Icon name="pen" /></Link></div>
    <section className="feed-controls" aria-label="Bộ lọc bảng tin">
      <div className="feed-tabs" role="group" aria-label="Sắp xếp bài viết">{(['NEW', 'HOT'] as const).map(sort => <button type="button" key={sort} aria-pressed={filter.sort === sort} onClick={() => changeFilter({ ...filter, sort })}>{sort === 'NEW' ? 'Mới nhất' : 'Nổi bật 24h'}</button>)}</div>
      <div className="tag-filters" role="group" aria-label="Chủ đề bài viết">{tagFilters.map(tag => <button type="button" key={tag.value ?? 'ALL'} aria-pressed={filter.tag === tag.value} onClick={() => changeFilter({ ...filter, tag: tag.value })}>{tag.label}</button>)}</div>
    </section>
    <div className="feed-list" aria-label="Danh sách bài viết" aria-busy={query.isPending}>
      {query.isPending ? <div role="status" aria-label="Đang tải bảng tin" className="feed-skeletons">{[1, 2, 3].map(i => <div className="card skeleton-card" key={i} aria-hidden="true"><div className="skeleton-line short" /><div className="skeleton-line" /><div className="skeleton-line" /><div className="skeleton-line medium" /></div>)}</div>
        : !posts.length && query.isError ? <div className="card feed-state" role="alert"><h2>Không tải được bảng tin</h2><p>{cursorError ? 'Liên kết phân trang không còn hợp lệ. Hãy làm mới bảng tin.' : 'Kiểm tra kết nối và thử lại nhé.'}</p><button className="ghost" type="button" onClick={() => void refresh()}>{cursorError ? 'Làm mới bảng tin' : 'Thử lại'}</button></div>
          : !posts.length ? <div className="card feed-state"><div className="empty-symbol" aria-hidden="true">☁</div><h2>Chưa có bài viết nào. Hãy mở đầu câu chuyện!</h2><p>Một lời chia sẻ nhỏ cũng có thể giúp một OUer khác.</p><Link className="ghost" to="/bai-viet/moi">Viết bài đầu tiên</Link></div>
            : posts.map(post => <PostCard key={post.id} post={post} detailLink />)}
    </div>
    {!!posts.length && <div className="feed-pagination">
      {query.isError && <p role="alert">{cursorError ? 'Phiên phân trang không còn hợp lệ. Làm mới bảng tin để tiếp tục.' : 'Không tải được trang tiếp theo. Bạn có thể thử lại.'}</p>}
      {cursorError ? <button className="ghost" type="button" onClick={() => void refresh()}>Làm mới bảng tin</button> : query.hasNextPage ? <button className="ghost" type="button" disabled={query.isFetching} onClick={loadMore}>{query.isFetchingNextPage ? 'Đang tải thêm…' : query.isError ? 'Thử tải thêm' : 'Tải thêm'}</button> : <p>Bạn đã xem hết những câu chuyện ở đây.</p>}
    </div>}
  </>
}
