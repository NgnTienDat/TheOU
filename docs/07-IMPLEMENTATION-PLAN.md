# 07 — Kế hoạch triển khai 4 tuần, kiểm thử và nghiệm thu

**Ngày bắt đầu giả định:** từ khi repo và bộ tài liệu được chốt; mốc W1–W4 tính theo tuần phát triển, không gắn cứng ngày lịch.  
**Nguồn lực:** 1 developer + Codex; ưu tiên luồng hoạt động và bảo vệ danh tính hơn hiệu ứng giao diện.

## 1. Nguyên tắc thực thi

**GUEST-FEED B1/B2 — 23/11/2026:** Owner xác nhận **B1 TheOU-dev MANUAL PASS** cho Guest Guard, Member Regression và Public Feed; không phải automated Cloud test của agent. [Dev acceptance](reports/PUBLIC-GUEST-FEED-DEV-ACCEPTANCE.md) bổ sung kết quả sau Phase A bên dưới. [Staging promotion plan](reports/PUBLIC-GUEST-FEED-STAGING-PROMOTION.md) chỉ nhắm `gxsfbzaconeaxwztynpm` / `https://theou.tech`, scope public rỗng ban đầu; source/artifact/env/JWT/secrets/rollback phải được đối chiếu trước deploy. B2 chưa smoke/acceptance, không coi dev PASS là staging PASS hoặc đóng T13/W2; không deploy, sửa secrets, stage/commit/push trong lượt chuẩn bị này.

**GUEST-FEED — owner yêu cầu 23/11/2026:** Phase A implementation/local checks, chưa Phase B/Cloud acceptance. `/` Feed guest/member, `/bang-tin` alias, separate read-only public-feed, explicit server scope mặc định rỗng, no guest images/detail/interactions. Giữ social-api JWT, grants/RLS/OU policy; không migration. Các guard/JWT/ownership/ADMIN/UI regressions cùng deployment/rollback được ghi tại [báo cáo local](reports/PUBLIC-GUEST-FEED-LOCAL.md). Owner review local diff + exact approved post IDs + public exposure/traffic risk trước khi duyệt secrets/config/Edge/frontend deployment và smoke Cloud. Không tick các Cloud acceptance cũ thành public-feed PASS; không tự deploy hoặc push main.

- Không triển khai 7 feature song song trong tuần 1: đi theo **vertical slice** đầu cuối.
- Mỗi task có: ID, phạm vi, tiêu chí nghiệm thu, test, migration nếu có.
- Mỗi ngày kết thúc bằng build/typecheck và ít nhất một bước chạy thực tế; tránh tích hợp tất cả vào ngày cuối.
- **Gate bảo mật không được chuyển sang W3:** quyền dữ liệu, email OU, bảo vệ ẩn danh và kho ảnh private phải đạt ngay W2.
- Nếu trễ tiến độ, ưu tiên auth → text post → feed → comment → vote → admin; ảnh là hạng mục cuối W2, nhưng là **điều kiện nghiệm thu Prototype đã chốt**, vì vậy cần báo rõ nếu chưa làm xong, không gọi là hoàn tất.

## 2. Danh sách công việc theo tuần

### W1 — Nền tảng và luồng đăng bài text

| ID | Công việc | Phụ thuộc | Tiêu chí xong |
|---|---|---|---|
| T01 | Tạo Vite React TS, Tailwind, Router, TanStack Query, lint/test | — | CI chạy typecheck/build |
| T02 | Supabase Cloud Development TheOU-dev, migration schema + RLS/grants | T01 | **COMPLETED 15/11/2026:** migration/catalog đạt; offline 22/22, Cloud 8/8 PASS; cleanup đã xác minh |
| T03 | Đăng ký email OU + mật khẩu, OTP xác minh signup; đăng nhập mật khẩu; SMTP và hook OU | T02 | **COMPLETED 16/11/2026:** offline 47/47 PASS; chủ dự án xác nhận passwordless denied và password login regression PASS sau đổi settings. Signup/OTP đã PASS trước đó; regression sau đổi settings chuyển T05 khi có OU account mới. Xem [báo cáo T03](reports/T03-STATUS-REPORT.md) |
| T04 | Xây `social-api` auth guard, error wrapper, `getMe` | T02,T03 | **COMPLETED — PASS 16/11/2026:** T04-A typecheck, Deno check/lint/fmt và 65/65 offline PASS; sau B.7, 99/99 offline PASS. Chủ dự án xác nhận smoke Cloud và BANNED/ADMIN/RACE PASS, cleanup users=1, profiles=1, roles=0 khớp baseline. Xem [báo cáo nghiệm thu T04](reports/T04-STATUS-REPORT.md) |
| T05 | UI đăng ký/mật khẩu, OTP xác minh signup, đăng nhập mật khẩu, route guard, nickname | T03,T04 | **COMPLETED — PASS 16/11/2026:** frontend 23/23, Supabase 102/102 offline PASS; lint/typecheck/build/Deno và browser UI đạt, React UI được chủ dự án phê duyệt. Chủ dự án xác nhận Cloud login/session/getMe/updateNickname/logout và signup + OTP regression PASS; updateNickname đã deploy. OU alias +t05 được giữ lại, chính sách alias theo issue riêng trước Beta. Xem [nghiệm thu T05](reports/T05-STATUS-REPORT.md) |
| T06 | `createPost` draft, `publishPost`, `listPosts`, `getPost` text | T04 | **COMPLETED — PASS (16/11/2026):** T06-A Supabase 116/116, frontend 25/25 offline PASS; sau runner 130/130 PASS. Migration/Edge đã deploy, smoke A/B đạt; chủ dự án xác nhận controlled writes/API, PostgreSQL 5 post (4 PUBLISHED/1 DRAFT), race 1 row, 10 negative không tạo row, anonymous violations=0. Cleanup PASS, 15/15 keys row_count=0; baseline users=2/profiles=2/roles=0/posts=0/test_posts_remaining=0. HOT snapshot/biên vote–24h–ties, đổi nickname sau publish, cursor hết hạn, chống spam/performance còn giới hạn theo [nghiệm thu T06](reports/T06-STATUS-REPORT.md). Sẵn sàng T07, chưa triển khai UI |
| T07 | Feed mobile-first, tab mới/nổi bật, tag, composer text | T06 | **COMPLETED — PASS (17/11/2026):** frontend 43/43 offline PASS; lint/typecheck/build/diff đạt, browser offline 54 ảnh; chủ dự án duyệt 6/6 UI checklist và xác nhận A/B React Cloud E2E PASS. PostgreSQL: 2 posts, 2 PUBLISHED, 0 DRAFT, 2 publishing_accounts, anonymous_violations=0. **Chủ dự án giữ cả hai bài, không cần cleanup.** Còn giới hạn recovery/HOT/accessibility/bundle/chống spam/alias theo [nghiệm thu T07](reports/T07-STATUS-REPORT.md). Sẵn sàng T08; chưa nghiệm thu W2/Prototype |

