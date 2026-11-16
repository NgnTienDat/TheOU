# TheOU — Supabase Database, Auth và Social API

## T04-A — Social API local, chờ review

**Trạng thái mới nhất:** chủ dự án đã deploy social-api, getMe hai lần PASS. Runner đã sửa allowlist JWT cho body code chuỗi/sb-error-code, kiểm tra header/body và session không đổi; offline 82/82 PASS. Chạy lại `npm.cmd run auth:manual -- get-me`, không cần redeploy cho sửa runner. Xem mục cuối [báo cáo T04-B.1](../docs/reports/T04-B1-RUNNER.md); phần T04-A/B.1 dưới đây là snapshot trước deployment.

`functions/social-api/` có guard JWT/OU/confirmed/ACTIVE, error wrapper, CORS và duy nhất action `getMe`. Chưa deploy hoặc gọi Edge trên Cloud; không có migration mới. Xem [bàn giao T04-A](../docs/reports/T04-A-IMPLEMENTATION.md) để review kiến trúc, kết quả tests và checklist T04-B.

Trong thư mục `supabase/`:

```powershell
npm.cmd run typecheck
npm.cmd test
# Có Deno 2.9.6 trên PATH:
npm.cmd run typecheck:edge
npm.cmd run lint:edge
deno fmt --check --config functions/social-api/deno.json functions/social-api
```

Nếu chưa cài Deno, thay `deno` bằng `npx.cmd --yes deno@2.9.6` để chạy công cụ tạm qua npm cache; không thêm dependency dự án. `deno.json` pin cùng SDK 2.119.0 đang có; `deno.lock` khóa dependency của runtime Edge. Tests Node chạy HTTP handler bằng Request/Response và SDK với fetch giả lập, không kết nối Cloud.

Edge đọc `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` do Cloud cung cấp. Cấu hình thêm `THEOU_PUBLISHABLE_KEY` và `THEOU_ALLOWED_ORIGINS` theo `functions/.env.example` khi T04-B được phê duyệt; không tự đọc `.env.auth.local`/`.env.test.local`, không đẩy các file đó thành Edge secrets. Key đặc quyền chỉ dùng trong client DB riêng sau bước xác minh Auth/email. Giữ `verify_jwt = true`, không dùng `--no-verify-jwt`. Không push toàn bộ `config.toml`: phần Auth local vẫn là scaffold khác Cloud.

## T04-B.1 — Manual runner get-me (local, chờ review)

Đã thêm mode `get-me` dùng cùng `.env.auth.local`, guard TheOU-dev, publishable client và nhập email/password ẩn của T03. **Sau review, cấu hình secrets và deploy riêng**, chủ dự án chạy từ supabase/:

```powershell
npm.cmd run auth:manual -- get-me
```

Mode đăng nhập account OU đã có, kiểm tra getMe/DTO/nickname hai lần, thiếu/sai JWT và validation lỗi, rồi luôn logout/session null. Handler UNAUTHENTICATED/401 không cần top-level code hoặc sb-error-code; gateway dùng allowlist và kiểm tra header/body phù hợp request. Malformed payload/action lạ phải VALIDATION_ERROR/400. Negative requests thiếu/sai JWT dùng fetch riêng, credentials=omit, không nhận token thật từ SDK; session/token/user ID ban đầu phải giữ nguyên. Không suy ra có session chỉ từ Set-Cookie. Không in raw response/identity/token. Lần gọi đầu có thể tạo profile; runner giữ profile, không tạo/xóa user hoặc sửa status/role. Sau sửa regression, typecheck và 87/87 offline tests PASS; chưa chạy lại Cloud. Xem [bàn giao T04-B.1](../docs/reports/T04-B1-RUNNER.md).

## T04-B.7 — Runner Cloud BANNED/ADMIN và concurrent profile

