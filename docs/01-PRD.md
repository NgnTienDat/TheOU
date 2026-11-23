# 01 — Tài liệu yêu cầu sản phẩm (PRD)

## Bổ sung 23/11/2026 — Guest read-only feed (Phase A local)

Theo yêu cầu owner, `/` là Feed cho guest và member; `/bang-tin` redirect về `/`, không Landing Page. Guest chỉ đọc danh sách NEW/HOT/tag/pages của bài **ANONYMOUS + PUBLISHED + ID được owner duyệt công khai**. Mặc định scope rỗng; không tự public bài cũ hoặc bài mới. Guest không có ảnh/signed URLs/contact/nickname, không mở Detail/thread, không tương tác/tạo nội dung/profile/admin. CTA đăng nhập vẫn dùng Auth OU hiện tại. Chưa nghiệm thu Cloud; mọi quy tắc Auth cho thành viên giữ nguyên. Không thay eligibility `@ou.edu.vn`. Xem [báo cáo Phase A](reports/PUBLIC-GUEST-FEED-LOCAL.md).

**Dự án:** TheOU  
**Phiên bản:** 1.1

**Ngày:** 15/11/2026
**Ưu tiên:** giao diện, tài liệu, vận hành bằng tiếng Việt.

**Thay đổi yêu cầu T03:** đăng ký bằng email OU + mật khẩu, OTP 6 số chỉ để xác minh email đăng ký; đăng nhập bằng email + mật khẩu, không yêu cầu OTP. Luồng này thay thế đăng nhập không mật khẩu trước đây. Quên/đổi mật khẩu chưa triển khai trong T03.

## 1. Tóm tắt

TheOU là một mạng xã hội **độc lập**, giới hạn người tham gia bằng email do Đại học Mở TP.HCM (OU) cấp, tạo không gian để sinh viên kể chuyện, hỏi đáp, trao đổi trải nghiệm môn học, tài liệu và nhu cầu đời sống. Sản phẩm không phải fanpage confession có admin đăng hộ: **người dùng chủ động tạo bài và phản hồi trực tiếp**. Nhu cầu cốt lõi là biết *cộng đồng OU đang nói gì*, với rào cản đăng bài thấp nhờ danh tính ẩn với người đọc.

### Tuyên bố giá trị
> **Chuyện của OU, người OU cùng bàn.** Một bảng tin riêng cho người có email OU; kể chuyện ẩn danh nếu muốn, nhận bình luận ngay, tìm những câu chuyện gần với đời sống sinh viên.

**Không được tuyên bố** TheOU là nền tảng chính thức, đại diện nhà trường hoặc xác nhận mọi tài khoản đang theo học. Email OU chỉ chứng minh quyền truy cập hộp thư tại thời điểm xác thực.

## 2. Vấn đề và giả thuyết

- Thảo luận đang phân tán trên các fanpage/group; một số confession phải chờ quản trị viên đăng hộ.
- Bài hỏi đáp và chia sẻ tài liệu bị trôi trong feed chung, khó lọc theo nhu cầu.
- Một số chủ đề nhạy cảm khiến sinh viên ngại dùng tên thật.

**Giả thuyết H1:** sinh viên muốn đọc bài về đời sống OU ít nhất vài lần/tuần nếu feed đủ sôi nổi.  
**H2:** đăng ẩn danh giúp tăng tỉ lệ tạo bài so với yêu cầu dùng tên thật.  
**H3:** tag đơn giản giúp tìm nhanh hơn bài đăng trộn lẫn trên mạng xã hội lớn.  
Tất cả là **giả thuyết phải kiểm chứng**, không phải dữ liệu đã được xác nhận.

## 3. Đối tượng

- **Sinh viên sở hữu email OU:** người đọc bài, đăng bài, bình luận, upvote.
- **Người chia sẻ tài liệu/tìm trọ:** có thể đăng bằng biệt danh và kèm liên kết liên hệ được chấp nhận.
- **Quản trị viên TheOU:** kiểm soát vi phạm, ẩn/gỡ nội dung, khóa tài khoản; được cấp quyền qua database, không tự đăng ký làm admin.

## 4. Nguyên tắc sản phẩm

1. **Một cộng đồng, một feed**; không cần follow, bạn bè hoặc nhóm nhỏ.
2. **Ẩn danh là mặc định**, nhưng hệ thống vẫn gắn với một tài khoản thật để chống lạm dụng.
3. **Mobile-first**, giao diện văn bản trước; tải nhanh trên điện thoại.
4. **Không phức tạp hóa tính năng:** upvote, bình luận, 5 tag; không AI ranking.
5. **Bảo vệ người tham gia:** quyền riêng tư, báo cáo vi phạm, quản trị có audit.
6. **Tiếng Việt mặc định** cho giao diện, chính sách và hỗ trợ.

## 5. Phạm vi tính năng và ưu tiên

