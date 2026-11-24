import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router'
import { AuthProvider } from '../features/auth/AuthProvider.tsx'
import { AuthLayout } from '../features/auth/AuthLayout.tsx'
import { SessionGate } from '../features/auth/AuthRoutes.tsx'
import { CredentialsPage } from '../features/auth/CredentialsPage.tsx'
import { VerificationPage } from '../features/auth/VerificationPage.tsx'
import { ProfilePage } from '../features/profile/ProfilePage.tsx'
import { AppFrame } from '../shared/components/AppFrame.tsx'
import { FeedPage } from '../features/feed/FeedPage.tsx'
import { CreatePostPage } from '../features/posts/CreatePostPage.tsx'
import { PostDetailPage } from '../features/posts/PostDetailPage.tsx'
import { AdminPage } from '../features/moderation/AdminPage.tsx'
import { LandingPage } from '../features/landing/LandingPage.tsx'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: false },
    mutations: { retry: false },
  },
})

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      {/* Auth external-store updates phải nhìn thấy route logout đã commit trước guard redirect. */}
      <BrowserRouter useTransitions={false}>
        <AuthProvider>
          <Routes>
            <Route path="/" element={<LandingPage />} />
            <Route element={<AuthLayout />}>
              <Route element={<SessionGate />}>
                <Route path="/dang-nhap" element={<CredentialsPage key="login" />} />
                <Route path="/dang-ky" element={<CredentialsPage key="signup" signup />} />
                <Route path="/xac-thuc" element={<VerificationPage />} />
              </Route>
            </Route>
            <Route element={<AppFrame />}>
              <Route path="/bang-tin" element={<FeedPage />} />
              <Route element={<SessionGate protectedRoute />}>
                <Route path="/ca-nhan" element={<ProfilePage />} />
                <Route path="/admin" element={<AdminPage />} />
                <Route path="/bai-viet/moi" element={<CreatePostPage />} />
                <Route path="/bai-viet/:id" element={<PostDetailPage />} />
              </Route>
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  )
}
