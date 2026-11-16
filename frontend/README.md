# TheOU — Frontend

React + Vite + TypeScript, Tailwind CSS, React Router, TanStack Query và Supabase SDK. T05 Auth/Profile UI đã nghiệm thu theo [prototype đã duyệt](../docs/fe-templates/README.md); bốn action post T06 đã nghiệm thu Cloud. T07-A thêm Feed/Composer local, đang chờ review UI và T07-B Cloud E2E; không deploy hoặc ghi Cloud trong lượt này.

## Chạy tại máy

Yêu cầu Node.js >= 22.18; CI dùng Node.js 24. Từ root repository:

```powershell
cd frontend
npm ci
# Chỉ sao chép nếu chưa có .env.local; không ghi đè cấu hình đang dùng.
Copy-Item .env.example .env.local
npm run dev
```

Trước khi chạy dev, điền `VITE_SUPABASE_URL` và `VITE_SUPABASE_PUBLISHABLE_KEY` trong `.env.local`. Chỉ dùng publishable key dạng `sb_publishable_...`; không dùng JWT anon legacy, service-role hoặc secret key. URL phải là HTTPS; HTTP chỉ dành cho localhost. Khởi động lại Vite sau khi sửa env.

Vite đọc `.env.local` tự động. Dev/build dừng với lỗi cấu hình tiếng Việt nếu thiếu biến, sai URL/key hoặc có biến `VITE_*` ngoài danh sách cho phép. Không in giá trị biến. Mọi biến `VITE_*` đều có thể xuất hiện trong trình duyệt: không lưu secret với tiền tố này. `.env.example` chỉ chứa placeholder; `.env.local` không được commit.

## Kiểm tra

```powershell
npm run lint
npm run typecheck
npm test
npm run build
npm run test:ui
npm run test:ui:feed
```

`npm test` dùng test runner Node, mock Auth/API/session; không kết nối Supabase thật. Build cần cấu hình công khai hợp lệ; CI dùng dữ liệu giả và không deploy.

`npm run test:ui` dùng dev dependency `playwright-core` (đã pin trong lockfile) với Edge có sẵn trên Windows. Hệ khác đặt `THEOU_BROWSER_PATH` tới Chromium/Edge; script không tải browser. Vite riêng trên 127.0.0.1:5188 dùng env giả, mọi Auth/API được mock và host ngoài allowlist bị chặn. Không đọc email/mật khẩu thật. Ảnh kiểm tra nằm trong `node_modules/.cache/theou-ui/`, không commit. Script kiểm tra tương tác, responsive/dark-light và đối chiếu kích thước/tokens với HTML gốc; không thay thế kiểm thử Cloud hoặc screen reader thật.

`test:ui:feed` dùng Vite riêng127.0.0.1:5189 với API/Auth giả, chặn toàn bộ host khác; kiểm tra Feed/Composer, filters/pages/race/cursor/errors/retry/privacy/Auth/theme và chụp22 ảnh trong `node_modules/.cache/theou-feed-ui/`. Không gửi bài thật, không đọc env Cloud cho hai browser runners. Bàn phím di động chỉ kiểm tra focus/scroll bằng viewport desktop, chưa thay thiết bị thật.

Sáu route: `/dang-nhap`, `/dang-ky`, `/xac-thuc`, `/ca-nhan`, `/` (Feed), `/bai-viet/moi` (Composer). Login/OTP thành công vào Feed; guest bị chặn Feed/Composer; profile/logout giữ nguyên. Phiên do Supabase SDK quản lý, email chờ xác minh lưu tạm sessionStorage; không tự lưu password/OTP/JWT vào storage riêng.

Feed dùng opaque cursor, limit20, cache tách sort/tag/generation phiên, reset cursor null khi đổi filter/refresh; dedupe id giữ thứ tự server. Logout/account change xóa cache và bỏ response trễ. Composer khóa UUID/payload trong bộ nhớ; create ACK rồi publish, retry không tạo key mới và chỉ publish lại khi đã biết postId. Chỉ publish success mới về Feed NEW; không có detail/comment/vote/media UI. Reload/rời Composer/Auth revalidation làm unmount có thể mất draft và kết quả chưa xác định; không có server-draft recovery, không persist nội dung nhạy cảm. Link nội bộ có confirm và unload có cảnh báo native; Back/Forward SPA chưa chặn. Xem [bàn giao T07-A](../docs/reports/T07-A-IMPLEMENTATION.md) trước Cloud E2E.

## Tổ chức mã nguồn

- `src/app/`: ghép Router và Query provider; tắt retry tự động mặc định, mỗi nghiệp vụ quyết định retry sau.
- `src/features/auth/`: Auth service, session controller/provider, validation, Auth layout và ba trang đăng nhập/đăng ký/OTP.
- `src/features/profile/`: trang cá nhân và đổi nickname.
- `src/features/feed/`: FeedPage/PostCard, useFeed và cấu hình infinite query/dedupe.
- `src/features/posts/`: Composer text, validation/payload canonical và controller create/publish/retry.
- `src/shared/api/`: interface/DTO và adapter sáu action đã triển khai; validate envelope/allowlist và lọc lỗi an toàn; gắn JWT phiên vào closure request, không đưa vào component.
- `src/shared/lib/`: kiểm tra env và `getSupabaseClient()` tạo một client khi cần; component UI không import SDK trực tiếp.
- `src/shared/components/AppFrame.tsx`, `src/shared/constants/posts.ts`: header/theme/footer dùng chung và mapping tag.
- `tests/`: unit test; được kiểm tra kiểu bởi `tsconfig.node.json`.

Mọi dữ liệu nghiệp vụ phải đi qua Edge Function `social-api`; không dùng `.from(...)` đọc/ghi bảng trong frontend. Cấu hình Supabase nằm tại `../supabase/`; đặc tả nằm tại `../docs/`.

Tài liệu tích hợp: [Tailwind + Vite](https://tailwindcss.com/docs/installation/using-vite), [React Router](https://reactrouter.com/start/declarative/installation), [TanStack Query](https://tanstack.com/query/latest/docs/framework/react/quick-start), [Supabase Client](https://supabase.com/docs/reference/javascript/initializing).