**Gate W1:** 2 email OU có thể đăng nhập, A đăng text ẩn danh, B đọc feed; thử request trực tiếp không có JWT và direct DB access bị chặn. Chỉ chuyển W2 sau khi chứng minh dữ liệu identity không rò rỉ qua DTO.

**Đánh giá Gate W1 — 17/11/2026: ĐẠT trong phạm vi luồng text theo bằng chứng tích lũy.** Không chạy lại các ca bảo mật trong lượt đóng tài liệu:

| Tiêu chí W1 | Kết quả và nguồn bằng chứng |
|---|---|
| Hai email OU đăng nhập | **ĐẠT:** chủ dự án xác nhận hai tài khoản đăng nhập/đăng bài qua React UI T07-B; hai danh tính Auth không chứng minh hai sinh viên độc lập |
| A đăng text ẩn danh, B đọc feed | **ĐẠT trong các lớp đã kiểm thử:** T06 controlled writes xác nhận bài ẩn danh và B đọc qua API; T07-B xác nhận hai tài khoản đăng bài và bài xuất hiện trên Feed React. Không suy ra cả hai bài giữ lại đều ẩn danh chỉ từ anonymous_violations=0 |
| Request trực tiếp không JWT bị chặn | **ĐẠT:** Cloud smoke T04/T06 đã PASS, T06 ghi handler UNAUTHENTICATED/401; không nhận là ca mới chạy ở T07-C |
| Direct raw-table access bị chặn | **ĐẠT:** Cloud integration và catalog/grants/RLS T02 đã nghiệm thu; T07 không mở lại quyền bảng, không kiểm tra Cloud mới trong lượt này |
| Identity không rò qua DTO bài text | **ĐẠT trong ca đã chạy:** T06 Cloud PostPublic allowlist/privacy A/B, T07-A automated adapter/DOM và số liệu DB T07-B anonymous_violations=0. Số đếm DB riêng lẻ không chứng minh toàn bộ response an toàn |

Chi tiết nguồn/giới hạn ở [báo cáo T07](reports/T07-STATUS-REPORT.md). **W2 và E2E-001 bên dưới chưa được nghiệm thu**; không đánh dấu các bước ảnh/comment/upvote/delete/moderation hoặc mở Beta. Rate limiting/chống spam chưa nghiệm thu; [AUTH-ALIAS-001](issues/AUTH-ALIAS-001.md) vẫn mở trước Beta. Hai bài T07 là dữ liệu chủ dự án chủ động giữ trên TheOU-dev, không phải fixture còn sót cần xóa; số posts=0 của T06 chỉ là baseline lịch sử.

**T04-B.7 (16/11/2026):** chủ dự án xác nhận đã chạy runner trên TheOU-dev: BANNED bị chặn với JWT cũ, ADMIN thay đổi theo DB với cùng JWT, 10 yêu cầu khởi tạo profile đồng thời đạt, cleanup về baseline. Cờ `THEOU_ALLOW_T04_CLOUD_TESTS` đã được chủ dự án đặt lại rỗng. Đây là bằng chứng nghiệm thu T04; [hướng dẫn B.7](reports/T04-B7-SECURITY-TEST.md) ghi trạng thái trước khi chạy, còn [báo cáo T04](reports/T04-STATUS-REPORT.md) ghi kết quả cuối. Giới hạn: logout local không chứng minh JWT cũ bị thu hồi ngay; 10 yêu cầu không phải kiểm thử chịu tải.

