# Hướng dẫn cho Codex — TheOU

## Ngôn ngữ
- **Ưu tiên tiếng Việt** trong giao diện, nội dung sản phẩm, comment mô tả nghiệp vụ, tài liệu, kế hoạch và báo cáo.
- Dùng tiếng Anh cho tên code (`camelCase`, `PascalCase`, `snake_case`), tên thư viện, API keys, bảng, enum để giữ tiêu chuẩn kỹ thuật; không dịch cú pháp hoặc tên API.
- Thông báo lỗi hiển thị cho sinh viên viết bằng tiếng Việt, dễ hiểu; tuyệt đối không lộ chi tiết backend/SQL.

## Trước khi bắt đầu mỗi task
1. Đọc `README.md` và các mục liên quan trong `docs/01-PRD.md` → `docs/07-IMPLEMENTATION-PLAN.md`.
2. Xác định ID user story, task, mốc Prototype/MVP và tiêu chí nghiệm thu.
3. Nêu file dự kiến sửa, migrations và test cần có; chia nhỏ nếu task vượt một feature.
4. Không tự bổ sung thư viện, dịch vụ trả phí, màn hình hay tính năng ngoài scope nếu chưa được yêu cầu.

## Quy tắc không được vi phạm
- Không đưa secret key/service-role key vào trình duyệt, mã client, log hay repository.
- Không để response công khai của bài viết/bình luận chứa `author_id`, email, MSSV, user metadata, storage path có thể nhận diện tài khoản.
- Không cho client đọc/ghi trực tiếp các bảng nghiệp vụ: kiểm soát grants + RLS, Edge Function là cổng dữ liệu.
- Không xem OTP/email domain trên frontend là đủ an toàn; xác thực lại ở server trên mỗi yêu cầu.
- Với truy vấn bằng quyền admin/service-role, tự kiểm tra quyền sở hữu, phạm vi truy cập và trạng thái tài khoản; service-role bỏ qua RLS.
- Migration thay đổi quyền bảng phải có kiểm thử trường hợp bị từ chối và trường hợp được phép.
- Không mặc định ẩn bài chỉ theo số upvote/report; mọi hành động admin phải có audit.
- Không dùng dữ liệu cá nhân thật trong seed và ảnh chụp màn hình.

## Quy tắc triển khai
- Mọi task frontend phải tham khảo UI conventions và prototype đã duyệt tại `docs/fe-templates/README.md`; giữ thiết kế, thay hành vi demo bằng nghiệp vụ thật.
- Kiến trúc theo feature, không gọi Supabase trực tiếp trong component UI.
- Mọi thay đổi DB dùng `supabase/migrations/` và có thể chạy lại trên môi trường sạch.
- Chia `social-api` thành module theo nghiệp vụ, không nhồi tất cả logic vào một file.
- Xử lý đầy đủ `loading`, `empty`, `error`, `retry`, input validation và thao tác trùng lặp.
- Bảo vệ dữ liệu ẩn danh với cả test API/schema; test hành vi UI chưa đủ.
- Khi code lệch tài liệu: cập nhật tài liệu trong cùng thay đổi, ghi rõ lý do.

## Kết thúc task
Báo cáo bằng tiếng Việt: (1) Đã làm gì; (2) file/migration thay đổi; (3) test và lệnh đã chạy cùng kết quả; (4) giới hạn/rủi ro chưa xử lý; (5) tiêu chí nghiệm thu được đáp ứng. Không tuyên bố đã pass nếu chưa chạy test.
