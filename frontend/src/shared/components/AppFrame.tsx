import { useState, type ReactNode } from 'react'
import { Link, Outlet, useLocation } from 'react-router'
import { useAuth } from '../../features/auth/AuthProvider.tsx'

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
  const brand = <><svg className="brand-mark" viewBox="0 0 36 36" fill="none" aria-hidden="true"><rect x="3.5" y="3.5" width="29" height="29" rx="11" stroke="currentColor" strokeWidth="2" /><path d="M11 14h11a5 5 0 0 1 0 10h-6l-4 3v-4.6A5 5 0 0 1 11 14Z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" /><circle cx="19" cy="19" r="1.5" fill="currentColor" /></svg><span>theou<span className="text-muted">.</span></span></>
  return <div className="app">
    <div className="aura aura-one" aria-hidden="true" /><div className="orbit" aria-hidden="true" />
    <header className="site-header">
      {state.phase === 'ready' ? <Link className="mini-brand" aria-label="TheOU — Bảng tin" to="/">{brand}</Link> : <div className="mini-brand" aria-label="TheOU">{brand}</div>}
      <div className="top-actions">
        {state.phase === 'ready' && <Link className="header-link" to={pathname === '/ca-nhan' ? '/' : '/ca-nhan'}>{pathname === '/ca-nhan' ? 'Bảng tin' : 'Cá nhân'}</Link>}
        <button className="theme-btn" type="button" onClick={toggleTheme} aria-label={theme === 'dark' ? 'Chuyển giao diện sáng' : 'Chuyển giao diện tối'}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20.1 15.8A8.5 8.5 0 0 1 8.2 3.9a8.5 8.5 0 1 0 11.9 11.9Z" /></svg></button>
      </div>
    </header>
    {children ?? <main className="social-wrap"><Outlet /></main>}
    <footer className="disclaimer">TheOU là dự án độc lập do sinh viên phát triển, không phải kênh chính thức của Trường Đại học Mở TP.HCM.</footer>
    <div className={`toast${notice ? ' show' : ''}`} role="status" aria-live="polite">{notice}</div>
  </div>
}
