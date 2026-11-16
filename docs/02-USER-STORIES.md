# 02 — User Stories & Tiêu chí nghiệm thu

**Quy ước:** `P0-P` = bắt buộc trong Prototype; `P0-M` = bắt buộc để mở MVP beta. `AC` = acceptance criterion; mỗi AC phải kiểm tra được. Nội dung UI bằng tiếng Việt.

## Nhóm A — Xác thực và hồ sơ

### US-01 — Đăng ký và đăng nhập bằng email OU, mật khẩu (P0-P)
**Là** người có email OU, **tôi muốn** đăng ký bằng email và mật khẩu, xác minh email một lần bằng OTP **để** đăng nhập những lần sau bằng mật khẩu, không cần OTP.

**Yêu cầu cập nhật 15/11/2026:** thay thế luồng đăng nhập không mật khẩu trước đây.

- **AC01:** Form đăng ký có email, mật khẩu và nhập lại mật khẩu. Email trim + lowercase; mật khẩu nhập ẩn, giữ nguyên khoảng trắng, tối thiểu 8 ký tự và tối đa 72 byte UTF-8. Server thực thi chính sách, không chỉ form.
- **AC02:** Đăng ký domain ngoài chính xác `@ou.edu.vn` bị frontend từ chối; **Before User Created Hook cũng từ chối** khi gọi trực tiếp `signUp` bằng Gmail. Không có ngoại lệ Gmail cho test.
- **AC03:** `signUp` chưa cấp session khi bật Confirm email; tài khoản chưa xác minh không đăng nhập được bằng đúng mật khẩu.
- **AC04:** Confirm signup gửi OTP 6 chữ số, hạn 10 phút. `verifyOtp` với mã đúng xác minh email và tạo phiên; mã sai/hết hạn không xác minh hoặc tạo session. Có gửi lại theo cooldown tối thiểu 60 giây, không đăng ký lặp để đặt lại mật khẩu.
- **AC05:** Đăng nhập dùng email + mật khẩu qua `signInWithPassword`, không gọi gửi OTP. Tài khoản OU đã xác minh có session hợp lệ thì vào ứng dụng; nickname/onboarding theo US-02.
- **AC06:** Mật khẩu sai hoặc tài khoản không tồn tại dùng thông báo chung, không tạo session. Tài khoản chưa xác minh được hướng dẫn hoàn tất xác minh đăng ký.
- **AC07:** Không ghi mật khẩu, OTP, JWT vào source, file, log/analytics hoặc app DB; không đưa chúng vào URL. Email không xuất hiện trên feed.
- **AC08:** Logout dọn session phía app; route và social API vẫn yêu cầu phiên hợp lệ. Không tuyên bố access token cũ mất hiệu lực ngay lập tức.
- **AC09:** Tài khoản `BANNED`, email ngoài OU hoặc chưa xác minh không dùng được social API kể cả khi có JWT.
- **AC10:** Quên/đổi mật khẩu chưa triển khai trong T03. Tài khoản OTP cũ chưa có mật khẩu cần quyết định chuyển đổi riêng, không tự xóa hoặc dùng đăng ký lại để thay mật khẩu.

### US-02 — Tạo biệt danh (P0-P)
- Lần đầu vào ứng dụng, hệ thống cấp biệt danh mặc định an toàn kiểu `OUer-1234`; có thể sửa trong màn hình cá nhân nhỏ.
- Biệt danh dài 3–30 ký tự, trim, không chứa URL/điều khiển; không lấy email làm mặc định.
- Biệt danh chỉ hiện trên các bài chọn `NICKNAME`, không làm lộ bài `ANONYMOUS`.

## Nhóm B — Bảng tin

### US-03 — Xem bảng tin (P0-P)
**Là** thành viên, **tôi muốn** đọc bài mới và bài nổi bật **để** theo dõi chuyện OU.

- **AC01:** Người chưa đăng nhập không thể truy cập dữ liệu bài qua UI hoặc social API.
- **AC02:** Tab `Mới nhất`: `published_at DESC, id DESC`; 20 bài/trang.
- **AC03:** Tab `Nổi bật 24h`: chỉ bài trong 24h, `upvote_count DESC, published_at DESC, id DESC`.
- **AC04:** Hiển thị tag, nội dung, nickname/nhãn ẩn danh, thời gian, upvote count, comment count, ảnh nếu có.
- **AC05:** Không hiển thị `author_id`, email, MSSV, trường metadata cá nhân, storage path nội bộ.
- **AC06:** Khi tải lỗi, có thông báo và nút thử lại; khi trống, có lời mời tạo bài.

