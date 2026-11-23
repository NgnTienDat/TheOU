# Public read-only feed — Phase A local

**Ngày: 23/11/2026. Trạng thái: LOCAL IMPLEMENTED / PENDING OWNER REVIEW. Phase B NOT STARTED.** Phạm vi mở rộng US-03/Feed theo yêu cầu owner, giữ các nghiệp vụ Auth/posts/comments/votes/media/moderation hiện tại. Không đánh dấu guest access Cloud PASS hoặc thay nghiệm thu T11/T12 trước đây.

## 1. Quyết định phạm vi và dữ liệu

Đã đối chiếu AGENTS, README, docs01–07, UI conventions/prototype, routing/Auth/query/adapters, social-api/Auth guard và các suites liên quan. Source ban đầu đã có `/` → FeedPage và `/bang-tin` → `/`; không tìm thấy LandingPage cần xóa. Lỗi cần giải quyết là FeedPage gọi API cần session cả khi guest.

Chọn function riêng `public-feed`, tái sử dụng query/cursor/DTO envelope hiện có. **Không cần migration** trong phạm vi này: allowlist server `THEOU_PUBLIC_FEED_POST_IDS` mặc định rỗng, tối đa 100 ID khác nhau, chỉ bài còn `PUBLISHED` và `ANONYMOUS`. Không tự public toàn bộ bài hiện tại hoặc bài mới. Không sửa grants/RLS, bảng, migrations hoặc service-role policy. Nếu cần consent/public-private per-row bền vững hoặc scope lớn hơn, cần đề xuất migration và owner approval riêng trước khi viết tiếp.

## 2. Luồng guest và member

| Người dùng | Hành vi local đã triển khai |
|---|---|
| Guest `/` | NEW/HOT24h, tags, pagination, loading/empty/error/retry qua public-feed; chỉ text/counters của scope được duyệt |
| Guest actions | CTA **Đăng nhập để tương tác** và Viết bài tới `/dang-nhap`; không Detail link, ảnh, vote/share/delete/contact hoặc nav Cá nhân/Admin |
| Direct protected URLs | `/bai-viet/moi`, `/bai-viet/:id`, `/ca-nhan`, `/admin` vẫn qua SessionGate, guest tới login |
| Login | Thành công về `/`, member dùng social-api và dữ liệu/quyền hiện hành |
| Logout | Commit route `/` trước Auth callback để protected guard không đưa nhầm về login; xóa session/cache theo controller cũ, chuyển sang guest feed |
| Loading/blocked/error session | Không bật guest/member feed query; giữ UI xác thực/retry/logout |

Cache `guest-posts` tách `posts`, vẫn có session epoch và late-response guards. Không fallback sang member cache khi public API lỗi. Đã kiểm login/logout và session switching qua suites hiện có. React Router giữ nguyên thư viện; `useTransitions=false` cùng `flushSync` navigation tại logout giải quyết race giữa route và external Auth-store update.

## 3. Public endpoint và ranh giới bảo mật

- Chỉ `public-feed` có `verify_jwt=false`; `social-api` giữ `verify_jwt=true`. Public POST chỉ nhận `listPosts`; các action khác bị từ chối trước truy vấn. Không gọi Auth/profile provisioning, roles, votes hoặc Storage.
- Dùng shared NEW/HOT keyset query, cursor validation, tag enum và page limit 1–20; body stream tối đa 16 KiB. Timeout query 10 giây; frontend request 15 giây, không tự retry.
- SELECT guest tối thiểu không gồm author ID, nickname snapshot, contact hoặc media metadata. Recheck `PUBLISHED/ANONYMOUS` trước response, không cấp signed URL.
- PostPublic 12 fields giữ contract adapter: `displayMode=ANONYMOUS`, nhãn `OUer ẩn danh`, `contactUrl=null`, `images=[]`, `isMine=false`, `hasUpvoted=false`. Frontend kiểm lại allowlist và các giá trị guest, không render raw response.
- Cursor HMAC có secret guest riêng, namespace và scope hash từ sorted IDs; đổi scope vô hiệu cursor cũ. TTL/filter/sort/microsecond ordering giữ logic hiện có. Không dùng cursor guest làm cursor member.
- CORS theo exact origins, response `no-store`, lỗi envelope đã lọc. Invalid/expired JWT gửi public endpoint không cấp quyền thêm; guest vẫn chỉ nhận public scope. CORS không thay authorization.
- `getPost`, comments, votes, create/publish/delete, media/signed URLs, profile và moderation vẫn nằm trên social-api, phải qua JWT/OU-confirmed/ACTIVE/ownership/ADMIN guards. Frontend không đọc raw business tables; không mở anon grants/RLS.