**Kiểm tra T01 tại máy (13/11/2026):** `lint`, `typecheck`, `test` (6 test cấu hình môi trường), `build` đều thành công. Dev server khởi động và trả HTTP 200 cho HTML và các module chính. Đã kiểm tra Git bỏ qua env riêng và quét các file tracked/unignored tìm credentials. Chưa chạy CI trên GitHub, chưa kiểm thử giao diện bằng trình duyệt hoặc kết nối Supabase thật. `npm audit` báo 10 cảnh báo moderate trong chuỗi công cụ ESLint/TypeScript ESLint liên quan `minimatch`; chưa áp dụng downgrade/major change tự động. T01 không chứng minh gate W1 hay các user story nghiệp vụ đã hoàn thành. Task tiếp theo: **T02 — schema, RLS/grants và test quyền truy cập**.

### W2 — Tương tác, ảnh, công cụ admin, nghiệm thu Prototype

**Trạng thái T02 (15/11/2026): COMPLETED.** Đã áp dụng migration `20261113170214_t02_schema_security.sql` đúng bản duyệt trên TheOU-dev, catalog đạt; offline 22/22 PASS, Cloud integration 8/8 PASS theo xác nhận chủ dự án. Kiểm tra read-only sau test: Auth users/identities T02 = 0, chín bảng nghiệp vụ đều rỗng. Xem [báo cáo nghiệm thu](reports/T02-STATUS-REPORT.md). T03 là task tiếp theo trong kế hoạch, chưa triển khai trong lượt nghiệm thu này.

**Trạng thái T03 (16/11/2026): COMPLETED — PASS.** Offline gần nhất 47/47 PASS và typecheck PASS. Chủ dự án xác nhận passwordless denied và password login regression đều PASS sau khi tắt Enable magic links and email OTP: request OTP bị từ chối/không session; mật khẩu sai bị từ chối, đúng mật khẩu/getUser xác nhận OU đã xác minh, không yêu cầu OTP, logout thành công. Signup OU/OTP, SMTP, Gmail hook và cleanup có bằng chứng từ trước; snapshot cleanup read-only ngày 15/11/2026 không được coi là kiểm kê mới.

**Giới hạn tại Final Acceptance T03 (lịch sử):** signup + OTP verification chưa được kiểm thử lại sau khi tắt passwordless, nên chuyển regression sang T05. **Cập nhật nghiệm thu T05 ngày 16/11/2026:** chủ dự án xác nhận signup OU alias +t05, nhận OTP qua Resend, mã sai/đúng và password login sau xác minh đều PASS. Phần regression chuyển tiếp đã hoàn thành; không suy ra toàn bộ Email Provider bị tắt chỉ từ email_provider_disabled.

**Cập nhật manual runner:** đã sửa nhận diện đúng nhánh MagicLink disabled; log có email_provider_disabled/422, magicLinkDisabled=true, responseSession=false, getSession=null và PASS toàn mode. Xem mục 10 [báo cáo T03](reports/T03-STATUS-REPORT.md) cho quyết định nghiệm thu; các lần FAIL trước là lịch sử. Lượt chốt chỉ sửa hai tài liệu, không sửa Cloud/source/migration, không chạy lại tests hoặc triển khai T04/T05.

Xem [báo cáo nghiệm thu T03](reports/T03-STATUS-REPORT.md); [T03-A Implementation](reports/T03-A-IMPLEMENTATION.md) là snapshot triển khai trước lượt nghiệm thu. Quên/đổi mật khẩu chưa thuộc T03; một OU account đủ cho riêng Auth, gate Prototype vẫn cần hai OU account ở mốc sau; alias cùng hộp thư không tự chứng minh có hai sinh viên độc lập. Giữ chốt T02 Admin/Gmail khi hook bật; không dùng suite đó để chứng minh domain. T04 và T05 đã nghiệm thu trong phạm vi tương ứng. Account +t05 còn tồn tại, không tự cleanup; [AUTH-ALIAS-001](issues/AUTH-ALIAS-001.md) cần đánh giá trước Beta. Các ca Cloud chưa xác minh và cảnh báo chưa xử lý được ghi ở [báo cáo T05](reports/T05-STATUS-REPORT.md).

