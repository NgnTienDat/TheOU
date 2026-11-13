import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter, Link, Route, Routes } from 'react-router'

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
        <main className="mx-auto flex min-h-svh max-w-2xl flex-col justify-center gap-4 px-6 py-12">
          <h1 className="text-4xl font-bold text-emerald-800">TheOU</h1>
          <Routes>
            <Route path="/" element={<p>Không gian dành cho cộng đồng OU đang được chuẩn bị.</p>} />
            <Route path="*" element={<p>Không tìm thấy trang. <Link className="underline" to="/">Về trang chủ</Link></p>} />
          </Routes>
          <p className="text-sm text-slate-600">
            TheOU là dự án độc lập do sinh viên phát triển, không phải kênh chính thức của Trường Đại học Mở TP.HCM.
          </p>
        </main>
      </BrowserRouter>
    </QueryClientProvider>
  )
}
