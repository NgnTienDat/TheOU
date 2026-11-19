# 06 — Hợp đồng API và Data Access

**Mục tiêu:** UI phụ thuộc vào interface ứng dụng, không phụ thuộc trực tiếp PostgreSQL/Edge Functions. Có thể thay triển khai bằng NestJS về sau mà không thay đổi luồng UI.

## 1. Quy ước chung

- Dữ liệu Auth (`signUp`, `verifyOtp`, `signInWithPassword`, `signOut`) do module Auth gọi `supabase.auth` trực tiếp; UI component không gọi SDK. OTP chỉ xác minh đăng ký, không dùng đăng nhập không mật khẩu.
- Nghiệp vụ sử dụng `supabase.functions.invoke('social-api', { body: { action, payload } })` với JWT người dùng; **mọi action đều POST JSON**.
- `social-api` yêu cầu user JWT; sau khi xác thực, kiểm tra email OU **đã xác minh**, profile `ACTIVE`, role nếu cần. Không có truy cập nội dung social cho khách.
- Response dạng `{ "data": ... , "error": null, "meta": { "requestId": "..." } }` hoặc `{ "data": null, "error": { "code": "...", "message": "...", "details": null }, "meta": {...} }`.
- Date string ISO 8601 UTC, UUID string; API `camelCase`, DB `snake_case`; không trả raw DB row.
- Validate cả frontend và server; server là nguồn xác thực cuối cùng.

### Mã lỗi chuẩn

| Code | Ý nghĩa | Hành vi UI |
|---|---|---|
| `UNAUTHENTICATED` | Chưa đăng nhập/JWT không hợp lệ | Về trang đăng nhập |
| `FORBIDDEN` | Không có quyền/email ngoài OU/tài khoản bị khóa | Thông báo/điều hướng phù hợp |
| `VALIDATION_ERROR` | Payload không hợp lệ | Giữ form, báo lỗi |
| `NOT_FOUND` | Không có hoặc không được xem nội dung | Trang không tìm thấy |
| `CONFLICT` | Trùng hoặc trạng thái không còn phù hợp | Làm mới dữ liệu |
| `RATE_LIMITED` | Vượt giới hạn | Hiện số giây thử lại |
| `UPLOAD_ERROR` | Upload/verify ảnh thất bại | Thử lại không đăng trùng |
| `INTERNAL_ERROR` | Lỗi hệ thống | Thông báo chung và request ID |

Status HTTP tương ứng nếu có: 401/403/400/404/409/429/500; `UPLOAD_ERROR` dùng 422 trong T10. Không đưa SQL, JWT hoặc email của người khác vào `details`.

### Hợp đồng Auth — yêu cầu T03 cập nhật 15/11/2026

Các thao tác sau là Supabase Auth API, không phải `social-api` action và không dùng envelope nghiệp vụ ở trên:

| Thao tác | SDK/input | Thành công mong đợi | Lỗi quan trọng |
|---|---|---|---|
| Đăng ký | `signUp({ email, password })` | Confirm email bật: `data.session === null`; email chờ OTP xác minh | Hook từ chối domain ngoài OU; weak password; rate limit |
| Xác minh đăng ký | `verifyOtp({ email, token, type: 'email' })` | Session hợp lệ và user có `email_confirmed_at` | `otp_expired` cho mã sai/hết hạn; không session |
| Gửi lại xác minh (T05) | `resend({ type: 'signup', email })` | Yêu cầu được tiếp nhận, không tự tạo session | Cooldown/rate limit; chưa có manual mode gửi lại |
| Đăng nhập | `signInWithPassword({ email, password })` | Session và user OU đã xác minh; không yêu cầu/gửi OTP | `invalid_credentials`, `email_not_confirmed`, rate limit |
| Đăng xuất | `signOut({ scope: 'local' })` | `getSession()` của app/script trả null | Mất mạng hoặc lỗi logout cần báo chưa xác minh |

