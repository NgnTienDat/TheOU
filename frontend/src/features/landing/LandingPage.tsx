import { useState, type MouseEvent } from 'react'
import { Link } from 'react-router'
import { useAuth } from '../auth/AuthProvider.tsx'
import { landingPosts } from './landing-demo.ts'
import './landing.css'

export function LandingPage() {
  const { state } = useAuth()
  const [sort, setSort] = useState('new')
  const [tag, setTag] = useState('all')
  const posts = landingPosts(tag, sort)
  function scrollLink(event: MouseEvent<HTMLDivElement>) {
    const link = (event.target as Element).closest<HTMLAnchorElement>('a[href^="#"]')
    if (!link || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
    const target = document.getElementById(link.dataset.scrollTarget ?? link.hash.slice(1))
    if (!target) return
    event.preventDefault()
    target.scrollIntoView({ behavior: 'smooth', block: link.dataset.scrollTarget ? 'start' : 'center' })
  }
  return <><title>TheOU — Landing Page · Đen – trắng</title>
<meta name="description" content="TheOU — Chuyện của OU, người OU cùng bàn. Landing page độc lập với giao diện đen–trắng." />
<div id="landing" className="landing" onClick={scrollLink}>
<header className="site-header">
<nav aria-label="Điều hướng chính" className="container nav">
<a aria-label="TheOU, về đầu trang" className="brand" href="#dau-trang" data-scroll-target="dau-trang"><span className="brand-icon"><span>t</span></span>TheOU</a>
<div className="nav-actions"><Link className="btn btn-primary" to="/bang-tin">Khám phá ngay <span aria-hidden="true">↗</span></Link>{state.phase === 'guest' && <Link className="login-link" to="/dang-nhap">Đăng nhập</Link>}</div>
</nav>
</header>
<main id="dau-trang">
<section aria-labelledby="hero-title" className="container hero">
<div className="hero-copy">
<div className="eyebrow"><span className="dot"></span> GÓC NHỎ DÀNH CHO OUer</div>
<h1 id="hero-title">Chuyện của OU,<br/><em>người OU cùng bàn.</em></h1>
<p className="hero-description">Một nơi dành riêng cho những câu chuyện, câu hỏi và trải nghiệm rất đời thường của cộng đồng OU. Cứ là chính mình, rồi cùng nhau sẻ chia.</p>
<div className="hero-cta">
<a className="btn btn-primary" href="#kham-pha">Khám phá TheOU <span aria-hidden="true">→</span></a>
<a className="btn btn-secondary" href="#ben-trong" data-scroll-target="ben-trong">Xem bên trong <span aria-hidden="true">↘</span></a>
</div>
<div className="hero-note">
<svg aria-hidden="true" fill="none" height="15" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" viewBox="0 0 24 24" width="15"><rect height="11" rx="2" width="14" x="5" y="10"></rect><path d="M8 10V7a4 4 0 0 1 8 0v3"></path></svg>
          Bản thiết kế landing page · Giao diện minh họa, không yêu cầu đăng nhập
        </div>
</div>
<div className="hero-visual" id="kham-pha"><div className="landing-demo-pill">BẢN XEM TRƯỚC</div>
<div className="visual-glow"></div>
<div className="floating-note one"><span className="float-symbol">✎</span> Kể chuyện theo cách của bạn</div>
<div className="floating-note two"><span className="float-symbol">♡</span> Một cộng đồng, nhiều góc nhìn</div>
<div aria-label="Bản minh họa giao diện bảng tin TheOU" className="product-window">
<div className="window-top"><span></span><span></span><span></span><div className="bar"></div></div>
<div className="feed-app">
<div className="feed-heading"><strong>TheOU <span style={{ "color": "var(--brand)" }}>✦</span></strong><span aria-hidden="true" className="round-avatar">☺</span></div>
<div aria-label="Thử chế độ sắp xếp bảng tin minh họa" className="feed-tabs" role="group">
<button aria-pressed={sort === 'new'} className={`feed-tab${sort === 'new' ? ' active' : ''}`} data-sort="new" onClick={() => setSort('new')} type="button">Mới nhất</button>
<button aria-pressed={sort === 'hot'} className={`feed-tab${sort === 'hot' ? ' active' : ''}`} data-sort="hot" onClick={() => setSort('hot')} type="button">Nổi bật 24h</button>
</div>
<div aria-label="Thử bộ lọc chủ đề minh họa" className="tag-row" role="group">
<button aria-pressed={tag === 'all'} className={`tag${tag === 'all' ? ' active' : ''}`} data-tag="all" onClick={() => setTag('all')} type="button">Tất cả</button>
<button aria-pressed={tag === 'confession'} className={`tag${tag === 'confession' ? ' active' : ''}`} data-tag="confession" onClick={() => setTag('confession')} type="button">Confession</button>
<button aria-pressed={tag === 'review'} className={`tag${tag === 'review' ? ' active' : ''}`} data-tag="review" onClick={() => setTag('review')} type="button">Review môn</button>
<button aria-pressed={tag === 'documents'} className={`tag${tag === 'documents' ? ' active' : ''}`} data-tag="documents" onClick={() => setTag('documents')} type="button">Tài liệu</button>
<button aria-pressed={tag === 'housing'} className={`tag${tag === 'housing' ? ' active' : ''}`} data-tag="housing" onClick={() => setTag('housing')} type="button">Tìm trọ</button>
<button aria-pressed={tag === 'urgent'} className={`tag${tag === 'urgent' ? ' active' : ''}`} data-tag="urgent" onClick={() => setTag('urgent')} type="button">Hỏi gấp</button>
</div>
<div aria-live="polite" id="demo-posts">{posts.map(post => <article className="feed-post" key={post.tag}>
<div className="post-meta"><span className="avatar">O</span><strong>OUer ẩn danh</strong><span>{`· ${post.hours} giờ trước`}</span><span className="post-label">{`#${post.label}`}</span></div>
<p className="post-body">{post.body}</p>
<div className="post-actions"><span>{`▲ ${post.votes}`}</span><span>{`♧ ${post.comments} bình luận`}</span></div>
</article>)}</div>
<div className="feed-compose">✎ &#160; Có chuyện gì muốn kể với OU hôm nay?</div>
<p className="demo-note">Giao diện minh họa · Không sử dụng bài viết thật</p>
</div>
</div>
</div>
</section>
<section aria-label="Đặc điểm nổi bật" className="benefits">
<div className="container benefits-inner">
<div className="benefit"><span aria-hidden="true" className="benefit-icon">✦</span> Những câu chuyện gần gũi với OU</div>
<div className="benefit"><span aria-hidden="true" className="benefit-icon">◌</span> Tự chọn đăng ẩn danh hoặc biệt danh</div>
<div className="benefit"><span aria-hidden="true" className="benefit-icon">⌁</span> Cộng đồng dành cho người có email OU</div>
</div>
</section>
<section aria-labelledby="features-title" className="section" id="ben-trong">
<div className="container">
<div className="section-kicker">Một chút về TheOU</div>
<h2 id="features-title">Bên trong TheOU có gì?</h2>
<p className="section-description">Chỉ vài thao tác đơn giản để bạn biết mọi người đang nói gì, đặt câu hỏi hoặc chia sẻ một câu chuyện của mình.</p>
<div className="feature-grid">
<article className="feature-card">
<div className="feature-visual">
<div aria-label="Minh họa bảng tin" className="feature-mini">
<div className="mini-heading">Bảng tin</div>
<span className="mini-pill">Mới nhất</span> <span className="mini-pill" style={{ "background": "#f6f6fa", "color": "#9394a6" }}>Nổi bật 24h</span>
<div className="mini-post"><div className="mini-label">OUer ẩn danh · #HỏiGấp</div><p>Cho mình xin tips vượt qua tuần thi cuối kỳ với 🥲</p><div className="mini-muted">▲ 19 &#160;&#160; ♧ 7 bình luận</div></div>
<div className="mini-post" style={{ "height": "62px", "overflow": "hidden" }}><div className="mini-label">OUer ẩn danh · #ReviewMôn</div><p>Mọi người có kinh nghiệm học nhóm không?</p></div>
</div>
</div>
<div className="feature-copy"><span className="feature-number">01 / KHÁM PHÁ</span><h3>Lướt chuyện OU</h3><p>Đọc các bài mới, bài nổi bật trong 24 giờ và tìm đúng chủ đề bạn quan tâm.</p></div>
</article>
<article className="feature-card">
<div className="feature-visual">
<div aria-label="Minh họa trình soạn bài" className="feature-mini">
<div className="mini-heading">Viết bài mới</div>
<span className="mini-label">Chủ đề</span> <span className="mini-pill">Confession ⌄</span>
<div className="mini-input">Hôm nay bạn muốn chia sẻ điều gì?</div>
<div className="mini-select"><span className="mini-label">Đăng ẩn danh</span><span aria-label="Bật đăng ẩn danh" className="switch"></span></div>
<div className="mini-bottom"><span className="mini-muted">▣ Thêm ảnh</span><span className="mini-publish">Đăng bài →</span></div>
</div>
</div>
<div className="feature-copy"><span className="feature-number">02 / CHIA SẺ</span><h3>Cứ kể theo cách bạn muốn</h3><p>Viết một điều khó nói, hỏi một điều chưa rõ — chọn ẩn danh hoặc hiện biệt danh.</p></div>
</article>
<article className="feature-card">
<div className="feature-visual">
<div aria-label="Minh họa bình luận bài viết" className="feature-mini">
<div className="mini-heading">Bình luận</div>
<div className="mini-post" style={{ "marginTop": "0" }}><div className="mini-label">OUer ẩn danh</div><p style={{ "marginBottom": "0" }}>Mọi người có ai từng gặp chuyện tương tự chưa?</p></div>
<div className="comment-block"><div className="mini-label"><span style={{ "color": "var(--brand)" }}>Chủ bài</span> <span className="mini-muted">· 4 phút</span></div><small>Cảm ơn mọi người đã chia sẻ nha 🫶</small></div>
<div className="comment-block"><div className="mini-label">OUer ẩn danh <span className="mini-muted">· 2 phút</span></div><small>Cố lên bạn ơi, ai cũng từng như vậy á!</small></div>
</div>
</div>
<div className="feature-copy"><span className="feature-number">03 / KẾT NỐI</span><h3>Cùng nhau thảo luận</h3><p>Upvote, bình luận và trò chuyện. Người đăng vẫn có nhãn “Chủ bài” khi phản hồi.</p></div>
</article>
</div>
</div>
</section>
<section aria-label="Tham gia cộng đồng" className="cta-section container">
<div className="cta-panel">
<h2>Có chuyện gì muốn kể với OU?</h2>
<p>Một góc nhỏ dành cho những điều rất OU. Câu chuyện tiếp theo có thể là của bạn.</p>
<a className="btn btn-white" href="#kham-pha">Vào TheOU <span aria-hidden="true">→</span></a>
<div className="cta-small">Bản xem trước giao diện · Khám phá ngay trên landing page</div>
</div>
</section>
</main>
<footer className="site-footer">
<div className="container footer-inner">
<div><a className="brand" href="#dau-trang" data-scroll-target="dau-trang" style={{ "fontSize": "19px" }}><span className="brand-icon" style={{ "width": "27px", "height": "27px", "fontSize": "15px", "borderRadius": "9px" }}><span>t</span></span>TheOU</a><div className="footer-copy" style={{ "marginTop": "10px" }}>TheOU là dự án độc lập do sinh viên phát triển, không phải kênh chính thức của Trường Đại học Mở TP.HCM.</div><div className="footer-copy">© 2026 TheOU. All rights reserved.</div></div>
<div className="footer-links"><a href="#ben-trong" data-scroll-target="ben-trong">Bên trong TheOU</a><a href="#dau-trang" data-scroll-target="dau-trang">Về đầu trang</a></div>
</div>
</footer>
</div></>
}