### US-04 — Lọc bài theo tag (P0-P)
- Bộ lọc `Tất cả`, `Confession`, `Review môn`, `Tài liệu`, `Tìm trọ`, `Hỏi gấp`.
- Chọn một tag sẽ lọc cả 2 tab sort; đổi tag đặt lại phân trang.
- Không tạo/sửa/xóa tag từ UI; tên hiển thị tiếng Việt.

## Nhóm C — Bài viết

### US-05 — Đăng bài (P0-P)
**Là** thành viên, **tôi muốn** đăng text kèm tag và tùy chọn ảnh **để** chia sẻ với cộng đồng.

- **AC01:** Nội dung trim có độ dài 1–1000 ký tự (đếm thống nhất phía frontend/backend).
- **AC02:** Mỗi bài buộc chọn một trong năm tag; mặc định `CONFESSION`.
- **AC03:** Chế độ `ANONYMOUS` được bật mặc định khi mở composer.
- **AC04:** Với `NICKNAME`, bài hiện biệt danh tại thời điểm đăng; không hiện email/MSSV.
- **AC05:** Tối đa hai ảnh JPG/PNG/WebP, tối đa 2 MiB/ảnh; từ chối ảnh sai định dạng hoặc vượt hạn mức, không publish ảnh lỗi.
- **AC06:** Không gửi lặp bài vì bấm nút liên tục; phản hồi lỗi mà vẫn giữ nội dung người đang soạn.
- **AC07:** Contact URL chỉ chấp nhận `https://` thuộc domain cho phép (Zalo/Facebook/Messenger), và chỉ khi bài tag `TAI_LIEU` hoặc `TIM_TRO` + chế độ `NICKNAME`.
- **AC08:** Bài publish xong xuất hiện trong feed Mới nhất.

### US-06 — Xóa bài của mình (P0-P)
- Người đăng được xóa mềm bài của mình sau hộp xác nhận.
- Người khác không được xóa/sửa trạng thái bài dù gửi request trực tiếp.
- Bài đã xóa không còn trên feed, comment API công khai không tiết lộ nội dung.
- Trong 4 tuần **chưa hỗ trợ chỉnh sửa bài**; muốn sửa, người đăng xóa và đăng lại.

## Nhóm D — Tương tác

### US-07 — Bình luận (P0-P)
- Thành viên có thể đăng bình luận 1–500 ký tự dưới bài `PUBLISHED`.
- Danh sách bình luận sắp `created_at ASC, id ASC`, phân trang.
- Bình luận của chủ bài hiển thị nhãn `Chủ bài`, không tiết lộ danh tính khi bài ẩn danh.
- Bình luận của người khác hiện `OUer ẩn danh` trong Prototype (chưa có alias cá nhân ổn định xuyên bài).
- Người viết có thể xóa mềm bình luận của mình; admin có thể ẩn bình luận.
- Không thể bình luận bài `HIDDEN`/`DELETED`/`DRAFT`.
- Bình luận một tầng, **không nested reply** và không @mention ở Prototype/MVP.

### US-08 — Upvote (P0-P)
- Một tài khoản tối đa một upvote/bài (`UNIQUE(post_id, user_id)`).
- Bấm upvote khi chưa vote → tăng; bấm lại → bỏ vote, giảm.
- UI có phản hồi tức thời nhưng phải khôi phục nếu server báo lỗi.
- Không vote trên bài đã ẩn/xóa; không downvote.

## Nhóm E — Media

### US-09 — Xem ảnh bài viết (P0-P)
- Ảnh lưu trong bucket `post-media` **private**, mỗi bài tối đa hai ảnh.
- Người dùng OU đã xác thực mới lấy được signed URL ngắn hạn khi xem bài.
- Đường dẫn ảnh không chứa email/MSSV/user ID; ảnh client được tối ưu và loại bỏ EXIF nếu công cụ hỗ trợ.
- Ảnh lỗi không làm sập feed; có placeholder và nút thử lại.

