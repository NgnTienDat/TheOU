# TheOU — Frontend

React + Vite + TypeScript, Tailwind CSS, React Router, TanStack Query và Supabase SDK. T05-A có Auth/Profile UI local theo [prototype đã duyệt](../docs/fe-templates/README.md); chưa triển khai bảng tin hoặc bài viết. Chưa nghiệm thu Cloud T05-B.

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
```

`npm test` dùng test runner Node, mock Auth/API/session; không kết nối Supabase thật. Build cần cấu hình công khai hợp lệ; CI dùng dữ liệu giả và không deploy.

`npm run test:ui` dùng dev dependency `playwright-core` (đã pin trong lockfile) với Edge có sẵn trên Windows. Hệ khác đặt `THEOU_BROWSER_PATH` tới Chromium/Edge; script không tải browser. Vite riêng trên 127.0.0.1:5188 dùng env giả, mọi Auth/API được mock và host ngoài allowlist bị chặn. Không đọc email/mật khẩu thật. Ảnh kiểm tra nằm trong `node_modules/.cache/theou-ui/`, không commit. Script kiểm tra tương tác, responsive/dark-light và đối chiếu kích thước/tokens với HTML gốc; không thay thế kiểm thử Cloud hoặc screen reader thật.

Bốn route: `/dang-nhap`, `/dang-ky`, `/xac-thuc`, `/ca-nhan`; `/` tạm chuyển về cá nhân. Để kiểm thử Cloud sau review, cần deploy action updateNickname theo [bàn giao T05-A](../docs/reports/T05-A-IMPLEMENTATION.md). Phiên do Supabase SDK quản lý, email chờ xác minh lưu tạm sessionStorage; không tự lưu password/OTP/JWT vào storage riêng.

## Tổ chức mã nguồn

- `src/app/`: ghép Router và Query provider; tắt retry tự động mặc định, mỗi nghiệp vụ quyết định retry sau.
- `src/features/auth/`: Auth service, session controller/provider, validation, Auth layout và ba trang đăng nhập/đăng ký/OTP.
- `src/features/profile/`: trang cá nhân và đổi nickname; các feature khác vẫn giữ chỗ.
- `src/shared/api/`: interface/DTO và adapter gọi getMe/updateNickname qua Edge; validate envelope/allowlist và lọc lỗi an toàn.
- `src/shared/lib/`: kiểm tra env và `getSupabaseClient()` tạo một client khi cần; component UI không import SDK trực tiếp.
- `src/shared/components/`, `src/shared/constants/`: chỗ đặt thành phần dùng chung khi có nhu cầu.
- `tests/`: unit test; được kiểm tra kiểu bởi `tsconfig.node.json`.

Mọi dữ liệu nghiệp vụ phải đi qua Edge Function `social-api`; không dùng `.from(...)` đọc/ghi bảng trong frontend. Cấu hình Supabase nằm tại `../supabase/`; đặc tả nằm tại `../docs/`.

Tài liệu tích hợp: [Tailwind + Vite](https://tailwindcss.com/docs/installation/using-vite), [React Router](https://reactrouter.com/start/declarative/installation), [TanStack Query](https://tanstack.com/query/latest/docs/framework/react/quick-start), [Supabase Client](https://supabase.com/docs/reference/javascript/initializing).