## 4. Files thay đổi

| Nhóm | Files |
|---|---|
| Public Edge mới | `supabase/functions/public-feed/{handler.ts,index.ts,deno.json,deno.lock}`; lock dùng dependencies đã có của social-api |
| Shared query/mapper | `functions/social-api/modules/posts/{post-service.ts,post-mapper.ts}`; member vẫn dùng projection và signed-image path cũ |
| Backend config/tests | `supabase/config.toml`, `functions/.env.example`, `tsconfig.json`, mới `tests/public-feed.test.ts`, helper `tests/helpers/post-fixture.ts` |
| Frontend API/session | Mới `shared/api/public-feed.ts`; `features/auth/{AuthProvider.tsx,AuthRoutes.tsx}`, `features/profile/ProfilePage.tsx`, `app/App.tsx` |
| Feed/UI | `features/feed/{FeedPage.tsx,PostCard.tsx,feed-query.ts,useFeed.ts}`, `shared/components/AppFrame.tsx` |
| Frontend tests | Mới `tests/public-feed.test.ts`; cập nhật bảy `scripts/*ui-check.mjs` cho public guest routing/mock endpoint/logout; E2E bổ sung guest scenarios |
| Tài liệu | README, docs01–07 và báo cáo này |

Không thêm dependency hoặc framework. Không sửa env chứa credentials, historical journals/recovery receipts/T11 evidence hoặc migrations. `supabase/.gitignore` và `supabase/tests/performance/` đã có thay đổi của owner trước task, không chỉnh sửa và không chạy performance/Cloud scripts đó.

## 5. Tests local và evidence

| Kiểm tra | Kết quả |
|---|---|
| Supabase targeted public-feed | **9/9 PASS** gồm subtests |
| Supabase `npm.cmd test` | **413/413 PASS**, 0 fail/skip/cancelled/todo; offline/PGlite/mock SDK |
| Supabase `npm.cmd run typecheck` | PASS |
| Frontend `npm.cmd test` | **97/97 PASS**, 0 fail/skip/cancelled/todo |
| Frontend typecheck/lint/build | PASS; build còn warning JS chunk >500 kB (594.62 kB/gzip 172.25 kB) |
| Deno check `--frozen --cached-only` | PASS social-api/public-feed; config/lock riêng public-feed cũng PASS, không tải dependencies |
| Deno lint | PASS 26 Edge TS files |
| Deno fmt --check | PASS public-feed/config và shared posts/new test: 6 files; Edge formatting đã kiểm riêng |
| Legacy test helper formatting | Kiểm thêm `tests/helpers/post-fixture.ts` báo FAIL formatter toàn file theo style cũ; không reformat hàng trăm dòng ngoài scope. Typecheck và full tests của helper PASS |
| Browser suites | **7/7 scripts PASS** trên bản cuối, React/Vite thật với mocked Auth/API/Storage, không Cloud |
| `git diff --check` | PASS; index rỗng, không stage/commit; vẫn có cảnh báo LF→CRLF |
| Documentation checks | UTF-8/conflict markers/local links PASS trên README + docs01–07 + report |