| ID | Chức năng | Prototype (W1–W2) | MVP beta (W3–W4) |
|---|---|---|---|
| F01 | Đăng ký email `@ou.edu.vn` + mật khẩu, OTP xác minh; đăng nhập email + mật khẩu | P0, bắt buộc | Tối ưu onboarding & rate limit Auth |
| F02 | Feed Mới nhất / Nổi bật 24h | P0 | Tối ưu tải và phân trang |
| F03 | Bộ lọc 5 tag | P0 | Hoàn thiện trải nghiệm |
| F04 | Tạo/xóa bài text, ẩn danh/biệt danh | P0 | Hạn chế spam, audit |
| F05 | Bình luận dạng phẳng, tác giả bài hiện nhãn "Chủ bài" | P0 | Hoàn thiện xử lý tình huống lỗi |
| F06 | Upvote/bỏ upvote bài | P0 | Chống thao túng |
| F07 | Đính tối đa 2 ảnh vào bài | P0 cuối W2 | Tối ưu nén, lưu trữ, dọn file |
| F08 | Admin gỡ/ẩn bài và bình luận tối thiểu | P0 trước khi test nhiều tài khoản | Trang kiểm duyệt & log đầy đủ |
| F09 | Report bài viết và bình luận | Chưa có UI | P0 MVP |
| F10 | Rate limit ứng dụng & kiểm duyệt nội dung nâng cao | Mức an toàn cơ bản | P0 MVP |
| F11 | PWA cài đặt lên màn hình chính | Không | P2 tùy thời gian |

