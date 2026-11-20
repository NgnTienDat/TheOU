# TheOU — Frontend

React + Vite + TypeScript, Tailwind CSS, React Router, TanStack Query và Supabase SDK. T01–T08 đã nghiệm thu; UI theo [conventions đã duyệt](../docs/fe-templates/README.md). **UI-V2 COMPLETED — PASS (17/11/2026)** sau visual review và Cloud read-only regression do chủ dự án xác nhận. **T09-A local completed / pending review**: upvote thật đã triển khai local, chưa deploy hoặc gọi Cloud. Xem [báo cáo T09-A](../docs/reports/T09-A-IMPLEMENTATION.md).

## Chạy tại máy

**T11-A local:** PostCard/Detail có Xóa bài viết chỉ cho isMine, xác nhận/pending/lỗi và chỉ cập nhật cache sau ACK. `/admin` nhận POST UUID/link cùng origin hoặc COMMENT UUID và lý do1–500 ký tự; chỉ form của getMe.isAdmin, API vẫn recheck ADMIN. Link ở Cá nhân của admin, giữ social nav ba mục V2. Không preview/report queue/ban/restore hoặc Storage delete. Chạy `npm.cmd run test:ui:moderation` cho mock390/1280 dark/light; toàn bộ mạng ngoài Vite/host giả bị chặn. Xem [T11-A](../docs/reports/T11-A-IMPLEMENTATION.md). Chưa Cloud acceptance hoặc deploy T11; lịch sử các lượt được giữ nguyên.

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
npm run test:ui:votes
```

`npm test` dùng test runner Node, mock Auth/API/session; không kết nối Supabase thật. Build cần cấu hình công khai hợp lệ; CI dùng dữ liệu giả và không deploy.

`npm run test:ui` dùng dev dependency `playwright-core` (đã pin trong lockfile) với Edge có sẵn trên Windows. Hệ khác đặt `THEOU_BROWSER_PATH` tới Chromium/Edge; script không tải browser. Vite riêng trên 127.0.0.1:5188 dùng env giả, mọi Auth/API được mock và host ngoài allowlist bị chặn. Không đọc email/mật khẩu thật. Ảnh kiểm tra nằm trong `node_modules/.cache/theou-ui/`, không commit. Script kiểm tra tương tác, responsive/dark-light và đối chiếu kích thước/tokens với HTML gốc; không thay thế kiểm thử Cloud hoặc screen reader thật.

`test:ui:feed` dùng Vite riêng127.0.0.1:5189 với API/Auth giả, chặn toàn bộ host khác; kiểm tra Feed/Composer, filters/pages/race/cursor/errors/retry/privacy/Auth/theme và chụp22 ảnh React trong `node_modules/.cache/theou-feed-ui/`, thêm16 ảnh HTML V2 để đối chiếu tokens/cột. Không gửi bài thật hoặc đọc credentials Cloud. Bàn phím di động chỉ kiểm tra focus/scroll bằng viewport desktop, chưa thay thiết bị thật.

Bảy route: `/dang-nhap`, `/dang-ky`, `/xac-thuc`, `/ca-nhan`, `/` (Feed), `/bai-viet/moi` (Composer), `/bai-viet/:id` (Detail). Login/OTP thành công vào Feed; guest bị chặn Feed/Composer/Detail; profile/logout giữ nguyên. Phiên do Supabase SDK quản lý; không tự lưu password/OTP/JWT vào storage riêng.

`test:ui:comments` dùng Vite riêng127.0.0.1:5190 với env/API/Auth giả; chặn host ngoài allowlist. Kiểm tra post states, comments OP/privacy, pagination/dedupe/cursor, create replay/snapshot và delete confirm/error/count refresh ở360/390/768/1280px dark/light. Ảnh ở `node_modules/.cache/theou-comments-ui/`, không commit; không chứng minh bàn phím ảo/screen reader/Cloud thật.

`test:ui:e2e` bổ sung luồng React xuyên feature trên Vite127.0.0.1:5194: A tạo bài1/2ảnh, B đọc/upvote/comment, A trả lời OP, refresh counts, NEW/HOT/pages, owner delete và admin POST/COMMENT hide với state giả dùng chung. Ba browser contexts A/B/guest cô lập tại1280/390px dark/light; không Auth/Cloud thật. Đặt `THEOU_BROWSER_PATH` tới **Google Chrome binary đã xác minh** trước khi chạy `npm.cmd run test:ui:e2e`; script yêu cầu biến này và kiểm tra CDP product. Binary mặc định Edge của các scripts cũ không được nhận là Chrome.24ảnh ở `node_modules/.cache/theou-e2e-ui/`; mock audits không chứng minh transaction DB. Xem [T12-B local regression](../docs/reports/T12-B-LOCAL-E2E.md).

Comments chỉ đọc trên post PUBLISHED, một tầng ASC; form1–500 Unicode code points, retry giữ snapshot/key trong bộ nhớ. Xóa chính chủ có confirm; chưa rõ kết quả không giả thành success. Sau write refetch comments/detail/feed counts từ API, không tự cộng/trừ. Query key gắn postId/scope; parent NOT_FOUND chặn tương tác, response trễ bị bỏ. Rời/reload/Auth unmount chưa khôi phục text/key; không persist comment nhạy cảm. T08 đã nghiệm thu API/UI/Cloud; UI-V2 chỉ thay giao diện local, không deploy lại backend. Xem [nghiệm thu T08](../docs/reports/T08-STATUS-REPORT.md).

Feed dùng opaque cursor, limit20, cache tách sort/tag/generation phiên; logout/account change xóa cache và bỏ response trễ. Post Composer T07 giữ key/payload/postId khi retry, chỉ publish success mới về Feed NEW; behavior đó giữ nguyên ở T08. Upvote T09-A đã có local; chưa có media/deletePost/moderation UI. Giới hạn reload/Back–Forward recovery của Composer vẫn theo [T07-A](../docs/reports/T07-A-IMPLEMENTATION.md).

## Tổ chức mã nguồn

T09-A giữ API trong adapter: `setUpvote(postId,desiredState)` gọi action `toggleUpvote`, validate response đúng hai field, không đọc bảng vote từ browser. MutationCache chung chặn pending trùng post/scope; optimistic cập nhật Feed/Detail, rollback chỉ snapshot chưa bị thay/refetch, retry giữ cùng desiredState sau lỗi/timeout. Detail mở trong khi request đang chờ giữ cùng intent. Success refetch dữ liệu; NEW giữ thứ tự, HOT reset từ cursor null sau khi các vote pending trong scope kết thúc. Reload mất intent chưa ACK; không ghi intent/JWT vào storage hoặc hứa last-request-wins giữa nhiều tab.

`test:ui:votes` chạy Vite127.0.0.1:5191 với Auth/API mock, chặn Cloud. Kiểm tra optimistic/double-click, Feed→Detail lúc pending, keyboard/aria, rollback, lost ACK retry, HOT reset và logout/account switch. Chụp20 ảnh360/390/768/1280px dark/light ở `node_modules/.cache/theou-votes-ui/`; không thay kiểm thử thiết bị/Cloud thật.

- `src/app/`: ghép Router và Query provider; tắt retry tự động mặc định, mỗi nghiệp vụ quyết định retry sau.
- `src/features/auth/`: Auth service, session controller/provider, validation, Auth layout và ba trang đăng nhập/đăng ký/OTP.
- `src/features/profile/`: trang cá nhân và đổi nickname.
- `src/features/feed/`: FeedPage/PostCard, useFeed và cấu hình infinite query/dedupe.
- `src/features/posts/`: Composer text, validation/payload canonical và controller create/publish/retry.
- `src/features/posts/PostDetailPage.tsx`, `src/features/comments/`: detail, CommentList/Composer, query và submission controller.
- `src/features/votes/`: useToggleUpvote và mutation dùng chung QueryClient, key scope/post, optimistic snapshots/rollback và giữ desiredState retry.
- `src/shared/api/`: interface/DTO và adapter mười action profile/post/comment/vote; validate envelope/allowlist và lọc lỗi an toàn; gắn JWT phiên vào closure request, không đưa vào component.
- `src/shared/lib/`: kiểm tra env và `getSupabaseClient()` tạo một client khi cần; component UI không import SDK trực tiếp.
- `src/shared/components/AppFrame.tsx`, `Icon.tsx`, `src/shared/constants/posts.ts`: shell social rail/bottom nav, header/theme/footer, SVG dùng chung và mapping tag. AppFrame giữ nhánh Auth T05 khi nhận children từ AuthLayout.
- `tests/`: unit test; được kiểm tra kiểu bởi `tsconfig.node.json`.

Mọi dữ liệu nghiệp vụ phải đi qua Edge Function `social-api`; không dùng `.from(...)` đọc/ghi bảng trong frontend. Cấu hình Supabase nằm tại `../supabase/`; đặc tả nằm tại `../docs/`.

Tài liệu tích hợp: [Tailwind + Vite](https://tailwindcss.com/docs/installation/using-vite), [React Router](https://reactrouter.com/start/declarative/installation), [TanStack Query](https://tanstack.com/query/latest/docs/framework/react/quick-start), [Supabase Client](https://supabase.com/docs/reference/javascript/initializing).
# T10-A — Ảnh private (local)

Composer xử lý JPG/PNG/WebP bằng canvas, tối đa2 ảnh, ≤2MiB/ảnh sau xử lý; input tối đa16MiB/40MP, cạnh≤16384, resize cạnh dài≤2048. API adapter gọi reserve/signed upload/finalize trước publish; không component nào gọi Supabase trực tiếp. Preview, Blob, token và trạng thái retry chỉ trong bộ nhớ. Đổi phiên bỏ callbacks cũ; reload/rời trang chưa recovery pipeline.

Gallery Feed/Detail dùng PublicImage signed URL300giây, placeholder/error/expiry và tải lại tối đa3lần/mount; không public URL fallback hoặc log URL. Timeout upload30giây có thể là unknown commit; retry finalize trước, cùng post/key/blob, không upsert. Sau bắt đầu publish không đổi attachments.

`npm.cmd run test:ui:media` chạy Edge/Playwright với Auth/API/Storage giả, chặn mạng ngoài host local/offline; ảnh tại `node_modules/.cache/theou-media-ui/`. Không gọi Cloud. Chạy cùng các scripts Auth/Feed/Comments/Upvote khi review T10. Bucket/migration/deploy chỉ sau review T10-B; xem [báo cáo](../docs/reports/T10-A-IMPLEMENTATION.md).