Đã chuẩn bị `npm.cmd run test:t04-cloud`, dùng `.env.test.local` và cờ riêng `THEOU_ALLOW_T04_CLOUD_TESTS=theou-dev`, tái sử dụng URL/ref/publishable/secret key T02. Không phụ thuộc Gmail hoặc cờ T02; không tắt hook OU. Runner tạo ba Auth fixture OU bằng Admin API, kiểm tra BANNED/ADMIN bằng cùng JWT và 10 getMe đồng thời, rồi cleanup đúng UUID và đối chiếu baseline. Chưa chạy Cloud; chỉ chạy sau review. Manifest recovery local được gitignore; khi lỗi, dùng `npm.cmd run test:t04-cloud -- --cleanup <runId>` theo [hướng dẫn B.7](../docs/reports/T04-B7-SECURITY-TEST.md). Typecheck và 99/99 offline tests PASS; không sửa source Edge hoặc migrations.

## T02 — Database Schema & Security

**Trạng thái 15/11/2026: T02 COMPLETED.** Migration/catalog đạt, offline 22/22 PASS; chủ dự án xác nhận Cloud integration 8/8 PASS, 0 FAIL. Cleanup đã xác minh read-only: không còn Auth users/identities T02, chín bảng rỗng. Xem [báo cáo nghiệm thu](../docs/reports/T02-STATUS-REPORT.md).

T02 thuộc W1/Prototype, làm nền tảng cho US-02–US-10 và cấu trúc dữ liệu US-11–US-13. T02 không triển khai Authentication UI hoặc Edge Function nghiệp vụ; T04-A thêm foundation Edge local. Không dùng Docker/Supabase Local Stack hoặc tạo schema thủ công trên Dashboard.

## T03 — Authentication Foundation (COMPLETED)

**Nghiệm thu 16/11/2026:** đăng ký email OU + mật khẩu → OTP 6 số xác minh email; đăng nhập email + mật khẩu, không yêu cầu OTP. Passwordless server-side và password login regression đã PASS theo chủ dự án; signup/OTP regression sau đổi settings chuyển T05 khi có OU account mới. Quên/đổi mật khẩu chưa thuộc T03. Giữ nguyên T02 và migration hook `20261115050213_t03_before_user_created_hook.sql` đã triển khai Cloud. Xem [nghiệm thu T03](../docs/reports/T03-STATUS-REPORT.md).

Template `templates/email-otp.html` chỉ dùng cho **Confirm signup**, subject `Xác minh đăng ký TheOU`, OTP 6 số/600 giây. Không còn hướng dẫn dùng template này cho Magic Link. Confirm email phải bật; SMTP, template và chính sách mật khẩu cần được chủ dự án kiểm tra trên Dashboard sau review, không tự đồng bộ `config.toml`.

Giữ `.env.auth.local` đang có; nếu chưa có thì sao chép `.env.example`. Nhóm manual chỉ cần THEOU_ALLOW_AUTH_TESTS=theou-dev, URL đúng dev và publishable key. Không lưu email cá nhân, mật khẩu, OTP hoặc secret key vào env. Runner nạp file bằng Node `--env-file=.env.auth.local`, nhập email/mật khẩu/OTP ẩn, không giữ history hoặc persist session.

```powershell
# Chỉ chủ dự án tự chạy sau review và cho phép gửi email:
npm.cmd run auth:manual -- signup
# Chỉ dùng khi đã có signup đang chờ và OTP còn hạn; không gửi email mới:
npm.cmd run auth:manual -- verify-signup
# Dùng cùng OU account đã xác minh và mật khẩu đã đăng ký:
npm.cmd run auth:manual -- login
# Gmail do mình quản lý + mật khẩu test riêng; không cần nhận OTP Gmail:
npm.cmd run auth:manual -- reject
# OU account đã tồn tại, sau khi tắt Enable magic links and email OTP:
npm.cmd run auth:manual -- passwordless-denied
```