Email trim/lowercase, đúng cú pháp và chính xác domain `ou.edu.vn`. Mật khẩu đăng ký ít nhất 8 ký tự, tối đa 72 byte UTF-8, không trim/chuẩn hóa; mật khẩu đăng nhập giữ nguyên giá trị đã có. Chính sách mật khẩu phải thực thi ở Auth server. OTP gồm đúng 6 số ASCII, hạn 600 giây; gửi lại theo cooldown tối thiểu 60 giây.

Không lưu mật khẩu/OTP vào file, URL, log/analytics hoặc bảng nghiệp vụ. Chỉ Auth lưu hash mật khẩu; password đi thẳng tới Auth qua HTTPS. Trước khi coi xác thực thành công, kiểm tra lỗi, session và `getUser()` xác nhận email OU đã xác minh. Không tin payload hoặc user_metadata tự khai báo trạng thái xác minh.

Không dùng phản hồi `signUp` thành công làm bằng chứng user mới đã tạo: Auth có thể che việc email đã tồn tại. Không công khai sự tồn tại tài khoản; `invalid_credentials` hiển thị `Email hoặc mật khẩu không đúng`. Tài khoản chưa xác minh được hướng dẫn xác minh đăng ký, không chuyển sang đăng nhập OTP. Logout không bảo đảm JWT access token đã cấp hết hiệu lực ngay.

Quên/đổi mật khẩu, nâng cấp tài khoản OTP cũ và UI T05 chưa triển khai trong T03. Không gọi `signUp` lại để thay mật khẩu tài khoản đã tồn tại.

## 2. DTO công khai

### `PostPublic`

```ts
type PostTag = 'CONFESSION' | 'REVIEW_MON' | 'TAI_LIEU' | 'TIM_TRO' | 'HOI_GAP';
type DisplayMode = 'ANONYMOUS' | 'NICKNAME';
interface PublicImage { id: string; signedUrl: string; expiresAt: string; }
interface PostPublic {
  id: string;
  tag: PostTag;
  body: string;
  displayMode: DisplayMode;
  authorLabel: string;            // "OUer ẩn danh" hoặc nickname snapshot
  contactUrl: string | null;      // null nếu anonymous/không cung cấp
  publishedAt: string;
  upvoteCount: number;
  commentCount: number;
  hasUpvoted: boolean;             // đối với người đang xem
  isMine: boolean;                 // chỉ cho biết bài của chính mình
  images: PublicImage[];
}
```

**Bị cấm trong DTO:** `authorId`, `email`, `studentId`, `profileId`, `storagePath`, `userMetadata`, `reporterId`.

### `CommentPublic`

```ts
interface CommentPublic {
  id: string;
  postId: string;
  body: string;
  authorLabel: string;           // "Chủ bài" nếu là OP, ngược lại "OUer ẩn danh"
  isOriginalPoster: boolean;
  isMine: boolean;
  createdAt: string;
}
```

### `Page<T>`

```ts
interface Page<T> { items: T[]; nextCursor: string | null; }
```

`nextCursor` là chuỗi mờ đục (*opaque*); client không tự xây cursor; backend validate lại và giới hạn kích thước. Cùng một tag + sort sử dụng cursor tương ứng; khi đổi tag/sort thì bỏ cursor.

## 3. Action và payload

