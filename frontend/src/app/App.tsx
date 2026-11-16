import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router'
import { AuthProvider } from '../features/auth/AuthProvider.tsx'
import { AuthLayout } from '../features/auth/AuthLayout.tsx'
import { SessionGate } from '../features/auth/AuthRoutes.tsx'
import { CredentialsPage } from '../features/auth/CredentialsPage.tsx'
import { VerificationPage } from '../features/auth/VerificationPage.tsx'
import { ProfilePage } from '../features/profile/ProfilePage.tsx'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: false },
    mutations: { retry: false },
  },
})

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthProvider>
          <Routes>
            <Route element={<AuthLayout />}>
              <Route element={<SessionGate />}>
                <Route path="/dang-nhap" element={<CredentialsPage key="login" />} />
                <Route path="/dang-ky" element={<CredentialsPage key="signup" signup />} />
                <Route path="/xac-thuc" element={<VerificationPage />} />
              </Route>
              <Route element={<SessionGate protectedRoute />}><Route path="/ca-nhan" element={<ProfilePage />} /></Route>
              <Route path="*" element={<Navigate to="/ca-nhan" replace />} />
            </Route>
          </Routes>
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  )
}
