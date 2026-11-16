import { Outlet, useLocation } from 'react-router'
import { AppFrame } from '../../shared/components/AppFrame.tsx'

const titles: Record<string, [string, string]> = {
  '/dang-nhap': ['Chuyện OU, ở đây.', 'Một góc nhỏ để chia sẻ, hỏi han và nghe những câu chuyện chỉ người OU mới hiểu.'],
  '/dang-ky': ['Một lời chào, một cộng đồng.', 'Dùng email trường để tham gia. Không cần tên thật, chỉ cần là chính mình.'],
  '/xac-thuc': ['Kiểm tra hộp thư nhé.', 'Nhập mã được gửi tới ***@ou.edu.vn để hoàn tất đăng ký.'],
  '/ca-nhan': ['Chào mừng, OUer.', 'Một biệt danh nhỏ, nhiều câu chuyện đang chờ bạn.'],
}
export function AuthLayout() {
  const { pathname } = useLocation()
  const [title, description] = titles[pathname] ?? titles['/dang-nhap']
  return <AppFrame>
    <main className="screen-wrap">
      <div className="intro">
        <div className="hero-icon" aria-hidden="true"><svg viewBox="0 0 40 40" fill="none"><path d="M8 13.8C8 10.6 10.6 8 13.8 8h12.4c3.2 0 5.8 2.6 5.8 5.8v10.9c0 3.2-2.6 5.8-5.8 5.8H18l-8.3 4v-8a5.8 5.8 0 0 1-1.7-4.1V13.8Z" stroke="currentColor" strokeWidth="2.2" strokeLinejoin="round" /><path d="M14 18h12M14 23h7" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" /></svg></div>
        <div className="eyebrow"><span className="dot" /> Cộng đồng dành cho OUer</div>
        <h1>{title}</h1><p className="lede">{description}</p>
      </div>
      <section className="card" aria-label="Giao diện xác thực TheOU"><Outlet /></section>
      <div className="below-card">{pathname === '/ca-nhan' ? <>Bạn có thể chia sẻ bằng <strong>biệt danh hoặc ẩn danh.</strong></> : pathname === '/xac-thuc' ? <>Mã chỉ để xác minh khi đăng ký. <strong>Đăng nhập không cần OTP.</strong></> : <>Không cần tên thật. <strong>Chỉ cần là một OUer.</strong></>}</div>
    </main>
  </AppFrame>
}