| `action` | Payload chính | Data trả về | Mốc |
|---|---|---|---|
| `getMe` | `{}` | `{nickname, emailMasked, isAdmin}` | W1 |
| `updateNickname` | `{nickname}` | `{nickname}` | W1 |
| `listPosts` | `{sort:'NEW'\|'HOT', tag:PostTag\|null, cursor:string\|null, limit:20}` | `Page<PostPublic>` | W1 |
| `getPost` | `{postId}` | `PostPublic` | W1 |
| `createPost` | `{body,tag,displayMode,contactUrl?,idempotencyKey}` | `{postId,status:'DRAFT'}` | W1 |
| `createImageUpload` | `{postId,mimeType,sizeBytes,position}` | `{imageId,path,token}` | W2 |
| `finalizeImage` | `{postId,imageId}` | `{imageId,status:'READY'}` | W2 |
| `removeDraftImage` | `{postId,imageId}` | `{success:true}` | W2 — T10 |
| `publishPost` | `{postId}` | `PostPublic` | W1–W2 |
| `deletePost` | `{postId}` | `{success:true}` | W2 |
| `listComments` | `{postId,cursor:null,limit:20}` | `Page<CommentPublic>` | W2 |
| `createComment` | `{postId,body,idempotencyKey}` | `CommentPublic` | W2 |
| `deleteComment` | `{commentId}` | `{success:true}` | W2 |
| `toggleUpvote` | `{postId,desiredState:boolean}` | `{hasUpvoted,upvoteCount}` | W2 |
| `adminHideContent` | `{targetType:'POST'\|'COMMENT',targetId,reason}` | `{success:true}` | W2 |
| `createReport` | `{targetType,targetId,reason,detail?}` | `{reportId}` | W3 |
| `adminListReports` | `{status,cursor,limit}` | Page báo cáo chỉ admin | W3 |
| `adminResolveReport` | `{reportId,decision:'RESOLVED'\|'DISMISSED',note}` | `{success:true}` | W3 |
| `adminSetUserStatus` | `{userId,status:'ACTIVE'\|'BANNED',reason}` | `{success:true}` | W3 |

Với `listPosts`, tag `null` = tất cả; `HOT` chỉ lấy bài `publishedAt >= now() - 24h`. `getPost` chỉ trả bài `PUBLISHED` đối với người thường. Admin access nội dung ẩn đi qua action riêng, không biến `getPost` thành endpoint tiết lộ thông tin nhạy cảm.

### Phạm vi đã triển khai

T04/T05 đã nghiệm thu Cloud `getMe` và `updateNickname`. Nickname trim, 3–30 Unicode code points, cấm URL/ký tự điều khiển; UPDATE filter ID từ Auth và status ACTIVE, chỉ đổi nickname. Data chỉ `{nickname}`; không nhận userId/role/status. Frontend gọi adapter, không truy cập bảng trực tiếp.

POST JSON `{ "action": "getMe", "payload": {} }`; không chấp nhận field thừa ở envelope/payload. T06-A tăng giới hạn stream từ 4 lên **16 KiB** để chứa 1.000 Unicode code points kể cả JSON escape. Action chưa hỗ trợ hoặc request/method/content-type sai trả VALIDATION_ERROR/400. Guard từ chối JWT thiếu/sai/hết hạn bằng UNAUTHENTICATED/401; email ngoài OU/chưa xác minh hoặc BANNED bằng FORBIDDEN/403. Lỗi Auth/DB hệ thống trả INTERNAL_ERROR/500 với thông báo chung; không đưa response gốc vào details/log.

Data đúng ba trường `{ "nickname": "OUer-1234", "emailMasked": "***@ou.edu.vn", "isAdmin": false }`, không trả UUID/email đầy đủ/metadata. EmailMasked chỉ thuộc chính chủ; che toàn bộ local part để không lộ MSSV. Profile thiếu được insert an toàn, giữ hàng thắng khi concurrent/retry; profile đã tồn tại không bị thay đổi. Role ADMIN chỉ đọc từ DB.

OPTIONS cho origin Vite được cho phép trả 204, không đọc Auth/DB; không có action dữ liệu public. CORS theo origin đầy đủ trong THEOU_ALLOWED_ORIGINS, mặc định localhost/127.0.0.1:5173; CORS không thay thế JWT. Response handler có Cache-Control: no-store, requestId UUID do server tạo. Gateway giữ verify_jwt=true và có thể trả401 trước handler; adapter chuẩn hóa lỗi gateway. Post/comment/vote đã nghiệm thu T06/T08/T09; Media T10-A mới local. DeletePost/moderation vẫn là thiết kế.

### T06 — bốn action post text đã nghiệm thu

