# Public guest feed — release candidate review

**23/11/2026. RC REVIEW READY / PENDING OWNER COMMIT.** B1 TheOU-dev owner-confirmed manual PASS; B2 staging chưa deploy/acceptance trong lượt này. Chỉ review Git/source và chuẩn bị lệnh; không stage, commit, push, deploy hoặc sửa Cloud.

## 1. Kết luận và source correspondence

Đã đối chiếu [Phase A](PUBLIC-GUEST-FEED-LOCAL.md), [B1 acceptance](PUBLIC-GUEST-FEED-DEV-ACCEPTANCE.md), [B2 plan](PUBLIC-GUEST-FEED-STAGING-PROMOTION.md), README/docs01–07 và tracked diff/untracked implementation. Git đang ở **`update/get-feed`**, HEAD **`abd0c8783ff6ee26e7a3d9c78f94bb97e93bd27a`**, index rỗng; branch chưa có upstream. Không đổi branch/reset hoặc thay source trong task này.

**Source thuộc manifest B1: MATCH**, 110 files, SHA-256 **`81e621e286c2046134478ccc702aad31da9df64f7e40908a452fb3bc2d96714c`**. Thuật toán/phạm vi chính xác theo B1: sorted relative POSIX paths → raw-file SHA-256, digest của `JSON.stringify(map)`. Không có source drift trong tập này. `public-feed.verify_jwt=false`, `social-api.verify_jwt=true` xác nhận lại từ config; scope public mặc định rỗng, không migration/RLS/grants change.

Giới hạn provenance vẫn giữ: B1 là owner-confirmed manual PASS; manifest là local code/config/test pin, không phải hash bundle đã download từ dev. Backend test/helper/tsconfig, env example và documentation không được bao phủ đầy đủ bởi manifest110; đã review diff riêng, đúng scope Phase A/B1/B2. Không tự tuyên bố đã xác minh độc lập deployed bundle. Owner đối chiếu bản đã deploy dev với release SHA cuối trước B2.

**Release payload: 37 files = 30 tracked modifications + 7 files mới**, cộng **4 reports** được chọn riêng bên dưới → đề xuất commit **41 files**. Digest bổ sung của map sorted path→raw SHA cho 37 payload files hiện tại: **`f831c207c70309878c23342813dc930fb11900af474ae7d5af4eea816353688d`**. Digest này pin cả các file ngoài manifest110, không thay bằng chứng B1. Không tính report này vào hash tự tham chiếu. Git có cảnh báo LF→CRLF; raw-byte digest không đồng nghĩa Git tree hash sau EOL normalization.

## 2. File nào thuộc release

Danh sách `$rcFiles` mục4 là **allowlist chính xác 37 files**, không dùng thư mục/glob khi stage:

| Nhóm | Files / lý do |
|---|---|
| Requirements/documentation | README + docs01–07: guest scope, DTO/JWT, routing, historical Phase A và B1/B2 status |
| Frontend runtime | App/AuthProvider/AuthRoutes, FeedPage/PostCard/feed-query/useFeed, ProfilePage/AppFrame và **adapter public-feed mới**: public route/audience cache/read-only UI/logout ordering |
| Browser regression | Cả7 UI scripts: mock public-feed, guest route/logout, A/B/guest flows; giữ member/privacy/authorization assertions |
| Frontend unit | **`frontend/tests/public-feed.test.ts` mới**: guest DTO/no JWT/credentials/audience isolation |
| Edge runtime/config | **4 files public-feed mới**: handler/index/deno.json/deno.lock; shared post-mapper/service; config.toml và env example rỗng |
| Backend tests/tooling | **`supabase/tests/public-feed.test.ts` mới**, helper post-fixture và tsconfig include/exclude entrypoint mới |
| Evidence/release docs | Ba reports Phase A/B1/B2 và report RC này: force-add **đúng4paths**, vì docs/reports đang ignored |

Không chỉ stage tracked diff: thiếu adapter/handler/index/test/import map/lock mới sẽ làm checkout release không đầy đủ. `frontend/package.json`, package-lock, vercel.json, shared API/Auth helpers và social-api Deno config/lock đã tracked trong HEAD; không có dependency update cần stage. Lock public-feed byte-for-byte bằng lock social-api hiện có, không thêm dependency. Các imports dùng source đã tracked hoặc7file mới được liệt kê. Vercel SPA rewrite hiện có vẫn nằm trong release tree qua HEAD.

## 3. File phải loại trừ

- **`supabase/.gitignore`**: thay đổi riêng của owner, không stage/revert/sửa trong release này.
- **Toàn bộ `supabase/tests/performance/`**: scripts, markdown, test users/sessions, kể cả `test-users.local.json` và `test-sessions.local.json`. Không đọc nội dung hai JSON, không chạy performance scripts.
- `.env.local`, `.env.*.local`, Auth/test env thật, credentials, token/session JSON, `.temp/`, journals/recovery/executable SQL, logs, screenshots/cache, `node_modules/`, `dist/` và `.vercel/` generated files. Không force-add các thư mục hoặc env thật. **`supabase/functions/.env.example` được phép** vì chỉ placeholder rỗng/sample origins, không secret value.

