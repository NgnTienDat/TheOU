# Public guest feed — B2 staging promotion plan

**23/11/2026. PLAN READY / PENDING OWNER APPROVAL.** [B1 TheOU-dev](PUBLIC-GUEST-FEED-DEV-ACCEPTANCE.md) đã owner-confirmed manual PASS ba nhóm; **B2 chưa deploy hoặc smoke trong task này**. Không đồng nhất dev PASS với staging PASS, không đóng T13/W2 toàn bộ từ báo cáo này.

| Môi trường | Target |
|---|---|
| Dev, đã nghiệm thu B1 | `puhkisyehspcmgzerutm`; không deploy/thay config dev trong B2 |
| Staging, target duy nhất B2 | `gxsfbzaconeaxwztynpm` / `https://gxsfbzaconeaxwztynpm.supabase.co` |
| Domain public-facing | `https://theou.tech`, đang nối staging **theo owner**, chưa được agent kiểm trên Internet |

## 1. Owner checklist trước triển khai

- Review source candidate/Git pins trong B1, xác nhận đúng implementation đã test trên dev. Owner chuẩn bị release commit/artifact riêng sau task này, gồm untracked implementation cần thiết; không lấy branch name hoặc HEAD cũ thay exact artifact. Không đưa env, executable SQL, logs, journals hoặc performance changes chưa review vào release. Agent không stage/commit/push ở đây.
- Pin rollback frontend deployment ID + backend function versions/source/import maps/locks và config/secrets names trong vault riêng; không lưu giá trị secret vào report. Nếu chưa có rollback bundle đã kiểm tương thích staging: NO-GO đổi runtime.
- Owner xác nhận Vercel team/project/domain/Production Branch và exact release SHA; kiểm deployments đang chạy/auto-deploy để tránh một push/redeploy khác giành domain. Domain public-facing đang dùng Supabase staging không làm staging thành môi trường dữ liệu production.
- Owner đối chiếu schema/migration prerequisites, RLS/grants/private bucket, Auth hook/OU confirmed/email-password/SMTP/OTP trên staging qua quy trình được duyệt. Không áp baseline dev hoặc receipt T12 vào staging. Nếu thiếu/khác schema cần task riêng; **không db push/migration/RLS/grants change trong promotion này**.
- Xác nhận A/B staging đã confirmed/nonanonymous/ACTIVE và quyền dùng test accounts. Không copy users/passwords/tokens từ dev. Staging ADMIN phải được owner xác minh riêng; ADMIN chính thức của dev không tự có trên staging. Không grant hoặc đổi trạng thái account trong task này.
- Duyệt maintenance window, người thực hiện/rollback, budgets/retention cho post/comment/vote/upload/moderation smoke. Login/OTP có Auth side effects; business smoke và HIDE tạo dữ liệu/audit, không phải read-only. Không làm ngoài approved synthetic targets.

## 2. Edge secrets staging

Checklist **chưa xác minh Cloud**; owner kiểm đúng project trước ghi. Secrets Edge là project-scoped nên đổi origins có thể ảnh hưởng cả hai functions. Không copy cả file env dev hoặc dùng CLI config push.

| Cấu hình | Yêu cầu staging / cách kiểm an toàn |
|---|---|
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | Built-in runtime cùng staging; không thay bằng key dev, không chép vào browser/report. Public-feed dùng admin client server-only để SELECT scope đã duyệt |
| `THEOU_PUBLISHABLE_KEY` | Key publishable của staging cho social-api Auth client; key shape không chứng minh đúng project, đối chiếu owner Dashboard |
| `THEOU_ALLOWED_ORIGINS` | Chứa exact `https://theou.tech`, không slash cuối/path/wildcard. `https://www.theou.tech` chỉ thêm nếu thực sự serve frontend ở đó; nếu chỉ redirect apex thì kiểm redirect. Preview origin chỉ thêm exact origin sau duyệt, không `*.vercel.app` |
| `THEOU_POST_CURSOR_SECRET` | Member cursor secret riêng staging, 43–128 base64url; không lấy từ dev, không rotate member secret ngoài kế hoạch vì cursor cũ sẽ lỗi |
| `THEOU_PUBLIC_FEED_CURSOR_SECRET` | Tạo ngẫu nhiên bằng CSPRNG trong quy trình vault của owner, riêng staging và khác member/dev secret; 43–128 base64url, không in terminal/report |
| `THEOU_PUBLIC_FEED_POST_IDS` | **Scope rỗng ban đầu**. Absent được source coi là empty; không nhập chuỗi literal `""`, `[]`, IDs dev hoặc sentinel. Kiểm response empty từ bản staging mới. Mọi nonempty scope cần approval riêng sau smoke empty |
| JWT gateway | public-feed `false`, social-api **`true`**; kiểm cả deployed settings, không chỉ config local |