- `createPost`: body trim, 1–1.000 Unicode code points, không NUL/lone surrogate; đúng năm tag và hai mode đã khai báo. Không nhận field identity/status/count/timestamp. UUID idempotency key được chuẩn hóa lowercase. `contactUrl` vắng/null cùng nghĩa; URL khác null chỉ cho NICKNAME + TAI_LIEU/TIM_TRO, tối đa 2.048 ký tự, không whitespace/control, HTTPS, không credentials/port khác mặc định, đúng hostname `zalo.me`, `facebook.com`, `www.facebook.com`, `m.facebook.com`, `m.me`. URL parser chuẩn hóa trước khi lưu/so sánh; URL ngoài chính sách bị từ chối, không tự bỏ qua.
- Cùng author/key và cùng payload đã chuẩn hóa trả cùng `{postId,status:'DRAFT'}` ACK; payload khác trả CONFLICT/409, không sửa hàng cũ. ACK vẫn giữ nguyên khi retry sau publish, **không mô tả trạng thái hiện tại hoặc đưa bài trở về DRAFT**. DRAFT không có API đọc công khai.
- `publishPost`: payload chỉ `{postId: UUID}`. UPDATE tại DB có đủ id/author/status=DRAFT; trigger riêng gán publishedAt và nickname snapshot theo profile ACTIVE đã khóa lúc publish. NICKNAME draft phải lưu snapshot tạm để thỏa CHECK T02; khi publish DB thay bằng nickname tại thời điểm đó. ANONYMOUS luôn snapshot/contact null. Replay bài PUBLISHED của chính chủ giữ timestamp/snapshot; HIDDEN/DELETED trả CONFLICT/409; thiếu hoặc khác chủ cùng NOT_FOUND/404.
- `getPost`: chỉ PUBLISHED, kể cả caller là chủ bài hoặc ADMIN; thiếu/DRAFT/HIDDEN/DELETED cùng NOT_FOUND/404. DTO đúng 12 field PostPublic, không serialize row. `isMine` tính theo caller; `hasUpvoted` đọc vote thực của caller, counts lấy cột DB, không tạo dữ liệu giả.
- Giai đoạn text: `images=[]` sau khi xác minh không có image row. Publish từ chối bài có ảnh; đọc bài có image row trả INTERNAL_ERROR an toàn thay vì giấu ảnh/giả signed URL. T10 cần mở rộng trigger/mapper/adapter cùng giao thức media.
- `listPosts`: sort bắt buộc NEW/HOT, tag null hoặc đúng năm tag, cursor null/chuỗi, limit nguyên **1–20**. Chỉ PUBLISHED; NEW giảm dần `(published_at,id)`, HOT 24 giờ tại mỗi request giảm dần `(upvote_count,published_at,id)`. Timestamp giữ microseconds để phân trang chính xác khi cùng millisecond.
- Cursor tối đa 1.024 ký tự, ký HMAC-SHA256 với secret chỉ ở Edge `THEOU_POST_CURSOR_SECRET` (base64url ngẫu nhiên tối thiểu 32 byte, 43–128 ký tự). Gắn sort/tag, mốc trên lần đọc đầu, tuple cuối và version; hạn 15 phút, không chứa author ID/email. Client coi cursor là opaque; giả/sai định dạng/hết hạn/đổi filter trả VALIDATION_ERROR/400, cấu hình thiếu secret trả INTERNAL_ERROR/500. Đổi secret làm cursor cũ hết hiệu lực; tải lại từ cursor null.
- Mốc trên loại bài mới hơn lần đọc đầu; không khóa trạng thái/count của feed. Anchor bị ẩn/xóa vẫn dùng tuple cursor; HOT có thể lặp/bỏ sót khi votes thay đổi và cutoff 24 giờ dịch chuyển. T07 dedupe theo post.id và refresh; **không có snapshot consistency**.
- Query nghiệp vụ post dùng chung deadline 10 giây sau guard và signal hủy request; lỗi trả INTERNAL_ERROR/500. Timeout không bảo đảm DB chưa commit: retry create bằng cùng key/payload, publish bằng cùng postId. Deadline này không phải timeout toàn bộ pipeline Auth/đọc request.

### T10-A — Media local, chưa cấu hình hoặc nghiệm thu Cloud

T10 thay chốt text-only T06 bằng vòng đời sau; các kết quả nghiệm thu T06–T09 vẫn là snapshot lịch sử. Không triển khai deletePost/moderation trong T10.

