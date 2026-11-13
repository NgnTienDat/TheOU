# TheOU — Frontend

Nền tảng T01: React + Vite + TypeScript, Tailwind CSS, React Router, TanStack Query và Supabase SDK. Chưa triển khai đăng nhập, bảng tin hay bài viết.

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

`npm test` dùng test runner tích hợp của Node.js, chưa cần thêm framework. Test hiện kiểm tra ranh giới cấu hình môi trường, không kết nối Supabase thật. Build cần cấu hình công khai hợp lệ; CI dùng dữ liệu giả và không deploy.

## Tổ chức mã nguồn

- `src/app/`: ghép Router và Query provider; tắt retry tự động mặc định, mỗi nghiệp vụ quyết định retry sau.
- `src/features/{auth,feed,posts,comments,votes,profile,moderation}/`: thư mục giữ chỗ bằng `.gitkeep`, chưa có nghiệp vụ.
- `src/shared/api/SocialApiClient.ts`: interface và DTO theo tài liệu 06; chưa có adapter gọi API.
- `src/shared/lib/`: kiểm tra env và `getSupabaseClient()` tạo một client khi cần; component UI không import SDK trực tiếp.
- `src/shared/components/`, `src/shared/constants/`: chỗ đặt thành phần dùng chung khi có nhu cầu.
- `tests/`: unit test; được kiểm tra kiểu bởi `tsconfig.node.json`.

Mọi dữ liệu nghiệp vụ phải đi qua Edge Function `social-api`; không dùng `.from(...)` đọc/ghi bảng trong frontend. Cấu hình Supabase nằm tại `../supabase/`; đặc tả nằm tại `../docs/`.

Tài liệu tích hợp: [Tailwind + Vite](https://tailwindcss.com/docs/installation/using-vite), [React Router](https://reactrouter.com/start/declarative/installation), [TanStack Query](https://tanstack.com/query/latest/docs/framework/react/quick-start), [Supabase Client](https://supabase.com/docs/reference/javascript/initializing).