Thiếu/sai cursor secret trả lỗi fail closed ngay cả scope rỗng; không coi500 là empty PASS. Scope malformed/duplicate/>100 fail closed. Không công khai service/cursor secrets hoặc thêm VITE vars cho chúng.

Auth staging: Site URL phải phù hợp `https://theou.tech`, Redirect URLs chỉ exact paths/origins thực sự dùng và được review (không wildcard toàn Internet); SMTP/template signup OTP theo flow hiện tại. Không đổi email eligibility **`@ou.edu.vn`** hoặc tắt confirmation/hook để chạy test. Existing flow đăng nhập password, OTP dùng verify signup; không biến login thành OTP login. Thay Auth settings nếu cần là owner-approved config operation riêng, không ngầm từ lệnh deploy Edge.

## 3. Lệnh staging theo thứ tự — chưa thực thi

Native CLI đã kiểm **offline** bằng `--version`, `functions deploy --help`, `functions delete --help`: **3.1.0**, SHA-256 **`f6adec9cab13b017eea61f75e1c54769eb520e0760453fd8a722877a8c0b30ff`**. Không cài/update CLI. Command dùng explicit `--remote=gxsfbzaconeaxwztynpm`, không phụ thuộc linked project đang là dev.

Đường dẫn native đã tìm trên máy này:

```powershell
$stagingCli = 'C:\Users\Lenovo\AppData\Local\npm-cache\_npx\a2642d082f752488\node_modules\@supabase\cli-windows-x64\bin\supabase.exe'
& $stagingCli --version
```

