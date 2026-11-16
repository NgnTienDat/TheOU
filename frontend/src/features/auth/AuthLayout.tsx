import { useState } from 'react'
import { Outlet, useLocation } from 'react-router'
import { useAuth } from './AuthProvider.tsx'

const titles: Record<string, [string, string]> = {
  '/dang-nhap': ['Chuyện OU, ở đây.', 'Một góc nhỏ để chia sẻ, hỏi han và nghe những câu chuyện chỉ người OU mới hiểu.'],
  '/dang-ky': ['Một lời chào, một cộng đồng.', 'Dùng email trường để tham gia. Không cần tên thật, chỉ cần là chính mình.'],
  '/xac-thuc': ['Kiểm tra hộp thư nhé.', 'Nhập mã được gửi tới ***@ou.edu.vn để hoàn tất đăng ký.'],
  '/ca-nhan': ['Chào mừng, OUer.', 'Một biệt danh nhỏ, nhiều câu chuyện đang chờ bạn.'],
}
export function AuthLayout() {
  const { pathname } = useLocation()
  const { notice, notify } = useAuth()
  const [theme, setTheme] = useState(() => document.documentElement.dataset.theme === 'light' ? 'light' : 'dark')
  const [title, description] = titles[pathname] ?? titles['/dang-nhap']
  function toggleTheme() {
    const next = theme === 'dark' ? 'light' : 'dark'
    document.documentElement.dataset.theme = next; setTheme(next)
    try { localStorage.setItem('theou.theme', next) } catch { /* Theme vẫn hoạt động khi storage bị chặn. */ }
    notify(next === 'dark' ? 'Đã chuyển sang giao diện tối' : 'Đã chuyển sang giao diện sáng')
  }
  return <div className="app">
    <div className="aura aura-one" aria-hidden="true" /><div className="orbit" aria-hidden="true" />
    <header className="site-header">
      <div className="mini-brand" aria-label="TheOU"><svg className="brand-mark" viewBox="0 0 36 36" fill="none" aria-hidden="true"><rect x="3.5" y="3.5" width="29" height="29" rx="11" stroke="currentColor" strokeWidth="2" /><path d="M11 14h11a5 5 0 0 1 0 10h-6l-4 3v-4.6A5 5 0 0 1 11 14Z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" /><circle cx="19" cy="19" r="1.5" fill="currentColor" /></svg><span>theou<span className="text-muted">.</span></span></div>
      <button className="theme-btn" type="button" onClick={toggleTheme} aria-label={theme === 'dark' ? 'Chuyển giao diện sáng' : 'Chuyển giao diện tối'}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20.1 15.8A8.5 8.5 0 0 1 8.2 3.9a8.5 8.5 0 1 0 11.9 11.9Z" /></svg></button>
    </header>
    <main className="screen-wrap">
      <div className="intro">
        <div className="hero-icon" aria-hidden="true"><svg viewBox="0 0 40 40" fill="none"><path d="M8 13.8C8 10.6 10.6 8 13.8 8h12.4c3.2 0 5.8 2.6 5.8 5.8v10.9c0 3.2-2.6 5.8-5.8 5.8H18l-8.3 4v-8a5.8 5.8 0 0 1-1.7-4.1V13.8Z" stroke="currentColor" strokeWidth="2.2" strokeLinejoin="round" /><path d="M14 18h12M14 23h7" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" /></svg></div>
        <div className="eyebrow"><span className="dot" /> Cộng đồng dành cho OUer</div>
        <h1>{title}</h1><p className="lede">{description}</p>
      </div>
      <section className="card" aria-label="Giao diện xác thực TheOU"><Outlet /></section>
      <div className="below-card">{pathname === '/ca-nhan' ? <>Bạn có thể chia sẻ bằng <strong>biệt danh hoặc ẩn danh.</strong></> : pathname === '/xac-thuc' ? <>Mã chỉ để xác minh khi đăng ký. <strong>Đăng nhập không cần OTP.</strong></> : <>Không cần tên thật. <strong>Chỉ cần là một OUer.</strong></>}</div>
    </main>
    <footer className="disclaimer">TheOU là dự án độc lập do sinh viên phát triển, không phải kênh chính thức của Trường Đại học Mở TP.HCM.</footer>
    <div className={`toast${notice ? ' show' : ''}`} role="status" aria-live="polite">{notice}</div>
  </div>
}
