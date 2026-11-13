# 07 — Kế hoạch triển khai 4 tuần, kiểm thử và nghiệm thu

**Ngày bắt đầu giả định:** từ khi repo và bộ tài liệu được chốt; mốc W1–W4 tính theo tuần phát triển, không gắn cứng ngày lịch.  
**Nguồn lực:** 1 developer + Codex; ưu tiên luồng hoạt động và bảo vệ danh tính hơn hiệu ứng giao diện.

## 1. Nguyên tắc thực thi

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
| T02 | Tạo Supabase project local/staging, migration schema + RLS/grants | T01 | `anon`/`authenticated` không đọc raw tables |
| T03 | Cấu hình Auth OTP, email template, SMTP và Before User Created Hook OU | T02 | Email đúng nhận mã; email ngoài OU bị chặn server-side |
| T04 | Xây `social-api` auth guard, error wrapper, `getMe` | T02,T03 | JWT lỗi/banned bị từ chối |
| T05 | UI đăng nhập/OTP, route guard, profile nickname | T03,T04 | Hoàn thành onboarding bằng OU account |
| T06 | `createPost` draft, `publishPost`, `listPosts`, `getPost` text | T04 | A đăng ẩn danh, B thấy bài, không lộ author ID |
| T07 | Feed mobile-first, tab mới/nổi bật, tag, composer text | T06 | Đọc và đăng bài text E2E |

**Gate W1:** 2 email OU có thể đăng nhập, A đăng text ẩn danh, B đọc feed; thử request trực tiếp không có JWT và direct DB access bị chặn. Chỉ chuyển W2 sau khi chứng minh dữ liệu identity không rò rỉ qua DTO.

**Kiểm tra T01 tại máy (13/11/2026):** `lint`, `typecheck`, `test` (6 test cấu hình môi trường), `build` đều thành công. Dev server khởi động và trả HTTP 200 cho HTML và các module chính. Đã kiểm tra Git bỏ qua env riêng và quét các file tracked/unignored tìm credentials. Chưa chạy CI trên GitHub, chưa kiểm thử giao diện bằng trình duyệt hoặc kết nối Supabase thật. `npm audit` báo 10 cảnh báo moderate trong chuỗi công cụ ESLint/TypeScript ESLint liên quan `minimatch`; chưa áp dụng downgrade/major change tự động. T01 không chứng minh gate W1 hay các user story nghiệp vụ đã hoàn thành. Task tiếp theo: **T02 — schema, RLS/grants và test quyền truy cập**.

### W2 — Tương tác, ảnh, công cụ admin, nghiệm thu Prototype

| ID | Công việc | Phụ thuộc | Tiêu chí xong |
|---|---|---|---|
| T08 | `listComments`, `createComment`, `deleteComment`; UI comment | T06 | B bình luận, A phản hồi với nhãn Chủ bài |
| T09 | `toggleUpvote` atomic, optimistic UI + rollback | T06 | Click trùng không tạo nhiều vote |
| T10 | Tải ảnh private, signed upload/finalize/read, xóa metadata | T06 | Đăng và xem được tối đa 2 ảnh |
| T11 | Xóa mềm bài, xóa mềm comment, admin hide/audit tối thiểu | T08 | Admin ẩn nội dung, người thường không làm được |
| T12 | Test E2E, test quyền truy cập, responsive + sửa lỗi | T08–T11 | Gate Prototype đủ 7 bước và test bảo mật |
| T13 | Deploy staging và hướng dẫn chạy/rollback | T12 | Link HTTPS được bảo vệ, test 2 tài khoản OU |

**Gate W2 — Prototype:** xem checklist ở mục 3. Chỉ mời nhóm test nhỏ, có admin trực để xử lý vấn đề.

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

### Tiền điều kiện

- Tài khoản A và B là **hai email OU khác nhau**, đã nhận OTP và xác thực thành công.
- Một tài khoản Admin được cấp quyền từ DB, không tự gán quyền qua payload.
- Database staging mới, seed hợp lệ, không dùng dữ liệu cá nhân thật ngoài test account được đồng ý.

### Checklist

- [ ] 01. A đăng nhập OTP, vào `/`.
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
| Tài khoản OU không có người test | Tạo email/OTP giả chỉ cho unit/local; không coi là E2E thật |
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
# Tạo/khởi động Supabase local theo hướng dẫn CLI phiên bản đang dùng
# Chạy migrations, DB permission tests và E2E tại staging
```

Các script trên đã khai báo trong `frontend/package.json`. Cần điền `frontend/.env.local` theo `.env.example` trước dev/build; CI dùng cấu hình công khai giả, không cần secret. Workflow `.github/workflows/frontend.yml` chạy lint, typecheck, unit test và build; chưa deploy, chưa kiểm thử DB/Edge/E2E. Không coi việc có workflow là bằng chứng CI đã chạy trên GitHub. Migrations và kiểm thử quyền thuộc T02 trở đi.

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