- Cả ba Media actions qua guard JWT thật, OU confirmed/ACTIVE và own DRAFT. Payload exact allowlist; không nhận path, bucket, author, status hoặc role. Missing/cross-owner cùng NOT_FOUND/404; không còn DRAFT trả CONFLICT/409.
- `createImageUpload`: MIME đúng JPG/PNG/WebP, size nguyên1–2097152, position1/2. INSERT PENDING với UUID server; retry cùng slot/MIME/size trả cùng imageId/path và token mới. Khác khai báo hoặc slot REMOVING trả CONFLICT. Không overwrite metadata. Lỗi cấp token giữ PENDING để retry/gỡ, không tạo slot mới. Đây là idempotency theo slot và khai báo, không phải fingerprint nội dung file.
- Upload ACK `{imageId,path,token}` chỉ gửi cho chủ bản nháp. Path `posts/{postId}/{randomImageId}.{jpg|png|webp}` không chứa Auth UUID/email/tên file gốc. SDK frontend chỉ `uploadToSignedUrl(path,token,processedBlob,{contentType,upsert:false})`; không fallback upload công khai. Token hiện có hạn2giờ theo Storage; giữ trong bộ nhớ, không log/persist.
- `finalizeImage`: đọc object `info` và download từ bucket cố định bằng quyền server; kiểm tra bucket/path, actual size/contentType và magic/container bytes với reservation. Thiếu/mismatch/lỗi Storage trả UPLOAD_ERROR/422, không READY. Đây không phải full decoder/antivirus. READY retry vẫn kiểm tra object; transition chỉ còn own DRAFT và trạng thái hợp lệ.
- `removeDraftImage`: chuyển PENDING/READY→REMOVING trong DB trước, xóa đúng một path qua Storage API, rồi REMOVED. Publish bị chặn khi REMOVING. Lỗi/mất ACK retry cùng imageId; không reset count hoặc xóa prefix. Tombstone giữ ID/path, giải phóng slot bằng partial unique index; không cho token/finalize cũ phục hồi row. Token cũ có thể upload lại orphan sau remove; không thể publish orphan qua metadata đã REMOVED. Dọn orphan cần review riêng sau hạn token, scheduler thuộc T17.
- Trigger media khóa parent cùng publish và recheck DRAFT/ACTIVE; immutable MIME/size/position/path. Không giữ SQL transaction trong lúc gọi Storage. Publish chỉ chấp nhận0–2 READY và bỏ qua REMOVED; snapshot nickname/publishedAt của T06 giữ nguyên. PENDING/REMOVING hoặc DB error không bị coi là success.
- `listPosts/getPost/publishPost` chỉ ký READY của post đã authorize PUBLISHED, thứ tự position; `PublicImage` đúng `{id,signedUrl,expiresAt}`, TTL300giây. Không trả path riêng, upload token hoặc identity. Lỗi ký URL trả lỗi an toàn, không giả `images=[]`; text-only không gọi Storage. Signed read URL vẫn chứa đường dẫn post/image công khai và capability token, không Auth UUID. URL có thể còn dùng tới TTL/cache dù logout hoặc bài bị ẩn; không bảo đảm thu hồi tức thì.
- UI xử lý lại pixels trước upload, giữ cùng canonical post/key/processed blob khi retry; lỗi ảnh thứ hai không upload lại ảnh READY. Mất ACK upload thử finalize trước, không upsert. Upload chờ tối đa30giây ở adapter; SDK request có thể còn chạy sau timeout, nên không suy ra rollback. Sau lần publish đầu khóa attachments và chỉ retry publish cùng postId. Không khôi phục toàn bộ pipeline sau reload/rời trang.
- Gallery dùng placeholder/error/expiry và nút tải lại tối đa3lần/mount qua getPost đã authorize. Không background retry vô hạn hoặc log URL; đổi phiên/unmount bỏ kết quả cũ. Đọc lại riêng images không ghi đè optimistic upvote/count trong query cache.

## 4. Các thao tác cần atomic và idempotent

### T08-A — Comment actions local, chờ review/deploy

