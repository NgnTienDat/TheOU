# TheOU — Frontend

React + Vite + TypeScript, Tailwind CSS, React Router, TanStack Query và Supabase SDK. T01–T08 đã nghiệm thu; UI theo [conventions đã duyệt](../docs/fe-templates/README.md). **UI-V2 COMPLETED — PASS (17/11/2026)** sau visual review và Cloud read-only regression do chủ dự án xác nhận. T09 READY / NOT STARTED; lượt chốt chỉ cập nhật tài liệu, không gọi Cloud.

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

**UI-V2 — Post-T08 / Pre-T09:** các route social dùng visual reference [HTML V2](../docs/fe-templates/TheOU-Social-UI-Redesign-V2.html), cột640px, desktop rail và mobile bottom nav. Auth giữ T05; Cá nhân chuyển vào social shell, giữ getMe/updateNickname/logout. Một theme preference `theou.theme`. API/query/submission và DTO không đổi. [UI-V2-A](../docs/reports/UI-V2-A-IMPLEMENTATION.md) ghi kết quả offline; [nghiệm thu cuối](../docs/reports/UI-V2-STATUS-REPORT.md) ghi visual6/6 và Cloud read-only6/6 PASS theo chủ dự án. Không suy ra đã kiểm thử lại Cloud writes hoặc có SQL baseline mới.

```powershell
npm run lint
npm run typecheck
npm test
npm run build
npm run test:ui
npm run test:ui:feed
npm run test:ui:comments
```

`npm test` dùng test runner Node, mock Auth/API/session; không kết nối Supabase thật. Build cần cấu hình công khai hợp lệ; CI dùng dữ liệu giả và không deploy.

`npm run test:ui` dùng dev dependency `playwright-core` (đã pin trong lockfile) với Edge có sẵn trên Windows. Hệ khác đặt `THEOU_BROWSER_PATH` tới Chromium/Edge; script không tải browser. Vite riêng trên 127.0.0.1:5188 dùng env giả, mọi Auth/API được mock và host ngoài allowlist bị chặn. Không đọc email/mật khẩu thật. Ảnh kiểm tra nằm trong `node_modules/.cache/theou-ui/`, không commit. Script kiểm tra tương tác, responsive/dark-light và đối chiếu kích thước/tokens với HTML gốc; không thay thế kiểm thử Cloud hoặc screen reader thật.

`test:ui:feed` dùng Vite riêng127.0.0.1:5189 với API/Auth giả, chặn toàn bộ host khác; kiểm tra Feed/Composer, filters/pages/race/cursor/errors/retry/privacy/Auth/theme và chụp22 ảnh React trong `node_modules/.cache/theou-feed-ui/`, thêm16 ảnh HTML V2 để đối chiếu tokens/cột. Không gửi bài thật hoặc đọc credentials Cloud. Bàn phím di động chỉ kiểm tra focus/scroll bằng viewport desktop, chưa thay thiết bị thật.

Bảy route: `/dang-nhap`, `/dang-ky`, `/xac-thuc`, `/ca-nhan`, `/` (Feed), `/bai-viet/moi` (Composer), `/bai-viet/:id` (Detail). Login/OTP thành công vào Feed; guest bị chặn Feed/Composer/Detail; profile/logout giữ nguyên. Phiên do Supabase SDK quản lý; không tự lưu password/OTP/JWT vào storage riêng.

`test:ui:comments` dùng Vite riêng127.0.0.1:5190 với env/API/Auth giả; chặn host ngoài allowlist. Kiểm tra post states, comments OP/privacy, pagination/dedupe/cursor, create replay/snapshot và delete confirm/error/count refresh ở360/390/768/1280px dark/light. Ảnh ở `node_modules/.cache/theou-comments-ui/`, không commit; không chứng minh bàn phím ảo/screen reader/Cloud thật.

Comments chỉ đọc trên post PUBLISHED, một tầng ASC; form1–500 Unicode code points, retry giữ snapshot/key trong bộ nhớ. Xóa chính chủ có confirm; chưa rõ kết quả không giả thành success. Sau write refetch comments/detail/feed counts từ API, không tự cộng/trừ. Query key gắn postId/scope; parent NOT_FOUND chặn tương tác, response trễ bị bỏ. Rời/reload/Auth unmount chưa khôi phục text/key; không persist comment nhạy cảm. T08 đã nghiệm thu API/UI/Cloud; UI-V2 chỉ thay giao diện local, không deploy lại backend. Xem [nghiệm thu T08](../docs/reports/T08-STATUS-REPORT.md).

Feed dùng opaque cursor, limit20, cache tách sort/tag/generation phiên; logout/account change xóa cache và bỏ response trễ. Post Composer T07 giữ key/payload/postId khi retry, chỉ publish success mới về Feed NEW; behavior đó giữ nguyên ở T08. Chưa có vote/media/deletePost/moderation UI. Giới hạn reload/Back–Forward recovery của Composer vẫn theo [T07-A](../docs/reports/T07-A-IMPLEMENTATION.md).

## Tổ chức mã nguồn

- `src/app/`: ghép Router và Query provider; tắt retry tự động mặc định, mỗi nghiệp vụ quyết định retry sau.
- `src/features/auth/`: Auth service, session controller/provider, validation, Auth layout và ba trang đăng nhập/đăng ký/OTP.
- `src/features/profile/`: trang cá nhân và đổi nickname.
- `src/features/feed/`: FeedPage/PostCard, useFeed và cấu hình infinite query/dedupe.
- `src/features/posts/`: Composer text, validation/payload canonical và controller create/publish/retry.
- `src/features/posts/PostDetailPage.tsx`, `src/features/comments/`: detail, CommentList/Composer, query và submission controller.
- `src/shared/api/`: interface/DTO và adapter chín action profile/post/comment; validate envelope/allowlist và lọc lỗi an toàn; gắn JWT phiên vào closure request, không đưa vào component.
- `src/shared/lib/`: kiểm tra env và `getSupabaseClient()` tạo một client khi cần; component UI không import SDK trực tiếp.
- `src/shared/components/AppFrame.tsx`, `Icon.tsx`, `src/shared/constants/posts.ts`: shell social rail/bottom nav, header/theme/footer, SVG dùng chung và mapping tag. AppFrame giữ nhánh Auth T05 khi nhận children từ AuthLayout.
- `tests/`: unit test; được kiểm tra kiểu bởi `tsconfig.node.json`.

Mọi dữ liệu nghiệp vụ phải đi qua Edge Function `social-api`; không dùng `.from(...)` đọc/ghi bảng trong frontend. Cấu hình Supabase nằm tại `../supabase/`; đặc tả nằm tại `../docs/`.

Tài liệu tích hợp: [Tailwind + Vite](https://tailwindcss.com/docs/installation/using-vite), [React Router](https://reactrouter.com/start/declarative/installation), [TanStack Query](https://tanstack.com/query/latest/docs/framework/react/quick-start), [Supabase Client](https://supabase.com/docs/reference/javascript/initializing).