Owner kiểm lại binary/hash và source tại release checkout, cwd `supabase/`, PAT scoped đúng staging qua cơ chế secret local, không command-line token. Kiểm process env overrides, đặc biệt không để consent `SUPABASE_YES` ngoài review. CLI3 hỏi xác nhận hosted mutation; không thêm `--yes` hoặc pipe `y` để bỏ review project. [CLI v3 changelog](https://supabase.com/changelog/supabase-cli-v3) xác nhận remote/consent behavior; local help của binary là căn cứ flag cụ thể.

1. Owner duyệt/check prerequisites, rollback và staging secrets mục2; thay secrets qua Dashboard/vault riêng. Chưa mở scope. Không có lệnh secrets chứa giá trị trong report.
2. Nếu social-api staging chưa đúng reviewed bundle, owner duyệt deploy riêng exact function; nếu đã khớp thì ghi version và bỏ bước này:

   ```powershell
   & $stagingCli functions deploy social-api --remote=gxsfbzaconeaxwztynpm --use-api
   ```

   Config giữ verify_jwt=true; **không** truyền `--no-verify-jwt` ở lệnh này. Không deploy toàn functions/Auth hook scaffold.
3. Deploy exact public-feed với scope rỗng, sau approval:

   ```powershell
   & $stagingCli functions deploy public-feed --remote=gxsfbzaconeaxwztynpm --use-api --no-verify-jwt
   ```

   Cờ cuối chỉ thuộc public-feed, đúng config function riêng. Pin source/shared modules và `functions/public-feed/deno.json`/lock tương ứng; không lấy bundle ngẫu nhiên từ dirty checkout. Check deployed versions/JWT flags/origins; timeout/unknown deployment result thì review trạng thái trước, không retry mù.
4. Smoke Edge read-only empty scope/protected denial theo approval trước frontend promotion. Schema/grants/Auth khác expected: dừng, không sửa DB hoặc tắt JWT để chữa lỗi.
5. Phát hành frontend theo mục4 rồi smoke tại domain thật. Chỉ sau acceptance empty/member mới cân nhắc approval nonempty synthetic public scope.

## 4. Vercel: build cùng source, đúng environment, chưa chuyển domain sớm

Root Directory **`frontend`**, React/Vite, install `npm ci`, build `npm run build`, output **`dist`**, SPA rewrites trong `frontend/vercel.json`. Dùng lockfile; không thay dependency hoặc build từ local env hiện tại. Owner dùng Git-linked release SHA đã duyệt, kiểm không có auto-deploy/branch override ngoài ý muốn.

Chỉ hai frontend variables cấu hình Supabase: `VITE_SUPABASE_URL=https://gxsfbzaconeaxwztynpm.supabase.co` và `VITE_SUPABASE_PUBLISHABLE_KEY` từ staging. Không key value trong report. Kiểm Preview/Production/branch-specific overrides, integrations và built JS/request hostname: tất cả Auth/social-api/public-feed/Storage phải staging, không dev. Key đúng prefix chưa đủ chứng minh project. Local `.env.local` hiện URL staging MATCH=false; không sửa file này và không upload nó. Dashboard Git build không được giả định dùng env local.

**Vercel Production environment là môi trường build/domain, không phải Supabase production project.** Với domain đang ở Production của Vercel nhưng backend staging, chọn staged Production build dùng đúng staging vars; không promote Preview chứa dev vars và hy vọng env tự đổi. Theo [Vercel environment variables](https://vercel.com/docs/environment-variables), scope/branch overrides ảnh hưởng deployment mới. Vite nhúng config lúc build nên đổi env yêu cầu build mới.

Quy trình ưu tiên Dashboard Git deployment: owner chọn exact release SHA, kiểm team/project/root/env, tắt Auto-assign Custom Production Domains cho staged Production build trong window được duyệt; review build log và backend hostname trước khi Promote. Owner xác nhận danh sách domains sẽ chuyển. Cách staging build và manual promotion được mô tả trong [Vercel promotion](https://vercel.com/docs/deployments/promoting-a-deployment).

Nếu owner chọn CLI thay Dashboard, **chỉ sau khi Vercel CLI version/help được kiểm và project link/root/source sạch đã đối chiếu**; task này không chạy/cài Vercel CLI:

```powershell
# Cwd/link phải là project/release checkout đã owner duyệt, không checkout dirty hiện tại.
vercel deploy --prod --skip-domain
# Sau review đúng deployment ID/build env/backend host và approval chuyển domain:
vercel promote <EXACT_REVIEWED_DEPLOYMENT_ID>
```

Đây là command shape từ [Vercel deploy](https://vercel.com/docs/cli/deploy) và [promote](https://vercel.com/docs/cli/promote), chưa được xác minh với CLI local. `--skip-domain` ngăn tự alias; không dùng `--prod` một mình, `--yes`, deploy hook hoặc branch tip chưa pin. Không tạo project mới/đổi DNS ở bước này. Pre-domain browser smoke chỉ được chạy nếu exact temporary origin/CORS/Auth redirect đã được duyệt; nếu chưa có thì kiểm build/artifact trước, không nới origins wildcard để test.

## 5. Staging smoke tại https://theou.tech — tất cả NOT RUN

Ghi thời điểm/build ID/Edge versions/project/actor aliases/viewport/expected/actual và PASS/FAIL/BLOCKED; không HAR/token/email/Auth UUID/private URL. Chrome desktop1280 và mobile390 dark/light; real-device coverage ghi riêng. Mỗi business write chỉ exact synthetic fixture/budget được duyệt, retained rows không là target.

| Nhóm | Test và expected | Quyền / evidence |
|---|---|---|
| Target/domain | HTTPS/canonical, direct refresh SPA, bundle/request host staging; không dev request | Read-only; owner kiểm deployment/env/project và sanitized hostname/booleans |
| Empty public | Guest `/`, NEW/HOT/tag/pages không lỗi; `items=[]`, `nextCursor=null`, empty message; CTA/login links đúng, alias `/bang-tin` về `/` | Read-only; public request không JWT/cookie, secret cấu hình hợp lệ |
| Privacy | Không author/email/MSSV/profile ID/nickname/contact/storage path/signed URL/media request; flags false, images[], no-store | DTO key/value checks + UI/network đã lọc; body review riêng khi nonempty |
| Guest guard | Direct Detail/Compose/Profile/Admin về login; không interaction controls; public action khác400; protected actions thiếu/sai/expired JWT denied | Read-only denial payload hợp lệ; gateway401 hoặc safe gateway denial, handler401; không gọi DML probe khi guard hỏng có thể ghi mà chưa duyệt |
| Auth | A/B context riêng, password login, restore, logout về guest, không loop/cache leak; OTP signup/verify/resend chỉ approved account/window, confirmation OU giữ nguyên | Auth side effects cần approval; không đăng ký lại/reset existing account để tạo case |
| Member | Feed/Detail/tags/NEW/HOT/pages; comment B/A OP, count; desired vote true/false/no duplicate; tạo/publish synthetic post,1–2ảnh, gallery/private reads | Business writes cần manifest/budget/retention approval; snapshot/count checkpoints theo scope, không blind retry timeout |
| Profile/ADMIN | Profile load/edit nickname nếu duyệt; non-admin không form/HTTP denied; verified staging ADMIN đúng context; HIDE POST/COMMENT chỉ approved fixture, audit đúng/count đúng | Role/account read riêng; nickname/HIDE là writes. Không suy role từ dev hoặc tự grant/revoke. Nếu chưa có staging ADMIN thì case BLOCKED |
| CORS/JWT/errors | Origin theou.tech preflight/POST hoạt động; origin ngoài list denied, không wildcard; social-api JWT vẫn bật. Invalid filter/cursor/action400, unavailable content404, lifecycle409 theo contract, safe errors/retry | Negative read requests được scope; không ép500 trên Cloud bằng sửa secrets/Edge hoặc gây timeout thật. Cases chưa dựng an toàn ghi NOT TESTED |
| Approved public scope, phase riêng | Owner duyệt vài synthetic PUBLISHED/ANONYMOUS staging IDs/body; NEW/HOT/filter/pages trên scope, không media/identity; bài unapproved/NICKNAME/hidden/deleted không lọt; removal → request mới không trả, cursor scope cũ invalid | Đổi allowlist là config write cần approval riêng; không dùng IDs dev, không tự thêm posts hoặc chỉnh historical rows để dựng test |

Outside-OU, BANNED, unconfirmed hoặc concurrency không có actor/window/evidence riêng giữ NOT TESTED/BLOCKED đúng case. Không suy local automation hoặc B1 manual PASS thành staging security PASS. Hai aliases không hai sinh viên độc lập; AUTH-ALIAS-001 OPEN.

## 6. Rollback

1. Leak/unauthorized response/count/audit drift/sai backend: dừng promotion và writes kế tiếp; giữ sanitized evidence, owner xử lý containment. Không cleanup dữ liệu để ép xanh.
2. Owner đưa public scope về rỗng trên **staging**, kiểm response mới. Đây là kill switch đọc mới, không thu hồi copy/cache hoặc text đã công khai. Không reset project secrets toàn bộ; shared origins phải giữ member access đã duyệt.
3. Frontend: owner chọn đúng previous deployment **đã build với staging vars**, Instant Rollback hoặc promote reviewed previous Production deployment trong đúng project. Không rollback về artifact trỏ dev. [Vercel Instant Rollback](https://vercel.com/docs/deployments/promoting-a-deployment) không rebuild env; nếu previous env sai thì cần build mới, không alias mù.
4. Edge: owner redeploy exact prior reviewed bundle tại rollback checkout bằng các lệnh mục3, đúng từng function và JWT flag. Nếu public-feed mới hoàn toàn và cần vô hiệu hóa, sau approval riêng:

   ```powershell
   & $stagingCli functions delete public-feed --remote=gxsfbzaconeaxwztynpm
   ```

   Không delete social-api hoặc tắt JWT; scope rỗng trước thường giữ UX empty an toàn hơn endpoint mất. Không coi frontend rollback là tắt public API. Restore config/secrets bị thay chỉ từ vault sau owner review; cursor rotation có thể invalid cursors, không undo business data.
5. Không đổi Cloudflare DNS vì promotion dự kiến chỉ chuyển deployment alias. Nếu owner từng đổi DNS/config ngoài kế hoạch, rollback bằng saved actual records/settings sau approval; không đoán record/TTL. Không migrations/RLS/grants rollback, hard-delete posts/Auth/media/audit hoặc reset DB.

## 7. GO/NO-GO và checks của lượt này

**GO review B2:** B1 manual PASS và local security regression đủ căn cứ chuẩn bị promotion. **GO deploy chỉ khi** release source/artifact khớp dev reviewed implementation, project/env/secrets/JWT/baseline prerequisites/rollback và owner approvals đầy đủ; scope empty. **GO staging acceptance** chỉ sau các mandatory smoke thực tế PASS với evidence staging và retained data/audits không drift. Nonempty public scope là gate riêng.

**NO-GO:** source/bundle không khớp, wrong Vercel project/branch/backend, local env sai được upload, secrets missing/reused/identity leak, social-api JWT off, missing schema/roles/approved accounts, không rollback path, unknown mutation/deploy outcome hoặc test bắt buộc FAIL/BLOCKED. Dev PASS không override các điều kiện này. Bundle>500 kB, helper format, HOT/rate limiting/cache/copy/real-device gaps giữ nguyên từ Phase A; owner review mức rủi ro trước mở người dùng.

Lượt này chỉ kiểm source/config/Git/logs, CLI help/version/hash offline và targeted tests local: Supabase9/9, frontend1/1 PASS; không rerun full413/97 hoặc bảy browsers (đó là Phase A evidence). Documentation links/UTF-8, `git diff --check`, index và preservation check được kiểm local; không sửa source/env/migrations/historical evidence. Public vendor docs được tra cứu, **project Cloud/Auth/SQL/API calls=0, Cloud config/write/deploy=0; không stage/commit/push**.

**STOP: B1 OWNER-CONFIRMED MANUAL PASS / B2 STAGING PLAN READY — PENDING OWNER APPROVAL.**
