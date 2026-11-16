import { useTask } from './use-task.ts'
import { Navigate, Outlet } from 'react-router'
import { useAuth } from './AuthProvider.tsx'
import { Alert } from './components.tsx'

export function SessionGate({ protectedRoute = false }: { protectedRoute?: boolean }) {
  const { state, controller } = useAuth()
  const task = useTask()
  if (state.phase === 'loading') return <p role="status" className="state-message" aria-busy="true">Đang xác thực phiên và tải hồ sơ…</p>
  if (state.phase === 'blocked' || state.phase === 'error') return <div className="space-y-4">
    <Alert message={state.phase === 'blocked' ? 'Tài khoản không đủ điều kiện truy cập TheOU hoặc đã bị khóa.' : 'Không thể tải phiên hoặc hồ sơ. Kiểm tra kết nối và thử lại.'} />
    <Alert message={task.error} />
    <button className="primary" onClick={controller.retry} disabled={task.busy}>Thử lại</button>
    <button className="logout" onClick={() => void task.run(controller.logout)} disabled={task.busy}>Đăng xuất</button>
  </div>
  if (protectedRoute && state.phase === 'guest') return <Navigate to="/dang-nhap" replace />
  if (!protectedRoute && state.phase === 'ready') return <Navigate to="/" replace />
  return <Outlet />
}
