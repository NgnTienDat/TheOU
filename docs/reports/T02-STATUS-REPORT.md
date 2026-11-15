# T02 — Tổng kết Database Schema & Security

**Trạng thái: COMPLETED — PASS. Ngày nghiệm thu: 15/11/2026.**

**Project:** TheOU-dev — `puhkisyehspcmgzerutm`. Giai đoạn A và phần DB của Giai đoạn B đã hoàn thành: migration được áp dụng, catalog đạt, Cloud integration **8/8 PASS, 0 FAIL** theo xác nhận của chủ dự án và cleanup đã được kiểm tra độc lập bằng truy vấn chỉ đọc.

## 1. Checklist nghiệm thu

| Giai đoạn | Hạng mục | Kết quả và bằng chứng |
|---|---|---|
| A | Schema, constraints, indexes | Hoàn thành: 9 bảng, 9 PK, 13 FK, 5 UNIQUE, 28 CHECK; 8 index riêng, 22 index gồm PK/UNIQUE theo kiểm tra catalog trước đó |
| A | RLS/grants và helper triggers | Hoàn thành: chặn raw-table client; service-role CRUD trên 8 bảng, SELECT/INSERT audit; helper SECURITY INVOKER |
| A | F-01/F-02/F-03 và CF-01 | Hoàn thành: guard ref dev, đọc fixture thật, regression default privileges và ngoại lệ event trigger hẹp |
| A | Typecheck và offline tests | **PASS: 22/22, 0 FAIL**, đã chạy sau sửa fixture/password ở lượt trước; không chạy lại trong lượt chốt tài liệu |
| B | Migration Cloud | Hoàn thành: history vừa xác nhận `20261113170214`, name `t02_schema_security` |
| B | Cloud catalog checks | **PASS** tại deployment; đã đối chiếu schema/policies/grants bằng SELECT ở lượt status trước |
| B | Cloud integration A/B | **PASS: 8/8, 0 FAIL**, chủ dự án xác nhận đã chạy thành công; không chạy lại hoặc đọc log chi tiết trong lượt này |
| B | Cleanup Auth/business fixtures | **PASS**, xác minh độc lập 15/11/2026: Auth users/identities T02 = 0; cả 9 bảng = 0 dòng |
| A/B | Nghiệm thu T02 | **COMPLETED** trong phạm vi Database Schema & Security |

22 test offline gồm 5 test cấu hình, 16 subtest schema và một test cha. Suite Cloud kiểm tra phiên Auth thật, server CRUD, từ chối truy cập trực tiếp guest/A/B, ownership bất biến, constraints và bảo vệ identity ở tầng DB. A/B đều không được truy cập raw table, kể cả nội dung của mình; authorization qua social-api thuộc các task tiếp theo.

## 2. Bằng chứng cleanup read-only

CLI 3.1.0 projects list xác nhận **TheOU-dev, linked=true, ACTIVE_HEALTHY**. Dùng `db query --remote=puhkisyehspcmgzerutm --read-only` với SELECT history và số đếm; kết quả `transaction_read_only=on`.

| Phạm vi kiểm tra | Số bản ghi còn lại |
|---|---:|
| Auth users có email chứa `+theou-t02-` hoặc bắt đầu `theou-t02-` | 0 |
| Auth identities có email mang các dấu T02 trên | 0 |
| profiles, user_roles, posts, comments, post_votes | Mỗi bảng 0 |
| post_images, reports, moderation_actions, rate_limit_counters | Mỗi bảng 0 |

Không đọc/lưu email cụ thể hoặc credentials. Không xóa dữ liệu, chạy integration hoặc sửa Cloud trong lượt xác minh này. Log vận hành Auth của request thử không thuộc fixture và không bị xóa.

Migration local đã được đối chiếu SHA-256 ở các lượt trước:

```text
1FE271E7D438AE8E66F23F4EA3C300672C757D4139C0AD2BC88E1F8993499148
```

## 3. Lịch sử và giới hạn

Các lần FAIL trước tại createUser là lịch sử, được giữ trong [báo cáo deployment](T02-DEPLOYMENT-INTEGRATION.md) và [review](../T02-FINAL-REVIEW.md). Fixture hiện dùng Gmail alias từ env; password đã giảm từ 78 byte vượt giới hạn Auth xuống 41 byte. Kết quả Cloud 8/8 mới do chủ dự án cung cấp thay thế trạng thái FAIL trước đó; cleanup hiện tại được agent kiểm tra trực tiếp.

T02 không chứng minh OTP/domain OU, BANNED, DTO ẩn danh của social-api, OP, Storage/EXIF, publish ảnh READY, count/rate-limit atomic hoặc xóa tài khoản đã hoạt động. Các phần đó thuộc task tương ứng sau T02. CI GitHub chưa được xác minh trong lượt này.

**Đã hoàn tất nghiệm thu T02. Không triển khai T03 trong lượt này.**
