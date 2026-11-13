export function readSupabaseEnv(env: Record<string, string | undefined>) {
  const url = env.VITE_SUPABASE_URL?.trim()
  const publishableKey = env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim()

  if (!url || !publishableKey) {
    throw new Error('Thiếu cấu hình Supabase. Hãy điền hai biến trong frontend/.env.local theo .env.example.')
  }

  let parsedUrl: URL
  try {
    parsedUrl = new URL(url)
  } catch {
    throw new Error('VITE_SUPABASE_URL phải là URL hợp lệ.')
  }

  const isLocal = ['localhost', '127.0.0.1', '[::1]'].includes(parsedUrl.hostname)
  if (
    (parsedUrl.protocol !== 'https:' && !(isLocal && parsedUrl.protocol === 'http:')) ||
    parsedUrl.username || parsedUrl.password || parsedUrl.search || parsedUrl.hash ||
    parsedUrl.pathname !== '/'
  ) {
    throw new Error('URL Supabase phải dùng HTTPS (HTTP chỉ dành cho localhost), không chứa thông tin đăng nhập, đường dẫn hay tham số.')
  }

  if (!/^sb_publishable_[A-Za-z0-9_-]+$/.test(publishableKey)) {
    throw new Error('Frontend chỉ chấp nhận Supabase publishable key (sb_publishable_), không dùng secret hoặc service-role key.')
  }

  // Vite đưa mọi biến VITE_* vào bundle, kể cả biến không được dùng trực tiếp.
  const allowedKeys = ['VITE_SUPABASE_URL', 'VITE_SUPABASE_PUBLISHABLE_KEY']
  if (Object.keys(env).some((key) => key.startsWith('VITE_') && !allowedKeys.includes(key))) {
    throw new Error('Có biến VITE_* ngoài danh sách cho phép. Kiểm tra cấu hình để tránh đưa secrets vào trình duyệt.')
  }

  return { url, publishableKey }
}