Hai performance JSON local đang xuất hiện **untracked** trong `git status`, không được ignore hiệu quả bởi hai rule owner hiện thêm (rule bắt đầu `/supabase/...` bên trong `supabase/.gitignore` không khớp đường dẫn tương đối của file đó). Đây là lý do cụ thể không dùng `git add .`, `git add -A`, `git add supabase` hoặc force-add rộng. Không sửa ignore rules thay owner trong task này.

## 4. Lệnh owner chốt release commit

Chạy từ repo root bằng PowerShell. Đây là **hướng dẫn chưa thực thi**, chỉ local stage/commit sau review. Nếu branch/HEAD/file set đã đổi, dừng review lại; không reset thay đổi owner.

```powershell
Set-Location -LiteralPath 'D:\Web System Development\TheOU'
$rcGit = @('-c', 'safe.directory=D:/Web System Development/TheOU')
$rcBranch = git @rcGit branch --show-current
$rcHead = git @rcGit rev-parse HEAD
if ($rcBranch -ne 'update/get-feed' -or $rcHead -ne 'abd0c8783ff6ee26e7a3d9c78f94bb97e93bd27a') {
  throw 'Branch/HEAD changed; review release again.'
}
git @rcGit diff --cached --quiet
if ($LASTEXITCODE -ne 0) { throw 'Index is not empty; review existing staged files.' }

$rcFiles = @(
  'README.md'
  'docs/01-PRD.md'
  'docs/02-USER-STORIES.md'
  'docs/03-UI-UX-SPEC.md'
  'docs/04-ARCHITECTURE.md'
  'docs/05-DATABASE-SECURITY.md'
  'docs/06-API-CONTRACT.md'
  'docs/07-IMPLEMENTATION-PLAN.md'
  'frontend/scripts/comments-ui-check.mjs'
  'frontend/scripts/e2e-ui-check.mjs'
  'frontend/scripts/feed-ui-check.mjs'
  'frontend/scripts/media-ui-check.mjs'
  'frontend/scripts/moderation-ui-check.mjs'
  'frontend/scripts/ui-check.mjs'
  'frontend/scripts/votes-ui-check.mjs'
  'frontend/src/app/App.tsx'
  'frontend/src/features/auth/AuthProvider.tsx'
  'frontend/src/features/auth/AuthRoutes.tsx'
  'frontend/src/features/feed/FeedPage.tsx'
  'frontend/src/features/feed/PostCard.tsx'
  'frontend/src/features/feed/feed-query.ts'
  'frontend/src/features/feed/useFeed.ts'
  'frontend/src/features/profile/ProfilePage.tsx'
  'frontend/src/shared/api/public-feed.ts'
  'frontend/src/shared/components/AppFrame.tsx'
  'frontend/tests/public-feed.test.ts'
  'supabase/config.toml'
  'supabase/functions/.env.example'
  'supabase/functions/public-feed/deno.json'
  'supabase/functions/public-feed/deno.lock'
  'supabase/functions/public-feed/handler.ts'
  'supabase/functions/public-feed/index.ts'
  'supabase/functions/social-api/modules/posts/post-mapper.ts'
  'supabase/functions/social-api/modules/posts/post-service.ts'
  'supabase/tests/helpers/post-fixture.ts'
  'supabase/tests/public-feed.test.ts'
  'supabase/tsconfig.json'
)
$rcReports = @(
  'docs/reports/PUBLIC-GUEST-FEED-LOCAL.md'
  'docs/reports/PUBLIC-GUEST-FEED-DEV-ACCEPTANCE.md'
  'docs/reports/PUBLIC-GUEST-FEED-STAGING-PROMOTION.md'
  'docs/reports/PUBLIC-GUEST-FEED-RELEASE-CANDIDATE.md'
)
git @rcGit add -- $rcFiles
if ($LASTEXITCODE -ne 0) { throw 'Stage failed; inspect index, do not commit.' }
git @rcGit add -f -- $rcReports
if ($LASTEXITCODE -ne 0) { throw 'Report stage failed; inspect index, do not commit.' }

$rcExpected = @($rcFiles + $rcReports | Sort-Object)
$rcActual = @(git @rcGit diff --cached --name-only | Sort-Object)
if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect index.' }
if ($rcActual.Count -ne 41 -or (Compare-Object $rcExpected $rcActual)) {
  throw 'Unexpected staged file set; do not commit.'
}
git @rcGit diff --cached --check
if ($LASTEXITCODE -ne 0) { throw 'Staged diff check failed.' }
git @rcGit diff --cached --stat
git @rcGit diff --cached
# Review the staged content above, including all seven new files, before the next command.
```