| ID | Công việc | Phụ thuộc | Tiêu chí xong |
|---|---|---|---|
| T08 | `listComments`, `createComment`, `deleteComment` chính chủ; chi tiết bài/UI comment | T06,T07 | **COMPLETED — PASS (17/11/2026):** UI A.1 được chủ dự án phê duyệt; frontend54/54, Supabase179/179 offline PASS. Migration/trigger/ACL/RLS/social-api/manual A/B6/6 và smoke đạt; controlled create/idempotency/lost ACK simulation, R1 pagination/privacy/cursor thật khác post, R2 cross-owner/concurrent delete/replay/atomic count PASS. Journal R2 local COMPLETED/uncertain=false; chủ dự án xác nhận cleanup sáu fixture và SQL verification PASS. Cuối: users2/profiles2/posts2 PUBLISHED/comments2 (VISIBLE1/DELETED1), counts1/0, mismatch0, fixture0; **giữ hai bài T07/hai comment thủ công T08**. Còn giới hạn recovery reload/cursor expiry/ties/parent race/abuse/load/mobile thực/bundle và AUTH-ALIAS-001. Social UI V2 là thiết kế riêng chưa tích hợp React; không tính hoàn thành V2 hoặc W2/Prototype. Xem [nghiệm thu T08](reports/T08-STATUS-REPORT.md). |
| T09 | `toggleUpvote` atomic, optimistic UI + rollback | T06 | **COMPLETED — PASS (17/11/2026).** Supabase208/208, frontend63/63 và local checks/browser regressions PASS theo báo cáo; chủ dự án review UI6/6. Cloud migration/ACL/trigger/deploy/smoke, manual A/B count0→1→2→1→0 và controlled C1–C8 PASS. Smoke `3e8c7eb750544d179b69a282661ce0d0`, write `81f0d01ff37248f2bff2de7650cf1deb`; artifacts local hợp lệ, uncertain=false, protected fingerprints khớp tại checkpoints. Chủ dự án cleanup vote cuối qua business UI/API, xác nhận SQL: posts2/comments3 (VISIBLE2/DELETED1), votes0/upvotes0, vote/comment mismatch0; giữ hai posts/ba comments. Fingerprint toàn rows sau cleanup chưa xác minh; journal lịch sử AWAITING_CLEANUP được giữ nguyên. Parent status race/timeout thật/multi-tab ordering/HOT snapshot/load/abuse/mobile thực/bundle/AUTH-ALIAS-001 còn giới hạn. Xem [nghiệm thu T09](reports/T09-STATUS-REPORT.md). |
| T10 | Tải ảnh private, signed upload/finalize/read, gỡ ảnh DRAFT | T06 | **COMPLETED — PASS (18/11/2026).** Local theo từng lượt: Supabase222/230/246 tests PASS; frontend73/77/87 tests PASS, không cộng dồn. Chủ dự án xác nhận bucket private2MiB/JPEG/PNG/WebP, Storage policies/RLS, migration T10/deploy, smoke A/B6/6, controlled PNG/WebP upload/finalize/publish, A/B private reads, React carousel6/6 và Signed URL6/6 TTL300giây PASS. UI-R2 có source/local87/87 và mock focus/expiry/overlap PASS; chủ dự án xác nhận riêng đã kiểm tra sau UI-R2 và PASS: đổi tab dưới TTL không reload ảnh/API thừa, sau TTL chỉ refresh cần thiết và giữ slide. Giữ run `241a869766c84d8fa229f30ba8ff7d6b`, post `d8ce8b82-91e0-433a-a9ff-2113922351f3`/hai objects, không cleanup; cuối posts3 PUBLISHED/comments3/votes0/READY images2/objects2, comment/vote mismatch0 theo chủ dự án. Races/remove Cloud/recovery/orphans/denial mọi endpoint/device thực/bundle>500kB/AUTH-ALIAS-001 còn giới hạn. Không Cloud/deploy/source change trong lượt closure, không suy ra W2/Prototype hoàn thành; xem [nghiệm thu T10-D](reports/T10-STATUS-REPORT.md). |
| T11 | Xóa mềm bài, admin hide/audit; tái sử dụng comment lifecycle/delete của T08 | T08 | **COMPLETED — PASS (19/11/2026), chủ dự án chính thức nghiệm thu.** Migration T11 và social-api đã deploy TheOU-dev; Cloud moderation E2E PASS. Regression T11-D: Supabase312/312, frontend94/94, browser moderation mock/typecheck/lint/build/Deno/diff đạt; không chạy lại trong lượt chốt. Owner thực thi final ADMIN revoke và xác nhận full snapshot match, roles0/audits2. Giữ historical content, tám fixture rows, hai immutable audits và media; counts không lệch. Signed URL TTL/cache, concurrency/recovery/mobile thực/bundle và AUTH-ALIAS-001 giữ nguyên giới hạn. Các pending A/B/C/D trước owner acceptance là lịch sử; không suy ra Gate W2/Prototype hoặc T12 COMPLETED. Xem [nghiệm thu T11](reports/T11-D-FINAL-ACCEPTANCE.md). |
| T12 | Test E2E, test quyền truy cập, responsive + sửa lỗi | T08–T11 | **T12-A PLAN READY / PENDING REVIEW (19/11/2026).** [Kế hoạch E2E](reports/T12-A-E2E-TEST-PLAN.md) ánh xạ đủ 10 kịch bản E2E-001 mục3 và security/responsive matrix; chưa chạy T12 hoặc cấp quyền Cloud. Dòng “đủ 7 bước” trước đây là tóm tắt không đầy đủ; tiêu chí gốc vẫn là toàn bộ checklist10mục + API permission/RLS/grants. Quyết định staging mới/T13, tài khoản test, fixtures và ADMIN tạm phải được duyệt trước Cloud E2E. |
| T13 | Deploy staging và hướng dẫn chạy/rollback | T12 | Link HTTPS được bảo vệ, test 2 tài khoản OU |

**Gate W2 — Prototype:** xem checklist ở mục 3. Chỉ mời nhóm test nhỏ, có admin trực để xử lý vấn đề.

**T11 owner acceptance — 19/11/2026: COMPLETED — PASS.** Chủ dự án chính thức chấp nhận [nghiệm thu T11-D](reports/T11-D-FINAL-ACCEPTANCE.md) và cho chuyển sang T12. Migration/social-api đã deploy TheOU-dev, Cloud moderation E2E PASS; final revoke/full-snapshot verification do owner xác nhận đạt: roles0, audits2, empty-role fingerprint. Giữ8posts (PUBLISHED4/HIDDEN1/DELETED2/DRAFT1),6comments (VISIBLE3/HIDDEN1/DELETED2), hai ảnh/objects và historical content. Regression D đã chạy: Supabase312/312, frontend94/94, moderation browser mock32ảnh, typecheck/lint/build/Deno đạt; còn bundle>500kB. Đây là kết quả D đã ghi, không phải test mới trong lượt owner closure. Evidence/journals giữ nguyên; journal vẫn lưu snapshot trước revoke, không sửa status/baseline. Pending local A/C và pending owner acceptance của D trước quyết định này là lịch sử. AUTH-ALIAS-001 và mọi known limitations trong báo cáo vẫn mở. Không tick Gate W2/Prototype hoặc T12 COMPLETED; admin vận hành cần approval riêng vì role tạm đã thu hồi.