- `listComments({postId,cursor,limit})`: postId UUID, cursor null hoặc chuỗi1–1024, limit nguyên1–20; parent chỉ PUBLISHED, missing/private NOT_FOUND, không ADMIN bypass. Chỉ VISIBLE, `(created_at ASC,id ASC)`, giữ microseconds. Cursor HMAC dùng secret T06, thêm kind=comments/postId/asOf/createdAt/id/v1; max1024, hạn15phút, khác postId/loại cursor/tamper/expiry trả VALIDATION_ERROR. Không author/status trong cursor. Mốc trên không phải snapshot: hidden/deleted xảy ra giữa các trang vẫn ảnh hưởng kết quả, refresh lấy comments mới.
- `createComment({postId,body,idempotencyKey})`: đúng ba field, body trim1–500 Unicode code points, không NUL/lone surrogate, UUID lowercase. Không nhận owner/status/timestamp/role. Lấy author từ guard; INSERT unique DO NOTHING rồi so payload. Cùng key/postId/body trả cùng CommentPublic nếu còn VISIBLE và parent PUBLISHED; mismatch hoặc comment HIDDEN/DELETED trả CONFLICT, không phục hồi nội dung. AFTER INSERT kiểm tra parent PUBLISHED và tăng count trong cùng transaction; lỗi/rollback không tạo count riêng lẻ.
- `deleteComment({commentId})`: chỉ UUID; đọc/filter owner từ guard và parent PUBLISHED; UPDATE id/author/status=VISIBLE thành DELETED. Own DELETED trả `{success:true}` khi parent còn được xem; missing/cross-owner/HIDDEN cùng NOT_FOUND. Concurrent hide thắng thì không ghi đè; retry/lost response không trừ count lần nữa. Không physical DELETE/admin action.
- Response create/list chỉ đúng bảy field CommentPublic. `authorLabel='Chủ bài'` khi OP, còn lại `'OUer ẩn danh'`, không nickname/authorId/email/MSSV/userMetadata/idempotencyKey/status. `isMine` theo caller; không commenter identifier xuyên bài. Quyền bảng/RLS không thay đổi.
- Frontend T08-A thêm detail và comments; write success làm mới comment list từ cursor null, post detail và feed counts. Timeout giữ snapshot/key, không persist nội dung/JWT/key; reload/unmount recovery chưa hoàn chỉnh. Các ca Cloud còn chờ T08-B.

- `createPost`: client giữ `idempotencyKey` UUID cho một lần submit; INSERT ON CONFLICT DO NOTHING rồi đọc theo author/key và so payload chuẩn hóa, không SELECT trước INSERT hoặc merge nội dung. Retry cùng payload trả ACK gốc, payload khác CONFLICT.
- `publishPost`: gọi lại trên bài đã publish của cùng tác giả thì trả bản hiện tại; bài bị ẩn/xóa phải xử lý `CONFLICT`.
- `createComment`: unique `(author_id, idempotency_key)` để retry không nhân đôi bình luận.
- `toggleUpvote` (T09-A local, chưa deploy): chỉ nhận đúng `{postId,desiredState}`, UUID và boolean thực bắt buộc; extra field kể cả userId/authorId/count/status/role/idempotencyKey trả VALIDATION_ERROR. True INSERT ON CONFLICT DO NOTHING, false DELETE theo post/caller; PK `(post_id,user_id)` và AFTER trigger giữ count đúng số vote, rollback cùng transaction. Retry giữ desiredState, không đảo mù hoặc nhân đôi. Self-vote được phép.
- Guard JWT/OU confirmed/ACTIVE hiện có áp dụng mỗi request; BANNED bị chặn, không ADMIN bypass parent. Missing/DRAFT/HIDDEN/DELETED cùng NOT_FOUND. Response data đúng `{hasUpvoted:boolean,upvoteCount:integer>=0}`, không vote row/identity/metadata; count và caller state đọc cùng một SELECT sau mutation. getPost/listPosts tiếp tục dùng PostPublic không thêm field; A/B có state riêng và count chung tại cùng DB state.
- True/false concurrent theo thứ tự DB thực thi, không last-request-wins. Mutation và read response là hai transaction: read trả trạng thái thực lúc đọc, không tự trả desiredState. Parent vừa mất PUBLISHED có thể khiến response NOT_FOUND sau mutation đã commit; timeout/error không chứng minh rollback. Frontend serialize theo post/phiên, retry cùng intent và refetch. HOT reset cursor null; không snapshot consistency khi votes thay đổi.
- Các bộ đếm vote/comment được cập nhật trong transaction/triggers hoặc truy vấn tổng chính xác; không cập nhật bằng phép cộng không khóa ở Edge Function.

