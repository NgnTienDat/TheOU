# 06 — Hợp đồng API và Data Access

**Mục tiêu:** UI phụ thuộc vào interface ứng dụng, không phụ thuộc trực tiếp PostgreSQL/Edge Functions. Có thể thay triển khai bằng NestJS về sau mà không thay đổi luồng UI.

## 1. Quy ước chung

- Dữ liệu Auth (`signInWithOtp`, `verifyOtp`, `signOut`) do `supabase.auth` đảm nhiệm trực tiếp.
- Nghiệp vụ sử dụng `supabase.functions.invoke('social-api', { body: { action, payload } })` với JWT người dùng; **mọi action đều POST JSON**.
- `social-api` yêu cầu user JWT; sau khi xác thực, kiểm tra email OU, profile `ACTIVE`, role nếu cần. Không có truy cập nội dung social cho khách.
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

Pseudocode chung:

```text
1. Verify JWT từ Authorization header.
2. Lấy userId/email từ nguồn xác thực đáng tin, không đọc từ payload.
3. Kiểm tra domain OU và profile.status == ACTIVE.
4. Kiểm tra role ADMIN nếu là admin action.
5. Validate input bằng schema runtime, kiểm tra quyền sở hữu/thao tác.
6. Thực hiện query/transaction atomically.
7. Map DB row -> DTO allowlist; không serialize DB row nguyên gốc.
8. Trả error code nhất quán, không log thông tin nhận diện.
```

**Tình huống biên:** page cursor giả, query rất lớn, bài bị admin ẩn giữa lúc upload/vote, post đổi trạng thái, signed URL hết hạn, click liên tục, request timeout, tài khoản bị cấm sau khi có JWT, báo cáo trùng.