**T12-A — 19/11/2026: PLAN READY / PENDING REVIEW.** Chỉ lập [kế hoạch](reports/T12-A-E2E-TEST-PLAN.md), chưa chạy Cloud E2E, tạo fixture hoặc grant ADMIN. Frontend local + TheOU-dev là môi trường integration đề xuất; không đồng nhất với tiền điều kiện database staging mới của E2E-001. Cần owner chốt trình tự T12/T13 hoặc phê duyệt thay đổi tiền điều kiện có ghi nhận; trước đó staging acceptance còn BLOCKED. Hai OU Auth identities/aliases không chứng minh hai sinh viên độc lập. T01–T10/UI-V2 và checklist E2E gốc giữ nguyên.

**T12-B — 19/11/2026: LOCAL COMPLETED / PENDING OWNER REVIEW.** Theo [báo cáo local E2E](reports/T12-B-LOCAL-E2E.md), Supabase312/312, frontend94/94, typecheck/lint/build/Deno Edge và sáu browser scripts hiện có PASS mới trên Google Chrome157.0.8103.79; thêm E2E mock A/B/guest ở1280/390px dark/light PASS. Sửa lỗi nhỏ nút Làm mới bình luận không refetch counts bằng helper hiện có; regression trước sửa FAIL count1/2, sau sửa PASS. Tổng264ảnh React +24HTML references là artifacts, không phải288tests. Không làm T12-B0/domain policy, giữ `ou.edu.vn`, Auth/API/migrations và T11 evidence. GO đề xuất T12-C chuẩn bị/review preflight; Cloud execution còn cần approval, fresh snapshot, accounts/ADMIN/manifest và quyết định staging/T13. Không gọi Cloud, stage/commit hoặc tick T12/Gate W2 COMPLETED; AUTH-ALIAS-001/bundle/mobile thực và các giới hạn còn mở.

**T11-C.1-A — 18/11/2026: runner local completed / pending review.** Chủ dự án cung cấp PASS B.1 UI/security review, B.2 preflight, B.3 migration T11/RPC/ACL/triggers và B.4 deploy/read-only UI smoke A/B6/6. Ghi chú chưa push/deploy/review ở snapshot T11-A trong bảng là lịch sử trước B, không phải trạng thái Cloud mới do agent kiểm tra. Runner C.1-A chỉ chuẩn bị local: `--smoke`, `--fixture-write`, `--moderate-write <runId>` tách flags;5posts/3comments mới, exact scope/baseline/fingerprints, write-ahead INTENT, project lock, audit/count checkpoints, unknown commit chặn rerun. Đề xuất ADMIN tạm trên actor B sau phê duyệt riêng, grant/revoke SQL chỉ để review; không tạo/xóa Auth, tự đổi role hoặc cleanup. Local **273/273 offline tests PASS**, typecheck, Deno Edge check và lint/fmt5file mới đạt; chưa chạy Cloud runner. Giữ protected3posts/3comments/2objects; fixtures/audits tương lai được giữ theo retention đã duyệt. **T11 chưa COMPLETED**, chờ review trước mỗi phase Cloud. Xem [bàn giao C.1-A](reports/T11-C1-A-RUNNER.md).

**T12-C.1 — 19/11/2026: LOCAL PREPARED / PENDING OWNER REVIEW.** [Harness/preflight](reports/T12-C1-CLOUD-PREFLIGHT-PREP.md) riêng T12, default read-only, exact project/native CLI và snapshot/evidence/incident guards; Auth/fixtures/moderation/role execution vẫn BLOCKED. Chuẩn bị SQL SELECT, draft budget4posts/5comments/3objects và grant/revoke review checklists, không executable UUID SQL. Mapping ADMIN theo target owner chỉ định cần Auth server xác minh riêng, không mặc định B hoặc suy hai aliases là hai sinh viên. C.1 không Cloud calls/mutations, không sửa T11 evidence/migrations/Edge/domain policy, không stage/commit. T12/Gate W2 vẫn chưa COMPLETED; staging/T13, fresh Cloud baseline/Auth settings/actors/Edge deployment và từng quyền execution cần review riêng. Kết quả local theo bảng verification trong báo cáo, không nhận mock PASS thành Cloud PASS.

**T12-C.1-R1 — 19/11/2026: REVIEW READY / PENDING OWNER APPROVAL.** [Review CLI compatibility](reports/T12-C1-R1-CLI-COMPATIBILITY.md) offline xác nhận runtime WITH/SELECT được parser CLI3.1.0 chấp nhận; draft transaction wrapper cũ bị từ chối tại BEGIN và được giữ nguyên. Tạo riêng `preflight-cli-r1.sql`, giữ query/full-proof/read-only semantics; không nới verification. Targeted16/16, full Supabase328/328, typecheck/Deno checks đạt; không Cloud calls hoặc fresh Cloud acceptance. Chỉ đủ điều kiện trình owner duyệt SQL-only preflight, chưa có quyền thực thi hoặc GO Cloud E2E; T12/Gate W2 chưa COMPLETED.