`signup` kiểm tra đúng mật khẩu vẫn bị `email_not_confirmed` trước OTP, rồi tự thử một mã sai trước mã đúng. `verify-signup` tiếp tục bước OTP bị gián đoạn. `login` tự thử một mật khẩu sai trước mật khẩu đúng, không gọi API gửi hoặc xác minh OTP. Mỗi mode logout local và kiểm tra session null; chỉ có dòng `PASS: hoàn tất kiểm tra ...` khi cả mode đạt.

`passwordless-denied` nhập ẩn **cùng email OU đã đăng nhập password thành công**, không hỏi password/OTP. Dùng publishable key đã được guard kiểm tra, gọi trực tiếp `signInWithOtp({ email, options: { shouldCreateUser: false } })`. PASS với `otp_disabled` (loại trường hợp `Signups not allowed for otp`) hoặc `email_provider_disabled` kèm đúng thông báo `Login with magic link is disabled`; phải HTTP 4xx trừ 429 và không session trước/sau. Supabase dùng chung email_provider_disabled cho tắt Email provider và tắt riêng Magic Link, nên không chấp nhận chỉ code/422 hoặc thông báo chung. Xem [nhánh MagicLink chính thức](https://github.com/supabase/auth/blob/master/internal/api/magic_link.go). SMTP/mạng/rate limit, tắt Email provider chung và user không tồn tại không đạt. Người chạy xác nhận account trước; runner không dùng admin, không tạo user hoặc đổi settings. Nếu passwordless thực tế chưa tắt, request có thể gửi thư và sẽ FAIL; dừng, không nhập OTP hoặc thử liên tục.

Sau sửa nhận diện lỗi MagicLink, typecheck và **47/47 offline tests T03 PASS**. Chủ dự án đã cung cấp log `magicLinkDisabled=true`, email_provider_disabled/422, không session và PASS toàn mode; password login regression cũng PASS trên cấu hình hiện tại. Không suy ra toàn bộ Email Provider bị tắt từ mã lỗi chung. Không in response thô/email/token; code lạ/thiếu hiển thị unknown_or_missing. Signup/OTP chưa kiểm thử lại sau đổi settings; theo dõi tại T05.

Một OU account đủ cho luồng mới, nhưng account đã tạo bằng OTP trước đây có thể chưa có mật khẩu. Không dùng đăng ký lại để đặt mật khẩu, tự xóa account hoặc tự thêm luồng reset/updateUser; cần quyết định chuyển đổi riêng trước T03-B. Mode `login-existing` và `wrong-otp` cũ được thay bằng các lệnh phía trên. Đọc [T03-A Implementation](../docs/reports/T03-A-IMPLEMENTATION.md) để xem tiền điều kiện, kết quả kỳ vọng và điểm dừng khi có lỗi.

Sau khi bật hook, giữ `THEOU_OU_HOOK_ENABLED=true` trong `.env.test.local`: runner T02 dừng trước API. Đây là khai báo vận hành, không tự truy vấn Dashboard. Không dùng Admin API/Gmail T02 làm bằng chứng domain, không tắt hook để chạy lại test. Kết quả 41/41 sau đổi flow và Gmail reject của runner OTP cũ là lịch sử; nghiệm thu mới nhất ở báo cáo T03.

## Project và phạm vi migration

Đã kiểm tra chỉ đọc bằng CLI **3.1.0**: `TheOU-dev`, ref `puhkisyehspcmgzerutm`, `linked: true`, `ACTIVE_HEALTHY`. Tên này tương ứng môi trường `theou-dev` trong yêu cầu. Trạng thái có thể đổi; phải kiểm tra lại trước Giai đoạn B. `config.toml` là cấu hình CLI, không phải bằng chứng liên kết; `.temp/` bị Git bỏ qua.

Một migration do `supabase migration new t02_schema_security` tạo:

`migrations/20261113170214_t02_schema_security.sql`

Timestamp do CLI sinh theo UTC. Migration có transaction, dùng CREATE mới để thất bại rõ ràng nếu trùng schema/bảng; không dùng IF NOT EXISTS che giấu schema sai. Chỉ áp dụng một lần theo migration history; tái tạo bằng chạy từ đầu trên database sạch có Auth/roles Supabase. Không tạo hoặc sửa cấu trúc `auth.users` trên Cloud.

| Bảng | Quan hệ và ràng buộc chính |
|---|---|
| `profiles` | PK/FK `auth.users.id`; nickname 3–30; ACTIVE/BANNED; timestamps |
| `user_roles` | PK `(user_id, role)`; role chỉ ADMIN; user và người cấp là FK Auth |
| `posts` | FK tác giả Auth; tag cố định; body 1–1000 sau trim; trạng thái; unique tác giả/idempotency; ràng buộc danh tính/contact |
| `comments` | FK bài và tác giả; body 1–500; unique tác giả/idempotency; không nested reply |
| `post_votes` | PK `(post_id, user_id)`; mỗi người một vote/bài |
| `post_images` | FK bài; unique bài/vị trí 1–2; lớn hơn 0 byte, tối đa 2 MiB; JPG/PNG/WebP; path dùng UUID bài/ảnh |
| `reports` | FK người báo cáo/người xử lý; unique người báo cáo/target; trạng thái giải quyết nhất quán |
| `moderation_actions` | FK admin; action phù hợp loại target; lý do bắt buộc; audit append-only đối với service-role |
| `rate_limit_counters` | FK actor; PK actor/action/window; count không âm |

Tất cả FK dùng RESTRICT để tránh xóa dây chuyền dữ liệu/audit. Sản phẩm xóa mềm; không tự cascade khi xóa Auth user. `target_id` đa hình của report/audit phải được Edge Function kiểm tra tồn tại và phạm vi; không giả lập một FK không đúng nghĩa.

Indexes gồm feed theo status/thời gian/ID, feed theo tag, comment theo bài/thời gian/ID, hàng đợi report và các FK chưa được index PK/unique bao phủ. Chưa thêm index HOT riêng khi chưa có EXPLAIN. Count và rate-limit chỉ có cấu trúc; transaction/RPC atomic thuộc các task nghiệp vụ.

## Quyền và bảo vệ ẩn danh

| Đường truy cập | 8 bảng CRUD | `moderation_actions` | Helper `theou_private` |
|---|---|---|---|
| `PUBLIC`, `anon` | Không có quyền bảng | Không có quyền | Không có USAGE/EXECUTE |
| JWT A/B/admin (`authenticated`) | Không có quyền bảng, kể cả nội dung của mình | Không có quyền | Không có USAGE/EXECUTE |
| `service_role` ở server | SELECT/INSERT/UPDATE/DELETE | SELECT/INSERT | USAGE/EXECUTE trigger functions |
| Chủ DB `postgres` | Quản trị migration, không dùng làm client ứng dụng | Quản trị DB có thể sửa; cần kiểm soát vận hành | Quản trị DB |

- ENABLE/FORCE RLS trên 9 bảng; restrictive policy `deny_direct_client` từ chối cả USING/WITH CHECK, không có permissive policy cho client. Không cấp TRUNCATE/REFERENCES/TRIGGER cho server ứng dụng.
- Thu hồi grants cũ trên 9 bảng và chặn default privileges mới của role `postgres`. EXECUTE mặc định của PUBLIC cho function phải thu hồi ở phạm vi toàn cục; điều này ảnh hưởng **function tương lai** do postgres tạo ở cả schema khác. Mỗi migration sau phải cấp quyền rõ ràng.
- Trigger SECURITY INVOKER, search_path rỗng, trong schema `theou_private`; chặn đổi ownership, PK và idempotency key, tự đặt `updated_at`. Không có SECURITY DEFINER/public RPC/view mới.
- Danh tính nội bộ vẫn ở `author_id` để server xác định chủ bài. Bài ANONYMOUS không được lưu nickname snapshot/contact. Ảnh chỉ có path UUID bài/ảnh, không UUID tài khoản. Đây không phải biện pháp xóa EXIF (T10).
- `social-api` sau này xác minh JWT/domain/ACTIVE/role/ownership trước khi dùng service-role. DTO dùng allowlist; `authorLabel = 'Chủ bài'` khi author comment bằng author post, chỉ so sánh trong server; không xuất các author UUID hoặc token nối tác giả giữa nhiều bài.

**Mâu thuẫn tầng kiểm thử đã được xử lý theo Architecture:** A không được CRUD raw table của mình. “A được thao tác nội dung của mình” phải qua `social-api`; chưa được thực hiện hoặc chứng minh ở T02. Không mở RLS cho client để đạt sai tiêu chí. Raw DB deny tests, server CRUD tests và ownership API tests là ba việc khác nhau.

## Kiểm tra offline — được phép ở Giai đoạn A

Node.js >=22.18 (CI dùng 24). Từ root:

```powershell
cd supabase
npm ci
npm run typecheck
npm test
```

Dependencies test được pin và có lockfile. Supabase SDK dùng cho test Cloud, TypeScript/@types-node kiểm tra kiểu. **PGlite là dependency test duy nhất thêm để thực thi PostgreSQL SQL trong bộ nhớ** thay vì chỉ dò chuỗi SQL. Không có container, server local, kết nối Cloud hay thay đổi frontend. Bootstrap `auth.users(id)`/roles trong test chỉ là fixture của engine tạm, không phải Supabase Auth thật.

`tests/schema.test.ts` áp dụng migration lên database tạm sạch rồi kiểm tra:

- 9 bảng, RLS ENABLE/FORCE, grants theo bảng/cột, không public view/RPC hoặc SECURITY DEFINER helper.
- Quyền client bị chặn, kể cả khi vô tình thêm permissive policy + grants; service-role CRUD được phép.
- Không đổi chủ sở hữu; FK RESTRICT, idempotency, unique vote/report; giới hạn body, nickname/contact và ảnh.
- Audit service-role chỉ được append; `updated_at`; đầy đủ default privileges cho bảng/sequence mới và phạm vi EXECUTE của function mới, function có sẵn, creator khác.
- Catalog kiểm tra đủ CRUD trên tám bảng; regression test thu hồi từng quyền UPDATE/DELETE trên từng bảng phải bị phát hiện.

`tests/cloud-config.test.ts` kiểm tra cờ xác nhận và ref cố định TheOU-dev `puhkisyehspcmgzerutm`; project khác bị từ chối ngay cả khi env/URL/liên kết CLI cùng khớp. `tests/catalog-check.sql` dùng chung cho engine tạm và kiểm tra chỉ đọc trên Cloud sau này. `tests/preflight.sql` chỉ đọc metadata trước migration, không cần chín bảng tồn tại.

**Kết quả chạy sau sửa Gmail fixture (15/11/2026):** `npm.cmd run typecheck` đạt; `npm.cmd test` đạt **22/22** (bao gồm một test cha), không fail/skip/todo. Có test cấu hình Gmail và test Node nạp env với dữ liệu giả trong thư mục tạm. Không thêm dependency hoặc thay migration. Workflow `.github/workflows/database.yml` chỉ chạy offline, không giữ secrets hoặc gọi test Cloud. Chưa chạy workflow trên GitHub.

## Integration Cloud — 8/8 PASS, 0 FAIL

Chủ dự án xác nhận lần chạy sau sửa fixture đạt 8/8 PASS, 0 FAIL. Agent đã kiểm tra cleanup read-only ngày 15/11/2026: Auth users/identities T02 = 0, cả chín bảng = 0. Không chạy lại suite trong lượt nghiệm thu. Lỗi `validation_failed` ở lần đầu được giữ làm lịch sử trong báo cáo deployment.

`tests/cloud.integration.ts` không khớp glob `*.test.ts`, chỉ chạy bằng lệnh riêng sau phê duyệt. Trước mọi request, runner yêu cầu `THEOU_ALLOW_CLOUD_TESTS=theou-dev`, ref trong env và `.temp/project-ref` đều bằng ref dev cố định trong `cloud-config.ts`, URL trùng ref và hai loại key đúng vai trò. Project ref không phải credential; đổi project dev phải review lại hằng số và test.

- Secret key chỉ dùng trong Node để dựng/dọn fixture và kiểm tra server grants/constraints; không giả lập A/B.
- Từ Gmail gốc `THEOU_TEST_EMAIL_BASE` do người chạy quản lý, tạo hai Auth user với alias `username+theou-t02-{runId}-{a|b}@gmail.com`. Kiểm tra Gmail username 6–30 ký tự, không có +alias/dấu chấm liên tiếp trước khi khởi tạo SDK. Run ID gồm 20 ký tự hex để giữ local-part tối đa 63 ký tự. Vẫn email_confirm bằng Admin API, password ngẫu nhiên, đăng nhập bằng publishable key và getUser; cleanup theo user ID. Đây chỉ là test JWT/DB, **không xác nhận domain OU hoặc OTP**.
- Guest/A/B thử SELECT/INSERT/UPDATE/DELETE trên cả 9 bảng, đọc `author_id`, đổi chủ bài và tự cấp ADMIN. Phải nhận `42501`, không có data; không coi bảng thiếu, lỗi mạng hoặc 404 là quyền đã an toàn.
- Server tạo fixture và kiểm tra FK/unique/idempotency, ownership trigger, validation, audit không UPDATE/DELETE và CRUD được phép.
- Server đọc fixture trên đủ tám bảng CRUD, kiểm tra một dòng và các field đã seed; không dùng LIMIT 0. Có fixture role ADMIN cho user A giả và cleanup theo user_id. Không seed audit trên Cloud; quyền audit được kiểm tra bằng catalog, INSERT hợp lệ được thực thi offline.
- `t.after` đăng xuất, dọn dữ liệu/user của chính lượt chạy. Theo dõi cả ID bài insert thử để dọn nếu constraint bị thiếu. Không đụng user có sẵn, không reset/truncate. Không tạo audit fixture trên Cloud vì service-role cố ý không có quyền xóa audit; kiểm tra append audit thực hiện offline.

**Giới hạn:** dọn dữ liệu là best effort nếu mất mạng/process bị kill hoặc schema sai; test báo lỗi nếu cleanup thất bại. Không tự nới grants để cleanup. Nếu xảy ra, review các Auth user theo runId trong alias và xóa dữ liệu test có phạm vi sau khi được duyệt; bộ lọc `.invalid` trong các báo cáo cũ chỉ áp dụng lượt test cũ. Sau T03, không dùng suite Admin API/Gmail để nghiệm thu domain: đường Admin có thể không gọi hook. Runner có chốt khai báo trạng thái hook để dừng; xem hướng dẫn T03-A, không tắt hook hoặc giả JWT.

T04-A đã có guard/getMe và tests HTTP offline cho BANNED/email ngoài OU; chưa kiểm thử Edge Cloud. Ownership nội dung, DTO khi đọc nhiều bài ẩn danh, OP, atomic counts, idempotent response và signed Storage thuộc T06/T08–T11/T16; chưa có API tương ứng, không được gắn nhãn pass khi test DB đạt.

## Giai đoạn B — chỉ sau phê duyệt của chủ dự án

Preflight/dry-run trước triển khai đã xác nhận đúng TheOU-dev và duy nhất migration T02. Sau phê duyệt, đã push thành công `20261113170214_t02_schema_security.sql`, history Cloud ghi version tương ứng, không seed/custom roles/Vault update. Catalog đạt; Cloud integration sau sửa fixture đạt 8/8 theo xác nhận chủ dự án.

Catalog gate chỉ ngoại lệ cho event trigger đúng signature, owner, return type, language, search_path, fingerprint body và binding đã review. Public functions/views khác vẫn bị chặn. Fixture `tests/fixtures/rls-auto-enable.sql` chỉ dùng offline, không deploy lên Cloud.

**Các lệnh dưới đây là quy trình tham khảo; deployment đã thực hiện và T02 đã nghiệm thu.** Test ghi Cloud cho lần kiểm tra tiếp theo cần nằm trong phạm vi được phê duyệt. Đối chiếu `--help` khi đổi phiên bản; CLI v3 mặc định trỏ local nên luôn ghi rõ remote. Không đưa password vào dòng lệnh/history; dùng cơ chế đăng nhập CLI hoặc env riêng.

Từ root, trước tiên kiểm tra lại project và migration history:

```powershell
npx supabase@3.1.0 projects list
$devProjectRef = 'puhkisyehspcmgzerutm'
npx supabase@3.1.0 db query --remote=$devProjectRef --read-only --file supabase/tests/preflight.sql
# Chỉ tiếp tục nếu preflight đạt:
npx supabase@3.1.0 migration list --remote=$devProjectRef
npx supabase@3.1.0 db push --remote=$devProjectRef --dry-run --skip-vault
```

Nếu liên kết không trùng TheOU-dev, dừng; chỉ dùng `supabase link` sau khi người vận hành xác nhận đúng ref. Nếu remote có bảng/migration trùng tên hoặc khác lịch sử, không repair/reset/drop tự động. Dry-run chỉ cho biết kế hoạch, không thay thế chạy SQL hoặc kiểm thử grants.

Sau khi chủ dự án duyệt kế hoạch và tác động default privileges:

```powershell
npx supabase@3.1.0 db push --remote=$devProjectRef --skip-vault
# Catalog chỉ đọc nhưng chứa DO; CLI 3.1.0 không nhận DO với --read-only.
# Chỉ chạy sau phê duyệt Giai đoạn B, xem SQL và xác nhận prompt của CLI:
npx supabase@3.1.0 db query --remote=$devProjectRef --file supabase/tests/catalog-check.sql
```

Chỉ sau khi migration/catalog đúng và được phép **tạo + xóa fixture Cloud**, sao chép `supabase/.env.example` thành `supabase/.env.test.local` nếu file chưa có, điền ref/URL/key và bật cờ xác nhận. File này bị Git bỏ qua, không gửi vào chat hoặc frontend.

```powershell
cd supabase
npm run test:cloud
```

Script trên chạy `node --env-file=.env.test.local --test tests/cloud.integration.ts` trong `supabase/`; Node nạp file nhờ cờ `--env-file`, không tự động tìm file này. Điền thêm `THEOU_TEST_EMAIL_BASE` bằng Gmail gốc trong file env riêng; không commit email thật hoặc keys.

Password fixture đã đổi từ hai UUID (78 byte, vượt giới hạn 72 byte của Supabase Auth) sang một UUID kèm `-Aa1!` (41 byte), có assertion trước request. Giữ tính ngẫu nhiên, email_confirm và cleanup theo user ID. Chủ dự án đã xác nhận suite Cloud sau sửa đạt 8/8.

Không chạy `supabase start`, `db reset`, SQL Editor hoặc test ghi Cloud tự động. Migration lỗi trong transaction sẽ rollback; sau khi đã commit, sửa bằng migration bổ sung có review, không tự drop/reset để quay lui.

**Điểm dừng hiện tại:** T02 COMPLETED; đã cập nhật tài liệu sau xác minh cleanup read-only. Không triển khai T03 trong lượt này. Các lệnh preview/deployment phía trên là tham khảo, không push lại migration đã áp dụng.

Nguồn đối chiếu: [Supabase RLS](https://supabase.com/docs/guides/database/postgres/row-level-security), [grants và default privileges](https://supabase.com/docs/guides/api/securing-your-api), [CLI v3](https://supabase.com/changelog/supabase-cli-v3), [PGlite](https://pglite.dev/docs/).