Sau khi owner review staged content, chạy riêng đoạn commit:

```powershell
git @rcGit commit -m 'feat(feed): add scoped read-only guest feed' -m 'Add a separate public-feed Edge Function with an empty-by-default owner allowlist. Preserve social-api JWT and member authorization, isolate guest caches, and cover routing/privacy/logout regressions. Record owner-confirmed dev acceptance and the staging promotion plan.'
if ($LASTEXITCODE -ne 0) { throw 'Commit failed; inspect result before retry.' }
git @rcGit rev-parse HEAD
git @rcGit show --stat --oneline HEAD
git @rcGit status --short
```

Commit message trên dùng được nguyên văn. Chưa pin trước SHA của commit chưa tồn tại; owner ghi SHA thực sau commit làm release reference. Sau commit, `.gitignore` owner và performance untracked còn trong working tree là **expected**, không yêu cầu clean bằng reset/delete/add-all. Không deploy từ dirty working tree còn các file này; dùng release tree/checkout sạch theo B2. Report screenshots chỉ là local evidence links, không đưa generated screenshots vào commit.

## 5. Push và Vercel auto-deploy

**Không push trong đoạn lệnh trên.** Local commit không tự gửi lên Vercel; Git hooks local không có hook active hoặc custom hooksPath được tìm thấy lúc review. Không có `frontend/.vercel/project.json` local; điều đó không chứng minh Git integration trên Vercel vắng mặt.

`.github/workflows/frontend.yml` chạy checks khi push/PR có frontend changes, dùng dummy build config, không chứa bước Vercel deploy. Tuy nhiên Vercel Git integration hoạt động độc lập với workflow này. Branch chưa có upstream cũng không bảo đảm push mới sẽ không tạo deployment.

Trước bất kỳ push/merge, owner cần đối chiếu Vercel project/team, repo liên kết, Production Branch, branch-domain mappings, Preview/Production/branch-specific environment variables và Auto-assign Custom Production Domains. Push tới branch được theo dõi có thể tạo Preview; Production Branch có thể tự cập nhật domain nếu auto-assignment còn bật. Không đoán `update/get-feed` là Preview hoặc main là Production khi chưa xem Dashboard. Không đổi branch để coi là đã tránh auto-deploy.

B2 ưu tiên staged Production build với domain assignment chưa bật cho bản mới, đúng release SHA và staging URL/key; sau review mới Promote exact deployment. [Vercel environment docs](https://vercel.com/docs/environment-variables) giải thích Production/Preview branch scope; [promotion workflow](https://vercel.com/docs/deployments/promoting-a-deployment) mô tả staged build/manual assignment. Quy trình chi tiết và rollback ở [B2 plan](PUBLIC-GUEST-FEED-STAGING-PROMOTION.md). Task này không truy cập Dashboard/Git remote/Vercel/domain để xác minh settings; chưa có GO push hoặc GO deploy.

## 6. Kiểm tra và GO/NO-GO

| Kiểm tra mới trong RC review | Kết quả |
|---|---|
| Tracked/untracked/full scoped diff | 30 modified +7 new implementation files; owner .gitignore/performance tách riêng |
| Manifest B1 | **110 files MATCH**, digest nguyên trạng |
| JWT config | public-feed=false / social-api=true |
| Import/config/dependency completeness | New adapter/test/4 Edge files/backend test có trong allowlist; existing dependencies/SPA config tracked; public lock=existing lock |
| Secret/config scope | Không env thật/generated artifact trong stage list; env example rỗng; limited private-key/secret-token marker scan PASS trên37files và3reports cũ; không phải chứng nhận tuyệt đối không còn secret |
| Git index/diff/doc checks | Index rỗng, diff check và validation danh sách/lệnh/link kiểm local; không thao tác index |
| Application tests | Không chạy lại trong RC task vì source không đổi:413/413 backend,97/97 frontend,7browser scripts là Phase A history; B1 targeted9/9 và1/1 là lượt trước |

**GO chốt local release commit theo41paths sau owner review.** Candidate local khớp B1 manifest và bao gồm đủ file mới. **Chưa GO execution Phase B2** cho đến khi có commit/artifact SHA cuối được đối chiếu dev, Vercel auto-deploy/environment được owner kiểm, secrets staging scope empty/cursor riêng/origins/JWT/rollback và các approvals trong B2 đầy đủ. Local env staging mismatch ghi ở B1/B2 chưa được sửa hoặc xác minh lại trong RC task; không dùng env đó để build release.

Chỉ tạo report RC này; không sửa implementation, env, journals, historical baseline, ignore rules hoặc performance data. Không Cloud calls/deploy, không stage/commit/push. **STOP: RELEASE CANDIDATE REVIEW READY / PENDING OWNER COMMIT AND B2 APPROVAL.**