**T12-C.2-R3 — 19/11/2026: LOCAL READY / PENDING OWNER REVIEW.** [Allowlist/recovery review](reports/T12-C2-R3-ALLOWLIST-AND-RECOVERY-REVIEW.md) đối chiếu CF-01 T02, sửa tên function `rls_auto_enable()`/SECURITY DEFINER và pin event trigger `ensure_rls` đầy đủ, fail-closed với NULL; các compatibility/Auth/full-proof checks khác giữ nguyên. SQL draft mới version riêng, không sửa historical migrations/evidence. Incident preflight vẫn UNCERTAIN; recovery chỉ thiết kế, chưa mở exception/replay hoặc quyền Cloud. T12/Gate W2 chưa COMPLETED; cần owner review và task recovery/read-only approval riêng.

**T10-UI-R1 — 18/11/2026: local completed / pending UI review.** Theo chủ dự án, controlled DRAFT/upload/publish PNG/WebP và React Media Cloud6/6 đã PASS sau C.2; giữ media test post `d8ce8b82-91e0-433a-a9ff-2113922351f3` và hai ảnh, không cleanup. Chỉnh PostImages dùng chung Feed/Detail thành carousel một ảnh/lượt, counter/swipe/keyboard, actions ngay sau gallery; bỏ nút tải lại nhưng giữ auto getPost tối đa3lần/mount, expiry/session guard/placeholder. Frontend77/77, typecheck/lint/build và cả5browser scripts PASS;200ảnh React/24HTML references, còn cảnh báo bundle585.86kB>500kB. Chỉ kiểm thử mock local trong lượt UI-R1; chưa duyệt UI mới hoặc deploy. Không đánh dấu T10/W2 COMPLETED. Xem [bàn giao UI-R1](reports/T10-UI-R1.md).

**T10-UI-R2 — 18/11/2026: local completed / pending review; T10 chưa COMPLETED.** Chủ dự án xác nhận R1 carousel Cloud6/6 PASS. Sửa riêng focus refetch Detail, stable image identity/decode và refresh orchestration: hidden không xin URL; foreground dưới TTL không request; expiry gộp cùng post/phiên và query đang chạy, budget3/mount, giữ slide/optimistic state. Frontend87/87, typecheck/lint/build, cả5browser scripts và diff check PASS;208ảnh React/24HTML references. Mock đo focus dưới TTL +0API/ảnh, expiry foreground +1getPost, query/expiry overlap +1getPost. Native background visibility trong headless chưa mô phỏng đúng, cần review thật; bundle587.62kB>500kB. Không deploy hoặc truy cập fixture Cloud trong lượt này. Xem [báo cáo R2](reports/T10-UI-R2-IMAGE-FOCUS-REFETCH.md).

**T10-D — Final Acceptance 18/11/2026: COMPLETED — PASS.** Sau snapshot UI-R2 local phía trên, chủ dự án xác nhận riêng “Đã kiểm tra sau UI-R2 và PASS” cho đổi tab dưới TTL/refresh sau TTL/giữ slide. Điều kiện manual UI-R2 đã đáp ứng; pending trong các ghi chú A/R1/C.1-A/UI-R2 là lịch sử của từng lượt. Nghiệm thu theo [báo cáo cuối T10](reports/T10-STATUS-REPORT.md); giữ post/hai objects, không cleanup. Không triển khai T11 hoặc nghiệm thu toàn W2/Prototype trong lượt này.

**T10-C.1-A — 18/11/2026: runner local completed / pending review; T10 chưa COMPLETED.** Theo xác nhận của chủ dự án, UI review6/6, bucket private, migration R1/catalog/security, deployment và manual read-only smoke A/B6/6 đã đạt sau snapshot T10-A trong bảng. C.1-A không gọi lại Cloud. Runner riêng có smoke mặc định, draft-write và publish-write với cờ độc lập, exact baseline/actor/object scope, write-ahead journal và SQL/Storage checkpoints. Publish mặc định BLOCKED khi chưa có quyết định giữ fixture được duyệt riêng: deletePost chưa triển khai và trigger chặn DELETE image metadata PUBLISHED. Không automatic cleanup hoặc nghiệm thu W2/Prototype. Xem [bàn giao C.1-A](reports/T10-C1-A-RUNNER.md); các giới hạn Cloud/token expiry/races/recovery và AUTH-ALIAS-001 vẫn mở.

### UI-V2 — Post-T08 / Pre-T09 — COMPLETED / PASS (17/11/2026)

Task giao diện riêng, hỗ trợ US-03/US-04/US-05/US-07 và giữ Auth/Profile US-01/US-02. T01–T08 giữ nguyên nghiệm thu; ghi chú V2 chưa tích hợp ở snapshot T08 là trạng thái trước task này. HTML V2 là approved visual reference, không thay API/behavior contract hoặc tự hoàn tất W2/Prototype.