**Tag cố định:** `CONFESSION` (#Confession), `REVIEW_MON` (#ReviewMôn), `TAI_LIEU` (#TàiLiệu), `TIM_TRO` (#TìmTrọ), `HOI_GAP` (#HỏiGấp). Mỗi bài có **chính xác một tag**. Có thêm bộ lọc `Tất cả` tại UI, không phải tag DB.

**Nội dung và media:** body 1–1.000 ký tự sau trim, tối đa 2 ảnh JPG/PNG/WebP, mỗi ảnh không quá 2 MiB sau nén; không video/GIF động/file PDF ở MVP. Liên kết Zalo/Facebook chỉ được dùng ở bài **không ẩn danh** thuộc `TAI_LIEU` hoặc `TIM_TRO`; các tag khác không có trường contact URL.

**Danh tính hiển thị:** khi ẩn danh → `OUer ẩn danh`; khi hiện danh tính → nickname do sinh viên tự đặt, **không bao giờ là email/MSSV mặc định**. Trong bình luận của chính bài đăng, tác giả được đánh dấu `Chủ bài` cho dù đăng ẩn danh. Bình luận khác mặc định là `OUer ẩn danh`; không cung cấp ID công khai xuyên bài.

## 6. Quy tắc nghiệp vụ chính

UI Authentication T05 dùng [prototype được duyệt](fe-templates/README.md): login/signup/OTP xác minh/profile; không có preview hoặc đăng nhập mock trong sản phẩm. Bản T05-A local chưa thay thế regression signup/OTP Cloud sau khi tắt passwordless.

- Chỉ người có phiên hợp lệ, **email đã được xác minh**, domain OU hợp lệ và tài khoản `ACTIVE` được gọi social API.
- Đăng ký: email OU + mật khẩu → OTP 6 số xác minh email → tài khoản được xác minh. Bật Confirm email; trước OTP không cấp session và không cho đăng nhập bằng mật khẩu.
- Đăng nhập: email + mật khẩu, không gửi hoặc yêu cầu OTP. Mật khẩu sai không tạo session; không phân biệt công khai tài khoản không tồn tại với sai mật khẩu.
- Khi đăng ký, Before User Created Hook kiểm tra chính xác domain `ou.edu.vn` phía server; không dựa vào kiểm tra ở form. Hook không thay thế kiểm tra email đã xác minh/domain/ACTIVE trên mỗi social API request.
- Mật khẩu đăng ký tối thiểu 8 ký tự, tối đa 72 byte UTF-8; không trim/chuẩn hóa. Auth chịu trách nhiệm lưu hash; không lưu mật khẩu trong DB nghiệp vụ, file, analytics hoặc log. Cấu hình server phải thực thi cùng chính sách.
- OTP đăng ký có hạn 10 phút, gửi lại theo cooldown tối thiểu 60 giây; OTP sai/hết hạn không xác minh email. Quên/đổi mật khẩu và chuyển đổi tài khoản OTP cũ chưa nằm trong T03.
- Bài `PUBLISHED` hiển thị trên feed; `DRAFT`, `HIDDEN`, `DELETED` không hiện với người đọc thường.
- Người đăng được xóa mềm bài của mình; người bình luận được xóa mềm bình luận của mình; admin có thể ẩn/gỡ.
- Một người chỉ có **một upvote cho một bài**; bấm lại để bỏ upvote. Không có downvote trong 4 tuần.
- **Nổi bật 24h:** bài được đăng trong 24 giờ gần nhất, xếp `upvote_count DESC, published_at DESC, id DESC`; không dùng ML.
- **Không tự động ẩn bài vì có N report.** Report vào queue để admin xem.
- Nội dung có dấu hiệu lộ thông tin cá nhân, công kích cá nhân, quấy rối, spam hoặc vi phạm bản quyền được xử lý theo quy định cộng đồng.

## 7. Phạm vi loại trừ

Không: kết bạn/follow, chat, thông báo realtime, gửi email sự kiện, livestream, video, marketplace thanh toán, chia sẻ file học liệu trực tiếp, review có hệ thống theo mã môn/giảng viên, thuật toán đề xuất AI, hệ thống điểm thưởng, phân chia feed theo cơ sở/khoa, backend NestJS riêng, ứng dụng iOS/Android native.

## 8. Mục tiêu hai mốc

### Prototype sau 2 tuần — Tiêu chí nghiệm thu

1. Triển khai online **khu vực thử nghiệm khép kín** với ít nhất hai tài khoản OU riêng biệt và một admin.
2. A đăng ký email OU + mật khẩu → xác minh OTP; các lần đăng nhập dùng email + mật khẩu → tạo bài ẩn danh với một tag.
3. B đăng nhập → đọc bài A → upvote → bình luận.
4. A trở lại → trả lời bình luận; B chỉ nhìn thấy `Chủ bài`, không thể suy ra email/MSSV/user UUID qua response API.
5. Bài mới xuất hiện ở `Mới nhất`, bài trong 24h xuất hiện ở `Nổi bật` theo quy tắc.
6. Thành viên đăng/xem bài1–2ảnh; guest chỉ lấy text/counters từ danh sách được duyệt qua `public-feed`, không lấy Detail hoặc ảnh qua protected API.
7. Admin ẩn/gỡ bài hoặc bình luận vi phạm; nội dung biến mất khỏi feed/comment của người dùng thường.
8. Test bảo mật quyền truy cập, danh tính ẩn danh và ít nhất các trường hợp lỗi trọng yếu đều đạt.

### MVP beta sau 4 tuần — Tiêu chí nghiệm thu

- Bổ sung report, quản trị report, rate limit tương tác, xử lý spam cơ bản, dọn dữ liệu/media, test hồi quy đa thiết bị.
- Không có lỗ hổng mức nghiêm trọng về quyền truy cập/tiết lộ danh tính trong bộ test đã xác định.
- Có trang giới thiệu độc lập, quy định cộng đồng, chính sách riêng tư cơ bản, phương thức liên hệ để báo nội dung khẩn cấp.
- Có cơ chế xử lý lỗi và quan sát sự cố đủ để vận hành thử nghiệm giới hạn.

## 9. Chỉ số cần đo (không phải cam kết)

- Số người đăng ký và số tài khoản có hoạt động trong 7 ngày.
- Tỷ lệ đăng nhập → xem feed; xem feed → tương tác; đăng bài → có bình luận.
- Số bài/ngày, bình luận/bài, tỷ lệ bài có tương tác, thời gian có phản hồi đầu tiên.
- Tỷ lệ OTP không đến, tỷ lệ lỗi publish/upload, số report phải xử lý.
- Khảo sát nhóm test: "Bạn có lý do mở TheOU thêm lần nữa không? Vì sao?".

**Đề xuất thử nghiệm:** nhóm 20–30 sinh viên được mời, đa dạng khoa/khóa; sau khi đáp ứng các điều kiện bảo mật. Không coi mục tiêu số người dùng là bằng chứng retention.

## 10. Rủi ro và điều kiện mở beta

| Rủi ro | Giảm thiểu |
|---|---|
| Không đủ bài đăng tạo thói quen | Seeding có ghi rõ nội dung thử nghiệm; triển khai cộng đồng nhỏ trước |
| Ẩn danh bị suy ra qua email hoặc media | Edge API trả projection an toàn, ảnh không chứa đường dẫn định danh, bỏ EXIF |
| Dùng email OU nhưng không còn là sinh viên | Nêu giới hạn xác minh; cân nhắc chính sách tài khoản sau beta |
| Bắt nạt/tin giả/vi phạm riêng tư | Nội quy, report, admin action, audit, phương án xử lý khẩn |
| Spam OTP, bài và comment | Rate limit theo từng hành vi, SMTP đáng tin cậy |
| Nhầm với kênh chính thức OU | Thông báo rõ sản phẩm độc lập; cân nhắc thương hiệu/nhãn hiệu trước khi quảng bá rộng |

## 11. Điểm cần xác minh, không chặn việc viết code

1. Thử OTP với email OU đang sử dụng thực tế (`@ou.edu.vn` theo hướng dẫn của trường).
2. Chọn SMTP/provider hỗ trợ gửi email tới OU và theo dõi delivery.
3. Có được phép sử dụng logo/dấu hiệu nhận diện của trường hay không — **mặc định không sử dụng logo chính thức**.
4. Kiểm tra quy định và nghĩa vụ vận hành liên quan mạng xã hội, dữ liệu cá nhân và xử lý nội dung trước khi mở beta công khai; tài liệu này không phải tư vấn pháp lý.

**Tài liệu liên quan:** `02-USER-STORIES.md` → `07-IMPLEMENTATION-PLAN.md`.