## 5. Ví dụ request/response

**Yêu cầu:**

```json
{
  "action": "createPost",
  "payload": {
    "body": "Có ai học ở Nguyễn Kiệm mà hay lạc phòng không?",
    "tag": "CONFESSION",
    "displayMode": "ANONYMOUS",
    "contactUrl": null,
    "idempotencyKey": "d88ed4d4-b550-48a9-82d1-54ee3c55f29f"
  }
}
```

**Kết quả:**

```json
{
  "data": {
    "postId": "e76cbf0c-38ef-47e8-89a0-8077d6f0cf94",
    "status": "DRAFT"
  },
  "error": null,
  "meta": { "requestId": "00000000-0000-4000-8000-000000000001" }
}
```

**Thành công khi đăng:** UI phải tiếp tục gọi `publishPost`; không coi `createPost` là bài đã xuất hiện trên feed.

## 6. Quy ước riêng cho media

1. `createPost` trả `postId` trong trạng thái DRAFT.
2. Mỗi ảnh: frontend nén và bỏ metadata khi có thể; gọi `createImageUpload`.
3. Server tạo record `post_images(PENDING)` sau khi kiểm tra chủ bài, số lượng, MIME/size và sinh path không chứa danh tính; cấp signed upload token.
4. Frontend gọi `supabase.storage.from('post-media').uploadToSignedUrl(path,token,file)`.
5. Frontend gọi `finalizeImage`; server xác minh object tồn tại/đúng metadata, đánh dấu READY.
6. `publishPost` xác nhận tất cả ảnh READY, số lượng ≤2 và field hợp lệ.
7. `listPosts`/`getPost` trả signed read URLs ngắn hạn (mặc định TTL 300 giây) cho ảnh READY của các bài được phép xem; token hết hạn phải làm mới.

Đây là thiết kế T10, chưa triển khai ở T06-A. T06 chỉ hỗ trợ bài text không image row. Frontend **không** tự chọn quyền truy cập hoặc liệt kê bucket.

## 7. API Adapter phía frontend

`frontend/src/shared/api/SocialApiClient.ts` giữ interface/input/DTO. Factory `createSocialApi` dùng functions.invoke/runtime allowlist/lỗi an toàn. Post/Comment/Upvote đã nghiệm thu theo T06–T09; T10-A bổ sung local createImageUpload/uploadImage/finalizeImage/removeDraftImage và PublicImage runtime validation. Không raw-table access; uploadImage chỉ là adapter Storage signed upload, không action social-api mới.

```ts
interface SocialApiClient {
  listPosts(input: ListPostsInput): Promise<Page<PostPublic>>;
  getPost(postId: string): Promise<PostPublic>;
  createPost(input: CreatePostInput): Promise<{ postId: string; status: 'DRAFT' }>;
  publishPost(postId: string): Promise<PostPublic>;
  listComments(input: {postId: string; cursor: string | null; limit: number}): Promise<Page<CommentPublic>>;
  createComment(input: CreateCommentInput): Promise<CommentPublic>;
  deleteComment(commentId: string): Promise<{success: true}>;
  setUpvote(postId: string, desiredState: boolean): Promise<{ hasUpvoted: boolean; upvoteCount: number }>;
}
```

Các phương thức còn lại tuân theo cùng mẫu. `createSocialApi` ánh xạ phần interface đã triển khai sang `social-api` actions. Khi chuyển NestJS, giữ DTO và hook UI. Chuẩn hóa exception trong adapter, không để component trực tiếp xử lý lỗi Supabase thô.