| Giai đoạn | Trạng thái và bằng chứng |
|---|---|
| UI-V2-A React integration | **PASS.** Feed/PostCard/Detail/Comments/Compose và shell Cá nhân chuyển V2; Auth T05 giữ appearance, business/API/DTO không đổi. Frontend54/54 tests, lint/typecheck/build và ba browser scripts PASS;76 ảnh React +24 ảnh HTML reference tại360/390/768/1280px dark/light. Theo [báo cáo A](reports/UI-V2-A-IMPLEMENTATION.md), không chạy lại trong lượt chốt. |
| UI-V2-B.1 Manual visual review | **6/6 PASS — chủ dự án xác nhận:** Feed desktop/mobile, PostCard/tương tác, Detail/Comments, responsive composer, Create Post/Profile/Auth/theme. |
| UI-V2-B.2 Cloud read-only regression | **6/6 PASS — chủ dự án xác nhận trên TheOU-dev:** A/B sử dụng React V2, đọc Feed/Detail, privacy/ownership/session isolation, navigation/theme; không phát hiện regression trong checklist. Không phải agent chạy lại Cloud E2E; không có SQL baseline trước/sau mới trong lượt chốt. |
| UI-V2-C Documentation closure | **COMPLETED — PASS (17/11/2026).** Báo cáo cuối/conventions/kế hoạch đồng bộ, diff check đạt; không sửa source hoặc truy cập Cloud. Xem [nghiệm thu UI-V2](reports/UI-V2-STATUS-REPORT.md). |

Giới hạn: browser automated dùng API giả, Cloud regression B.2 là manual chỉ đọc; chưa nghiệm thu lại Cloud writes hoặc đầy đủ bàn phím iOS/Android/safe-area/screen reader thật. Recovery sau reload/rời Composer, HOT không snapshot, bundle JS569.25kB (>500kB), rate limiting/chống spam/performance và AUTH-ALIAS-001 còn mở. Đây là snapshot nghiệm thu UI-V2 trước T09, không vote/repost/comment reaction giả. **UI-V2 COMPLETED — PASS.** T09-A upvote local được theo dõi riêng ở dòng T09; T10 chưa triển khai. Không suy ra toàn W2/Prototype đã hoàn thành hoặc tự thay đổi hai posts/hai comments được giữ lại.

### W3 — Moderation + abuse prevention

| ID | Công việc | Kết quả |
|---|---|---|
| T14 | API/UI report bài/comment, chặn báo trùng | Report vào queue, không tự ẩn |
| T15 | Admin reports, quyết định gỡ/bỏ qua, audit và ban user | Có luồng xử lý đầy đủ |
| T16 | Rate limit theo actor/action (ngưỡng cấu hình trong tài liệu 05), chống spam và payload bất thường | Trả 429 nhất quán; kiểm thử concurrency |
| T17 | Quy trình dọn draft/ảnh orphan, quy tắc lưu trữ và xử lý nội dung khẩn | Không tích tụ tài nguyên vô hạn |
| T18 | Test xâm nhập mức cơ bản/authorization/cross-account | Không có lỗ hổng nghiêm trọng đã biết |

### W4 — Hoàn thiện UX + mở MVP beta

| ID | Công việc | Kết quả |
|---|---|---|
| T19 | Hoàn thiện loading/error/empty, OTP, retry, cache/feed pagination | Sử dụng ổn trên mobile |
| T20 | Tối ưu ảnh, đo performance và sửa truy vấn chậm | Có số đo ban đầu, không tối ưu mù |
| T21 | Nội quy cộng đồng, quyền riêng tư, disclaimer, kênh báo vi phạm | Sẵn sàng giới thiệu độc lập |
| T22 | Regression toàn bộ user stories và security matrix | Bộ test pass |
| T23 | Chuẩn bị beta kín, giám sát email/Storage/function errors | Có checklist vận hành và rollback |

## 3. Prototype Acceptance Test — E2E-001

**T12-C.2-R4 — 19/11/2026: LOCAL READY / PENDING OWNER REVIEW.** [Incident recovery implementation](reports/T12-C2-R4-INCIDENT-RECOVERY-IMPLEMENTATION.md) tách approval fresh read-only evidence, immutable resolution và follow-up một lần cho đúng journal/hash đã pin. Guard mặc định vẫn chặn UNCERTAIN; không sửa original journal hoặc historical evidence. Chưa chạy Cloud, tạo receipt thật hoặc mở quyền Auth/fixtures/ADMIN/moderation; follow-up cần owner approval mới, durable claim và hai fresh full-proof snapshots. T12/Gate W2 chưa COMPLETED.

### Tiền điều kiện

- Tài khoản A và B là **hai email OU khác nhau**, đã đăng ký mật khẩu và xác minh email bằng OTP; đăng nhập bằng email + mật khẩu.
- Một tài khoản Admin được cấp quyền từ DB, không tự gán quyền qua payload.
- Database staging mới, seed hợp lệ, không dùng dữ liệu cá nhân thật ngoài test account được đồng ý.

### Checklist

- [ ] 01. A đăng nhập email + mật khẩu, không yêu cầu OTP, vào `/`.
- [ ] 02. A đăng bài ẩn danh tag `CONFESSION` có 1 ảnh; publish thành công.
- [ ] 03. B đăng nhập và thấy bài trong feed `Mới nhất`.
- [ ] 04. B upvote một lần; count đúng; upvote lại không làm tăng trùng.
- [ ] 05. B bình luận; A trả lời trong cùng thread với nhãn `Chủ bài`.
- [ ] 06. B lọc theo tag và xem bài trong `Nổi bật 24h`; mọi bài tuân thủ quy tắc sắp xếp.
- [ ] 07. B không thể truy ra email/MSSV/`author_id` của A qua UI, DTO, URL ảnh hay Data API.
- [ ] 08. A xóa bài; B không còn xem được; admin có thể ẩn một bài khác với audit.
- [ ] 09. Email ngoài OU, người chưa login, user banned và người thường gọi admin action đều bị chặn.
- [ ] 10. Thử 2 ảnh hợp lệ, ảnh sai định dạng, upload lỗi giữa chừng và timeout: app không bị treo/đăng trùng.