## Nhóm F — Quản trị và an toàn

### US-10 — Admin ẩn nội dung (P0-P)
- Admin hợp lệ có thể ẩn bài hoặc bình luận, nhập lý do.
- Hành động ghi audit `moderation_actions` và phải được kiểm tra quyền phía server.
- Người thường không gọi được action admin, kể cả sửa payload.
- Có ít nhất một đường thao tác quản trị hoạt động trong Prototype (trang `/admin` tối giản).

### US-11 — Report nội dung (P0-M)
- Sinh viên report bài/bình luận, chọn lý do: `SPAM`, `HARASSMENT`, `PRIVACY`, `MISINFORMATION`, `COPYRIGHT`, `OTHER`.
- Một tài khoản chỉ có một report hiệu lực cho cùng target; không thấy tên người report.
- Report không tự ẩn bài; đưa vào hàng chờ admin review.
- Báo thành công và không tiết lộ tiến độ/chi tiết của người report cho người khác.

### US-12 — Quản trị report và tài khoản (P0-M)
- Admin xem danh sách report, mở nội dung, xử lý `RESOLVED`/`DISMISSED`, ẩn/gỡ nội dung, khóa account nếu cần.
- Mỗi hành động có `admin_id`, thời điểm, lý do; thao tác admin không cho phép sửa/xóa lịch sử audit bằng client.
- Người bị khóa nhận thông báo tiếng Việt chung, không thấy danh tính người report.

### US-13 — Giới hạn lạm dụng (P0-M, Prototype có cơ bản)
- Giới hạn số bài/bình luận/upvote/report trong cửa sổ thời gian; ngưỡng phải có thể cấu hình theo môi trường.
- Backend trả mã lỗi `RATE_LIMITED` + thời gian thử lại khi vượt ngưỡng; client không gửi lại liên tục.
- Có kiểm thử thao tác lặp và cạnh tranh đồng thời; không chỉ dựa vào việc disable nút UI.

## Nhóm G — Phát hành

### US-14 — Mobile-first (P0-P)
- Giao diện sử dụng tốt ở chiều rộng 360 px, 390 px, 768 px và desktop.
- Có trạng thái `loading`, `empty`, `error`; không hiện layout vỡ hoặc tràn ngang.
- Thao tác đăng bài, OTP, bình luận bằng bàn phím điện thoại dễ sử dụng.

### US-15 — Quy định cộng đồng & tuyên bố độc lập (P0-M)
- Có trang quy định cộng đồng, quyền riêng tư ngắn và kênh liên hệ báo vi phạm.
- Có dòng thông báo: **"TheOU là dự án độc lập do sinh viên phát triển, không phải kênh chính thức của Trường Đại học Mở TP.HCM."**

## Test ma trận bắt buộc

| Tình huống | Prototype | MVP |
|---|---:|---:|
| Email ngoài OU bị từ chối server-side | ✓ | ✓ |
| Đăng ký chưa xác minh không có session, không đăng nhập được bằng mật khẩu | ✓ | ✓ |
| OTP đăng ký sai/hết hạn không xác minh; OTP đúng xác minh email | ✓ | ✓ |
| Đăng nhập đúng mật khẩu không yêu cầu OTP; sai mật khẩu không có session | ✓ | ✓ |
| JWT không hợp lệ / hết hạn không đọc feed | ✓ | ✓ |
| A không xóa được bài B | ✓ | ✓ |
| A đọc ẩn danh của B không nhận `author_id`/email/MSSV | ✓ | ✓ |
| Ảnh từ bucket private không xem công khai | ✓ | ✓ |
| A không thay đổi được quyền admin trong request | ✓ | ✓ |
| Hai lần upvote đồng thời vẫn chỉ tính một | ✓ | ✓ |
| Report trùng không sinh hai report | — | ✓ |
| Người bị khóa không tạo bài/comment/vote | ✓ | ✓ |
| Danh sách report chỉ admin đọc được | — | ✓ |
| Khi xóa/ẩn bài, ảnh không tiếp tục xuất hiện trong feed | ✓ | ✓ |

**Định nghĩa pass:** kiểm tra cả UI **và** truy vấn/request trực tiếp mô phỏng client không tin cậy; nếu kiểm thử bảo mật thất bại thì không được gọi là Prototype hoàn thiện.
