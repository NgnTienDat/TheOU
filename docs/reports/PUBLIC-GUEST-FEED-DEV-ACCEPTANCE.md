# Public guest feed — Phase B1 TheOU-dev acceptance

**Ngày ghi nhận: 23/11/2026. B1: OWNER-CONFIRMED MANUAL PASS. B2 staging: NOT TESTED / PENDING OWNER APPROVAL.** Phạm vi US-03 guest read-only Feed và regression các luồng member hiện có. Nguồn acceptance là xác nhận trực tiếp của owner trong task này; không phải một lượt Cloud automation của agent.

## 1. Dev acceptance status

Target được owner xác nhận: **TheOU-dev `puhkisyehspcmgzerutm`**. Đối chiếu [Phase A local](PUBLIC-GUEST-FEED-LOCAL.md), source hiện tại và yêu cầu/docs01–07. Giữ Phase A như bằng chứng lịch sử; báo cáo này bổ sung acceptance B1, không sửa journal hoặc baseline cũ.

| Nhóm smoke | Owner xác nhận | Phân loại / giới hạn evidence |
|---|---|---|
| Guest Guard | PASS: routing, protected routes, read-only permissions | Manual Cloud trên dev; agent không chạy lại request, không có trace từng assertion mới được cung cấp |
| Member Regression | PASS: feed, Detail, comments, votes, profile, login/logout | Manual Cloud trên dev; không tự mở rộng thành mọi negative/Auth/ADMIN/concurrency case |
| Public Feed | PASS: approved synthetic posts, NEW/HOT, tags, pagination, DTO privacy, allowlist removal | Manual Cloud trên dev; không đưa IDs/nội dung thật/capability vào báo cáo; removal không chứng minh thu hồi bản đã copy |

**Chốt B1 PASS đúng ba nhóm trên.** Automated Cloud tests mới: **NOT RUN**. Signup/SMTP/OTP thật, outside-OU/BANNED/unconfirmed, live raw-table denial, ADMIN audit/races hoặc test thiết bị thật không có evidence riêng trong xác nhận B1 thì **NOT TESTED trong B1**, không suy ra PASS từ local tests hoặc acceptance T11/T12 cũ. Staging và domain `https://theou.tech` không được tick PASS bằng dev results.

## 2. Local evidence và Git hiện tại

Phase A có logs local: Supabase **413/413**, frontend **97/97**, bảy browser scripts Chrome **PASS**, typecheck/lint/build/Deno Edge PASS trong phạm vi báo cáo; helper test cũ còn lệch Deno formatter toàn file và build chunk >500 kB. Đã đọc lại logs unit và báo cáo; **không chạy lại toàn suite hoặc browser trong task tài liệu này**.

Checks mới: `node --test tests/public-feed.test.ts` tại Supabase **9/9 PASS**; cùng lệnh tại frontend **1/1 PASS**. Đây là PGlite/mock SDK/adapter local, không Auth server hoặc gateway Cloud. CLI `--version`/deploy/delete `--help` offline PASS; documentation/Git checks ghi ở [kế hoạch B2](PUBLIC-GUEST-FEED-STAGING-PROMOTION.md).

Git tại thời điểm review: branch **`update/get-feed`**, HEAD **`abd0c8783ff6ee26e7a3d9c78f94bb97e93bd27a`**, working tree dirty. Guest implementation còn tracked modifications và untracked `public-feed`, adapter/tests; HEAD một mình **không chứa toàn bộ implementation**. Có cả thay đổi owner ở `supabase/.gitignore` và `supabase/tests/performance/`; không chỉnh sửa/chạy chúng. Không stage/commit/push, không đổi branch hoặc reset files.

Pin local candidate, SHA-256 raw bytes:

| File | SHA-256 |
|---|---|
| `supabase/config.toml` | `a84b4124262a4873652f1432d571e135515ae6865d9efcfa44cbb1cb67112954` |
| `supabase/functions/public-feed/handler.ts` | `e8a824e3dd73b6459ec124822e7f014c0b8a954c137c2f1c123a5c6a031d52c8` |
| `supabase/functions/public-feed/index.ts` | `d53312da99e86e4d3e1a622172b13d5efdb0c1d08ae86676207724424c146987` |
| `frontend/vercel.json` | `14b95599e5dca449bd7efdf5cf240c91dca33418b6beb8e0f4bb0774ecf64e44` |

Candidate manifest digest **`81e621e286c2046134478ccc702aad31da9df64f7e40908a452fb3bc2d96714c`**: SHA-256 của `JSON.stringify` map sorted POSIX-relative path → raw-file SHA-256; gồm 110 files đệ quy trong `frontend/src`, `frontend/scripts`, `frontend/tests`, `supabase/functions` (loại `.env`/`.env.*`), cộng frontend package/lock/vercel.json và supabase/config.toml. Đây là pin code/test/config hiện tại, **không phải chứng minh toàn artifact build/dev deployed bundle**, không chứa secrets hoặc env. Owner cần xác nhận source/artifact của deployment đã test tương ứng candidate; nếu khác, review diff và regression phần khác trước promotion.

## 3. Security boundary review

Source/config local xác nhận public-feed chỉ `listPosts`, không JWT, chỉ SELECT exact allowlist server tối đa100 IDs còn PUBLISHED/ANONYMOUS; default empty. Projection không chọn author/profile/nickname/contact/media; DTO anonymous, flags false, images[], contact null. Không signed URL/Storage/Auth/profile provisioning. Body16 KiB/page1–20/timeouts/cursor HMAC riêng+scope hash/recheck visibility/no-store vẫn có. Action ngoài allowlist bị từ chối, lỗi không trả SQL/credentials.

`social-api.verify_jwt=true` giữ nguyên; `authenticate` xác minh token bằng Auth `getUser(jwt)`, confirmed OU/nonanonymous, ACTIVE profile và owner/ADMIN kiểm server-side. Public function không nới các guards hoặc grants/RLS. CORS không phải authorization; public endpoint vẫn public đối với client không có Origin. Không migration/schema/grants change trong patch.

## 4. Những vấn đề còn tồn tại / staging blockers

Không phát hiện blocker code mới trong review có phạm vi này. **GO chuẩn bị B2, chưa GO execution** vì:

1. Chưa pin một release artifact/SHA chứa dirty implementation và đối chiếu với dev deployment đã nghiệm thu. Không phát hành từ HEAD cũ hoặc gom performance changes chưa review.
2. `frontend/.env.local` kiểm nội bộ cho kết quả **URL staging MATCH=false**, key chỉ đạt publishable shape, chỉ hai VITE names cho phép. Không in giá trị, không xác minh key thuộc project nào. Đây chặn local upload/build dùng env hiện tại; không chứng minh Vercel env sai. Vercel settings/build output cần owner xác minh riêng.
3. Owner cho biết `theou.tech` đang nối staging `gxsfbzaconeaxwztynpm`; agent không gọi domain/Dashboard để xác minh deployment, secrets, JWT flags, Auth settings, roles hoặc schema staging. Cần checklist B2 và rollback artifact trước khi đổi runtime.
4. Public body có thể chứa PII; ID allowlist không pin body hash. Owner phải duyệt từng synthetic post trước mở scope. Public traffic/quota/rate limiting, HOT live ordering/cache/copy/revocation, mobile thật và AUTH-ALIAS-001 vẫn là limitations, không tự đóng.

Kế hoạch triển khai, approval boundaries, staging smoke và rollback tại [B2 staging promotion](PUBLIC-GUEST-FEED-STAGING-PROMOTION.md).

**Task này chỉ thay tài liệu/check local: Cloud project/Auth/SQL/API calls=0, Cloud mutations/deploy=0, không stage/commit/push. Có tra cứu public documentation chính thức; không truy cập app hoặc Supabase projects. B1 ACCEPTED — MANUAL PASS / B2 PLAN READY — PENDING OWNER APPROVAL.**