**Tiêu chí PASS:** toàn bộ checklist + test API permission & RLS/grants đều pass. Nếu thiếu 1 tiêu chí, báo Prototype đang thiếu hạng mục và có bug list, không xem là "đã hoàn thiện".

## 4. Kiểm thử cần có

### Unit
- Validate domain email, tags, body length, nickname, contact URL allowlist.
- Map raw DB row → `PostPublic` và `CommentPublic` phải là allowlist (không serialize identity).
- Xử lý cursor và thời gian 24h; lỗi OTP/Edge trả message an toàn.

### Integration
- Auth: signup không session trước xác minh; đúng mật khẩu vẫn bị chặn khi chưa xác minh; OTP signup sai/đúng; login mật khẩu sai/đúng không gửi OTP; Gmail signUp bị hook từ chối; logout dọn session.
- `createPost` + `publishPost` + upload 2 ảnh, tính trạng thái draft/published đúng.
- Vote atomic với 2 request đồng thời; createPost/createComment retry bằng idempotency key.
- `adminHideContent` chặn non-admin và ghi audit.
- Kiểm tra grants/RLS bằng cả `anon` và `authenticated`; không có direct raw-table API.
- Banned account không được gọi mọi business action.

### End-to-end
- Chrome desktop, mobile viewport 390px; ít nhất 2 tài khoản riêng.
- Kiểm thử timeout, mạng chậm, session expire, ảnh hết signed URL, lỗi gửi mail.
- Kiểm thử không lộ định danh trong DevTools Network của người xem khác.

### Kiểm thử riêng tư theo thứ tự ưu tiên

1. Thử lấy `.from('posts').select('*')` trực tiếp bằng publishable key + JWT người thường.
2. Kiểm tra JSON feed/getPost/getComments/image không có các field cấm.
3. Thử lấy ảnh không JWT; thử signed URL sau khi hết hạn.
4. Thử xóa bài người khác, đổi role, gửi payload `authorId` giả.
5. Thử lợi dụng contact URL/tag để lộ danh tính trong chế độ ẩn danh.

## 5. Definition of Done cho từng task

- Code theo interface & tài liệu, có migration khi đổi DB.
- Có validation client + server; auth/ownership/role nếu liên quan.
- Có trạng thái UI lỗi/tải/trống nếu có giao diện.
- Có test đúng lớp và kết quả chạy ghi lại.
- Không có secret trong git; không lộ identity qua API.
- Cập nhật tài liệu nếu thay đổi behavior hoặc contract.
- Có báo cáo Codex bằng tiếng Việt: đã làm, test đã chạy, chưa hoàn thành, rủi ro.

## 6. Rủi ro tiến độ và phương án xử lý

| Tình huống | Quyết định |
|---|---|
| SMTP không gửi được tới OU | Ưu tiên khắc phục provider; không dùng bypass OU auth khi staging có người thật |
| Tài khoản OU không có người test | Test DB T02 dùng tài khoản Auth giả trên Cloud dev sau phê duyệt; không gửi mail, không coi là test domain OU/OTP/E2E. Không tắt hook T03 để chạy test |
| Ảnh làm trễ W2 | Giữ đúng luồng upload an toàn, báo thiếu một acceptance criterion; không dùng public bucket để chữa cháy |
| Bảo mật ẩn danh chưa pass | Không mời người dùng mới; sửa trước tính năng/đẹp giao diện |
| Moderation chưa có UI W2 | Không mở beta công khai; tối thiểu admin phải gỡ được nội dung trên staging |
| Scope creep từ tính năng chat/follow | Đưa vào backlog sau beta, không đưa vào 4 tuần |

## 7. Lệnh và workflow đề xuất

```bash
cd frontend
npm ci
npm run lint
npm run typecheck
npm run test
npm run build
# Kiểm tra DB offline: cd ../supabase && npm ci && npm run typecheck && npm test
# Không chạy supabase start/db reset. Cloud dry-run/push/test chỉ sau phê duyệt.
```

Các script frontend khai báo trong `frontend/package.json`. Cần điền `frontend/.env.local` theo `.env.example` trước dev/build; CI frontend dùng cấu hình công khai giả. Workflow `.github/workflows/database.yml` chạy typecheck và PostgreSQL offline bằng PGlite, không có credentials Cloud. Không coi workflow là bằng chứng CI đã chạy trên GitHub hoặc kiểm thử Cloud đã đạt. Quy trình được phê duyệt và lệnh CLI v3 nằm trong `supabase/README.md`.

## 8. Báo cáo nghiệm thu mỗi tuần (mẫu)

```text
Tuần: W?
Đã hoàn thành: [Task IDs]
Đang thiếu: [Task IDs + lý do]
Test đã chạy: [Tên / pass / fail]
Vấn đề bảo mật: [Không / mô tả + trạng thái]
Link staging: [URL nếu có]
Quyết định tuần tới: [Tối đa 3 ưu tiên]
```

**Không ép thời hạn bằng cách bỏ bảo mật, domain verification hoặc moderation.** Một Prototype giới hạn người dùng và đúng luồng có giá trị hơn một app nhiều tính năng nhưng rò danh tính.