Browser dùng **Google Chrome 157.0.8103.79**, binary `C:\Program Files (x86)\Google\Chrome\Application\chrome.exe`, không gọi Edge/Chromium mặc định là Chrome PASS. E2E còn kiểm CDP version. Desktop 1280px/mobile 390px, dark/light; các suites cũ bổ sung 360/768px như coverage hiện có. A/B/guest là contexts riêng với identities giả, không hai sinh viên thật.

Các suites: `test:ui`, `test:ui:feed`, `test:ui:comments`, `test:ui:votes`, `test:ui:media`, `test:ui:moderation`, `test:ui:e2e`. E2E kiểm `/` và alias, guest NEW/HOT/filter/pages, không JWT/cookie, không Detail/actions/media/profile, direct protected URLs, login/member flows và logout/cache isolation. Auth/Comments/Votes/Media/Moderation giữ signup/OTP, owner label, publish 1–2 ảnh, image expiry, pending/late responses, owner delete/admin hide và authorization regression.

| Browser script | Kết quả mới |
|---|---|
| `test:ui` | PASS, 32 React screenshots; đối chiếu 24 Auth reference cases |
| `test:ui:feed` | PASS, 22 React screenshots; 360/390/768/1280 dark/light, Feed/Compose/races/privacy/logout |
| `test:ui:comments` | PASS, 22 React screenshots; thread/OP/count/ownership/privacy/session |
| `test:ui:votes` | PASS, 20 React screenshots; optimistic/double-click/lost ACK/late session responses |
| `test:ui:media` | PASS, 112 React screenshots; processing/upload/finalize/retry/gallery/expiry/focus |
| `test:ui:moderation` | PASS, 32 React screenshots; owner confirm/cancel, admin POST/COMMENT forms/denial |
| `test:ui:e2e` | PASS cả 4 lượt 1280/390 dark/light, 24 React screenshots; A/B/guest isolation và guest public feed |

Đã xem trực tiếp ảnh [guest mobile light](../../frontend/node_modules/.cache/theou-e2e-ui/guest-feed-390-light.png) và [desktop dark](../../frontend/node_modules/.cache/theou-e2e-ui/guest-feed-1280-dark.png): CTA/filter/read-only card/nav hiển thị đúng, không có ảnh hoặc nút tương tác. Artifacts này là dữ liệu tổng hợp local, không phải screenshot Cloud hoặc visual acceptance của owner.

Backend tests kiểm empty/invalid allowlist, exact approved IDs/status/mode, NEW/HOT/filter/pages/expired/tampered/scope-changed cursor, exact DTO/no Storage calls, oversized/invalid input/action/CORS, sanitized errors và hide/delete visibility. Protected actions với missing/invalid/expired-looking JWT bị từ chối; cross-owner delete và non-admin hide vẫn denied. Full suite tiếp tục kiểm raw-table/RPC/grants/RLS denial. Đây không phải live gateway/JWT/Postgres concurrency proof.

Trong quá trình chạy, harness cũ giả định logout về login và theme mặc định dark; cập nhật preconditions theo guest flow mới, giữ các assertions nghiệp vụ. Selector Unicode bị hỏng trong một lần sửa harness đã sửa lại. Logout race là lỗi ứng dụng thực và được sửa ở route/session ordering; các late-response/session regressions chạy lại sau sửa. Không nới security expectations để PASS.

Logs/screenshots ở `frontend/node_modules/` và `.cache/theou-*-ui/`, backend logs ở `supabase/node_modules/`, Git ignored. Không quy số screenshots thành số test. Không dùng bằng chứng Cloud/T11/T12 cũ làm PASS mới.

## 6. Rủi ro và giới hạn

Body bài do người dùng viết có thể chứa thông tin cá nhân dù DTO không có identity fields. Owner cần review nội dung/consent của từng ID trước công khai Internet; allowlist ID không pin content hash, nên nội dung được quản trị sửa phải review lại. Empty scope ngăn lần đọc mới nhưng không thu hồi bản đã đọc/copy/cache bên ngoài.