## 8. Bảo mật bắt buộc ở mỗi action

### T11-A local — deletePost và adminHideContent

- `deletePost({postId})` strict payload/UUID; chỉ owner ACTIVE từ Auth Guard, không ADMIN bypass. UPDATE có filter owner/PUBLISHED; DELETED replay trả `{success:true}` không write; DRAFT/HIDDEN trả CONFLICT409. Missing/cross-owner cùng NOT_FOUND404. Chỉ status/updated_at đổi khi transition thật; giữ publish timestamp/body/identity/comments/votes/images. Không cleanup DRAFT/Storage và không restore.
- `adminHideContent({targetType:'POST'|'COMMENT',targetId,reason})`: chỉ ADMIN đọc DB trên request đang xử lý, không tin metadata/payload role. Lý do trim1–500 Unicode code points, cấm Cc/Cf/Cs; không nhận field thừa. Non-admin request hợp lệ403; malformed/spoof fields400. RPC service-only recheck ACTIVE/ADMIN, thực hiện hide và audit HIDE trong một transaction. POST chỉ PUBLISHED→HIDDEN, COMMENT chỉ VISIBLE→HIDDEN (không cần public preview parent). Missing/wrong type target404; DRAFT/DELETED/already-HIDDEN409. Audit failure500 an toàn và rollback; success chỉ `{success:true}`, không reason/audit/identity trong response.
- Sau POST HIDDEN/DELETED, getPost/listComments/createComment/toggleUpvote public chỉ thấy NOT_FOUND theo guards hiện có; listPosts NEW/HOT loại bỏ. Read mapping recheck trạng thái trước ký/trả; không trả URL mới cho request bắt đầu sau commit. Request đang chạy có cửa sổ sau recheck cuối; URL cũ TTL300giây/cache không được bảo đảm revoke tức thì. Không hard-delete post_images/objects. Comment HIDDEN không vào list/cursor, count chỉ VISIBLE qua trigger T08; owner deleteComment giữ semantics T08, không được xóa HIDDEN qua API.

Đây là bản triển khai local T11-A, chưa Cloud acceptance. Các đoạn T06–T10 bên trên là lịch sử theo giai đoạn; không có createReport/adminListReports/adminResolveReport/adminSetUserStatus/RESTORE mới trong T11.

listComments recheck VISIBLE và parent PUBLISHED trước mapping, không đưa row vừa bị ẩn vào DTO/cursor tại bước recheck. Moderation đồng thời có thể làm trang ngắn hoặc nextCursor=null sớm; refresh để đọc lại. Không có snapshot consistency và vẫn có cửa sổ commit sau lần kiểm tra cuối.

T02 khóa mọi truy cập bảng trực tiếp và giữ ownership bất biến bằng trigger. T04–T07 đã nghiệm thu trong phạm vi tương ứng. T08-A chỉ local comments/OP/soft-delete chính chủ; T11 phụ trách deletePost và admin hide/audit, tái sử dụng lifecycle comments. Test CRUD service-role hoặc PGlite không thay thế JWT/PostgREST/locking Cloud thật. Lỗi SQL/constraint phải map sang message an toàn ở Edge/adapter.

Pseudocode chung:

```text
1. Verify JWT từ Authorization header.
2. Lấy userId/email từ nguồn xác thực đáng tin, không đọc từ payload.
3. Kiểm tra email đã xác minh, domain OU và profile.status == ACTIVE.
4. Kiểm tra role ADMIN nếu là admin action.
5. Validate input bằng schema runtime, kiểm tra quyền sở hữu/thao tác.
6. Thực hiện query/transaction atomically.
7. Map DB row -> DTO allowlist; không serialize DB row nguyên gốc.
8. Trả error code nhất quán, không log thông tin nhận diện.
```

**Tình huống biên:** page cursor giả, query rất lớn, bài bị admin ẩn giữa lúc upload/vote, post đổi trạng thái, signed URL hết hạn, click liên tục, request timeout, tài khoản bị cấm sau khi có JWT, báo cáo trùng.
