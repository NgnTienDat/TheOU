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

Status HTTP tương ứng nếu có: 401/403/400/404/409/429/500. Không đưa SQL, JWT hoặc email của người khác vào `details`.

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
  contactUrl: string | null;      // null nếu anonymous/không hợp lệ
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

### Phạm vi triển khai T04-A — chỉ `getMe`

POST JSON `{ "action": "getMe", "payload": {} }`; không chấp nhận field thừa ở envelope/payload, body tối đa 4 KiB. Action khác hoặc request/method/content-type sai trả VALIDATION_ERROR/400. Guard từ chối JWT thiếu/sai/hết hạn bằng UNAUTHENTICATED/401; email ngoài OU/chưa xác minh hoặc BANNED bằng FORBIDDEN/403. Lỗi Auth/DB hệ thống trả INTERNAL_ERROR/500 với thông báo chung; không đưa response gốc vào details/log.

Data đúng ba trường `{ "nickname": "OUer-1234", "emailMasked": "***@ou.edu.vn", "isAdmin": false }`, không trả UUID/email đầy đủ/metadata. EmailMasked chỉ thuộc chính chủ; che toàn bộ local part để không lộ MSSV. Profile thiếu được insert an toàn, giữ hàng thắng khi concurrent/retry; profile đã tồn tại không bị thay đổi. Role ADMIN chỉ đọc từ DB.

OPTIONS cho origin Vite được cho phép trả 204, không đọc Auth/DB; không có action dữ liệu public. CORS theo origin đầy đủ trong THEOU_ALLOWED_ORIGINS, mặc định localhost/127.0.0.1:5173; CORS không thay thế JWT. Response handler có Cache-Control: no-store, requestId UUID do server tạo. Gateway giữ verify_jwt=true và có thể trả 401 theo định dạng nền tảng trước khi handler chạy; adapter frontend cần xử lý lỗi gateway riêng. Các action còn lại trong bảng mục 3 là thiết kế, chưa triển khai.

## 4. Các thao tác cần atomic và idempotent

- `createPost`: client tạo `idempotencyKey` UUID khi bắt đầu submit; request cùng `(author_id,key)` trả về **cùng một draft**, không tạo thêm.
- `publishPost`: gọi lại trên bài đã publish của cùng tác giả thì trả bản hiện tại; bài bị ẩn/xóa phải xử lý `CONFLICT`.
- `createComment`: unique `(author_id, idempotency_key)` để retry không nhân đôi bình luận.
- `toggleUpvote`: dùng `desiredState` thay vì “đảo trạng thái” mù. Ví dụ 2 request `{desiredState:true}` không thể bỏ vote của nhau; DB `UNIQUE(post_id,user_id)`.
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
  "meta": { "requestId": "req-demo-001" }
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

Đây là ngoại lệ có kiểm soát cho việc frontend gọi Storage SDK; frontend **không** tự chọn quyền truy cập hoặc liệt kê bucket.

## 7. API Adapter phía frontend

**Trạng thái T01:** `frontend/src/shared/api/SocialApiClient.ts` chỉ khai báo interface, input và DTO dưới đây. Chưa có adapter, mock nghiệp vụ hay request tới `social-api`. Bổ sung adapter và chuẩn hóa lỗi cùng các task T04/T06 trở đi; TypeScript không thay thế validation runtime và kiểm thử bảo vệ danh tính khi tích hợp API.

```ts
interface SocialApiClient {
  listPosts(input: ListPostsInput): Promise<Page<PostPublic>>;
  getPost(postId: string): Promise<PostPublic>;
  createPost(input: CreatePostInput): Promise<{ postId: string; status: 'DRAFT' }>;
  publishPost(postId: string): Promise<PostPublic>;
  listComments(postId: string, cursor?: string): Promise<Page<CommentPublic>>;
  createComment(input: CreateCommentInput): Promise<CommentPublic>;
  setUpvote(postId: string, desiredState: boolean): Promise<{ hasUpvoted: boolean; upvoteCount: number }>;
}
```

Các phương thức còn lại tuân theo cùng mẫu. `SupabaseSocialApiClient` ánh xạ interface này sang `social-api` actions. Khi chuyển NestJS, viết `HttpSocialApiClient` nhưng giữ DTO và hook UI. Chuẩn hóa exception trong adapter, không để component trực tiếp xử lý lỗi Supabase thô.

## 8. Bảo mật bắt buộc ở mỗi action

T02 khóa mọi truy cập bảng trực tiếp và giữ ownership bất biến bằng trigger. T04-A có getMe/guard và tests HTTP offline, chưa deploy Edge Cloud. Khi triển khai T04-B/T06/T08/T11 phải thêm test với phiên thật theo phạm vi: getMe chính chủ; A tạo/xóa nội dung của mình, B không xóa được; không nhận `authorId` từ payload; DTO của nhiều bài ẩn danh không lộ khóa nối tác giả; nhãn `Chủ bài` được tính phía server. Test CRUD bằng service-role của T02 không thay thế các test này. Các lỗi SQL/constraint trong migration chỉ phục vụ server, phải được map sang mã lỗi/message an toàn ở adapter/Edge Function.

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