Recheck visibility giảm race với hide/delete nhưng không bảo đảm linearizability hoặc thu hồi text đã trả. HOT vẫn có giới hạn live vote ordering hiện hữu. Public API không có distributed rate limiter mới; body/page/scope/time bounds không thay abuse/quota protection. Owner phải review traffic/cost/monitoring trước Phase B.

Chưa kiểm Cloud gateway/config/secrets/CORS/deployment, guest production smoke, thiết bị thật/screen reader hoặc network timeout thật. Giữ AUTH-ALIAS-001 và các known limitations trước đây. Không có migration nên không có DB rollback; không đụng role ADMIN chính thức hoặc retained Cloud data.

## 7. Phase B — đề xuất deploy, chưa được thực thi

Owner review diff/local tests, dữ liệu được phép công khai, exact project và frontend origin trước khi duyệt từng bước. Không lấy approval Phase A làm approval deploy.

1. Pin artifact/commit được review, lưu frontend deployment trước và config hiện tại ở nơi riêng. Xác nhận `social-api.verify_jwt=true`, `public-feed.verify_jwt=false`, grants/RLS không đổi.
2. Duyệt server secrets bằng Dashboard hoặc quy trình secrets riêng: `THEOU_PUBLIC_FEED_POST_IDS` **rỗng ban đầu**, `THEOU_PUBLIC_FEED_CURSOR_SECRET` mới, riêng biệt, 43–128 ký tự base64url; `THEOU_ALLOWED_ORIGINS` exact origins đã duyệt. Không đặt service key/cursor secret/allowlist vào frontend hoặc command history. Frontend tiếp tục chỉ URL và publishable key hiện có.
3. Từ `supabase/`, với native CLI đã review, command shape CLI 3.1.0 đã kiểm bằng help offline:

   ```powershell
   & '<ABSOLUTE_REVIEWED_SUPABASE_EXE>' functions deploy public-feed --remote=puhkisyehspcmgzerutm --use-api
   ```

   Placeholder là đường dẫn native CLI owner xác minh local; không phải lệnh copy chạy ngay. CLI v3.1.0 dùng `--remote`, không `--project-ref`. Public function có config/import map/lock riêng. Không dùng cờ tắt JWT cho social-api, không deploy toàn bộ functions, `db push` hoặc `config push`. Không bắt buộc redeploy social-api để bật guest endpoint; nếu cần cập nhật bundle private thì review riêng.
4. Owner duyệt frontend deployment artifact riêng, xác nhận target backend và origin/CORS. Không mặc định public domain được phép trỏ vào Dev retained data. Không có Vercel deploy/push trong task này.
5. Smoke scope rỗng phải trả empty safe envelope; guest direct protected URLs/login behavior; protected HTTP actions không JWT vẫn denied. Sau approval nội dung riêng mới thêm exact IDs và smoke NEW/HOT/tag/pages, không ảnh/identity/capability, member/admin regression. Read-only SQL/API checks cần scope riêng; không tạo fixtures hoặc grant ADMIN tự động.

## 8. Rollback và điểm dừng

Nếu leak/drift/authorization lỗi, dừng rollout. Owner đặt allowlist rỗng để chặn public content ở các response mới; rollback frontend về deployment đã pin. Không coi việc ẩn CTA là bảo vệ dữ liệu. Nếu cần tắt function hoàn toàn, owner phê duyệt riêng:

```powershell
& '<ABSOLUTE_REVIEWED_SUPABASE_EXE>' functions delete public-feed --remote=puhkisyehspcmgzerutm
```

Chỉ exact function public-feed; không delete/redeploy social-api hoặc sửa grants/RLS/Cloud content. Xóa secret guest không còn dùng và điều tra/cache response theo approval riêng; không in payload/private content ra logs. Rollback không thể thu hồi text đã công khai.

**Cloud calls=0; Cloud Auth/SQL/business/role mutations=0; deploy/resources=0; không stage/commit/push. Phase A dừng chờ owner review; chưa GO Phase B hoặc Cloud acceptance.**
