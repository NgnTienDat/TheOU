import { useState, type ReactNode } from 'react'
import { Link, Outlet, useLocation } from 'react-router'
import { useAuth } from '../../features/auth/AuthProvider.tsx'
import { Icon } from './Icon.tsx'
import { TheOUBrand } from './TheOUBrand.tsx'

export function AppFrame({ children }: { children?: ReactNode }) {
  const { notice, notify, state } = useAuth()
  const { pathname } = useLocation()
  const [theme, setTheme] = useState(() => document.documentElement.dataset.theme === 'light' ? 'light' : 'dark')
  function toggleTheme() {
    const next = theme === 'dark' ? 'light' : 'dark'
    document.documentElement.dataset.theme = next; setTheme(next)
    try { localStorage.setItem('theou.theme', next) } catch { /* Theme vẫn hoạt động khi storage bị chặn. */ }
    notify(next === 'dark' ? 'Đã chuyển sang giao diện tối' : 'Đã chuyển sang giao diện sáng')
  }
  const brand = <TheOUBrand />
  const isPostDetail = pathname.startsWith('/bai-viet/') && pathname !== '/bai-viet/moi'
  if (!children) return <div className="app social-app">
    <aside className="social-navigation" aria-label="Điều hướng TheOU">
      <Link className="mini-brand rail-logo" aria-label="TheOU — Bảng tin" to="/bang-tin">{brand}</Link>
      <nav className="social-nav" aria-label="Điều hướng chính">
        <Link className="nav-item" aria-label="Bảng tin" title="Bảng tin" aria-current={pathname === '/bang-tin' || (pathname.startsWith('/bai-viet/') && pathname !== '/bai-viet/moi') ? 'page' : undefined} to="/bang-tin"><Icon name="home" /></Link>
        <Link className="nav-item nav-create" aria-label="Viết bài" title="Viết bài" aria-current={pathname === '/bai-viet/moi' ? 'page' : undefined} to={state.phase === 'ready' ? '/bai-viet/moi' : '/dang-nhap'}><Icon name="plus" /></Link>
        {state.phase === 'ready' ? <Link className="nav-item nav-profile" aria-label="Cá nhân" title="Cá nhân" aria-current={pathname === '/ca-nhan' ? 'page' : undefined} to="/ca-nhan"><span className="nav-avatar" aria-hidden="true">OU</span><span className="profile-nav-icon"><Icon name="user" /></span></Link> : <Link className="nav-item" aria-label="Đăng nhập" title="Đăng nhập" to="/dang-nhap"><Icon name="user" /></Link>}
      </nav>
      <button className="icon-button social-theme" type="button" onClick={toggleTheme} aria-label={theme === 'dark' ? 'Chuyển giao diện sáng' : 'Chuyển giao diện tối'} title="Đổi giao diện"><Icon name={theme === 'dark' ? 'sun' : 'moon'} /></button>
    </aside>
    <header className="mobile-header">
      {pathname !== '/bang-tin' ? <Link className="icon-button" to="/bang-tin" aria-label="Về bảng tin"><Icon name="back" /></Link> : <span className="header-spacer" />}
      <Link className="mobile-logo" to="/bang-tin" aria-label="TheOU trang chủ">{brand}</Link><span className="header-spacer" />
    </header>
    <main className="social-wrap"><Outlet /></main>
    <footer className={`disclaimer${pathname === '/bang-tin' ? ' feed-disclaimer' : isPostDetail ? ' detail-disclaimer' : ''}`}>
      {isPostDetail ? 'Bạn tham gia ẩn danh trước cộng đồng; TheOU vẫn áp dụng quy định chung để bảo vệ người tham gia.' : <>TheOU là dự án độc lập do sinh viên phát triển, không phải kênh chính thức của Trường Đại học Mở TP.HCM.{pathname === '/bang-tin' && <> <Link className="about-link" to="/">Về trang giới thiệu</Link></>}</>}
    </footer>
    <div className={`toast${notice ? ' show' : ''}`} role="status" aria-live="polite">{notice}</div>
  </div>
  return <div className="app">
    <div className="aura aura-one" aria-hidden="true" /><div className="orbit" aria-hidden="true" />
    <header className="site-header">
      {state.phase === 'ready' ? <Link className="mini-brand" aria-label="TheOU — Bảng tin" to="/bang-tin">{brand}</Link> : <div className="mini-brand" aria-label="TheOU">{brand}</div>}
      <div className="top-actions">
        {state.phase === 'ready' && <Link className="header-link" to={pathname === '/ca-nhan' ? '/bang-tin' : '/ca-nhan'}>{pathname === '/ca-nhan' ? 'Bảng tin' : 'Cá nhân'}</Link>}
        <button className="theme-btn" type="button" onClick={toggleTheme} aria-label={theme === 'dark' ? 'Chuyển giao diện sáng' : 'Chuyển giao diện tối'}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20.1 15.8A8.5 8.5 0 0 1 8.2 3.9a8.5 8.5 0 1 0 11.9 11.9Z" /></svg></button>
      </div>
    </header>
    {children ?? <main className="social-wrap"><Outlet /></main>}
    <footer className="disclaimer">TheOU là dự án độc lập do sinh viên phát triển, không phải kênh chính thức của Trường Đại học Mở TP.HCM.</footer>
    <div className={`toast${notice ? ' show' : ''}`} role="status" aria-live="polite">{notice}</div>
  </div>
}
