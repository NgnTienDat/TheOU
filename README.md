# TheOU — Bộ tài liệu phát triển Prototype và MVP

> **Ngôn ngữ làm việc: tiếng Việt.** Tên biến, tên bảng, tên hàm và giá trị enum sử dụng tiếng Anh để thuận tiện lập trình; nội dung sản phẩm, UI, tài liệu, task, PR và báo cáo kiểm thử ưu tiên tiếng Việt.

**Phiên bản tài liệu:** 1.0 — 13/11/2026

**Trạng thái:** Đã bổ sung nền tảng frontend T01; chưa triển khai nghiệp vụ hoặc mở hệ thống cho người dùng.
**Sản phẩm:** Mạng xã hội độc lập cho cộng đồng sở hữu email OU; không đại diện hay được bảo trợ bởi Trường Đại học Mở TP.HCM.

## Cấu trúc repository và chạy frontend

```text
TheOU/
├── frontend/    # React + Vite + TypeScript, cấu hình và test frontend
├── supabase/    # config.toml; migrations/, functions/, tests/ đang giữ chỗ
├── docs/        # 7 tài liệu đặc tả tiếng Việt
├── .github/     # CI kiểm tra frontend
├── .gitignore
├── AGENTS.md
└── README.md
```

Dùng Node.js >= 22.18 (CI dùng 24). Trong `frontend/`, chạy `npm ci`, tạo `.env.local` từ `.env.example` nếu chưa có, điền URL và publishable key rồi chạy `npm run dev`. Xem [hướng dẫn frontend](frontend/README.md) để cấu hình và chạy lint/typecheck/test/build.

Chỉ đưa publishable key vào frontend; không commit `.env.local`, secret/service-role key hay signing keys. T01 chỉ khai báo hợp đồng `SocialApiClient`, chưa gọi dữ liệu nghiệp vụ. Thư mục `supabase/` chưa có schema/migration; cấu hình CLI hiện có vẫn là mặc định phát triển, cần hoàn thiện quyền và Auth ở T02–T03 trước khi cho người dùng truy cập.

## Mục tiêu theo mốc

| Mốc | Thời gian | Kết quả phải có |
|---|---|---|
| **Prototype** | Tuần 1–2 | Hai tài khoản OU dùng được luồng OTP → bảng tin → đăng ẩn danh → bình luận/upvote → phản hồi với nhãn Chủ bài; có tag, ảnh và công cụ admin gỡ nội dung tối thiểu; chạy online trong nhóm test khép kín. |
| **MVP beta** | Tuần 3–4 | Hoàn thiện report, kiểm duyệt, chống spam/rate limit, bảo mật và trải nghiệm mobile; mở thử nghiệm giới hạn sau khi vượt kiểm thử. |

**Không thuộc phạm vi 4 tuần:** kết bạn, theo dõi, nhắn tin nội bộ, thông báo push, video, AI recommendation, marketplace có giỏ hàng/thanh toán, tìm kiếm full-text, dashboard phân tích phức tạp, app native.

## Đọc tài liệu theo thứ tự

1. [`docs/01-PRD.md`](docs/01-PRD.md): mục tiêu, quy tắc sản phẩm, phạm vi và KPI.
2. [`docs/02-USER-STORIES.md`](docs/02-USER-STORIES.md): user stories, acceptance criteria, trường hợp lỗi.
3. [`docs/03-UI-UX-SPEC.md`](docs/03-UI-UX-SPEC.md): màn hình, luồng và trạng thái giao diện.
4. [`docs/04-ARCHITECTURE.md`](docs/04-ARCHITECTURE.md): kiến trúc, kỹ thuật, cách chuyển dần sang backend riêng.
5. [`docs/05-DATABASE-SECURITY.md`](docs/05-DATABASE-SECURITY.md): mô hình dữ liệu, bảo mật và quy tắc ẩn danh.
6. [`docs/06-API-CONTRACT.md`](docs/06-API-CONTRACT.md): hợp đồng dữ liệu và các thao tác từ frontend.
7. [`docs/07-IMPLEMENTATION-PLAN.md`](docs/07-IMPLEMENTATION-PLAN.md): backlog 4 tuần, test gate, Definition of Done.

[`AGENTS.md`](AGENTS.md) là chỉ dẫn làm việc cho Codex, **không thay thế** các tài liệu nguồn.

## Quy tắc giải quyết mâu thuẫn

1. Bảo mật và bảo vệ danh tính trong `05-DATABASE-SECURITY.md` không được đánh đổi để đẩy nhanh tiến độ.
2. `01-PRD.md` quyết định phạm vi; `02-USER-STORIES.md` quyết định hành vi; `06-API-CONTRACT.md` quyết định hợp đồng kỹ thuật.
3. Khi tài liệu mâu thuẫn: dừng thay đổi có rủi ro, đề xuất bản sửa trước khi code.
4. Không tự thêm tính năng ngoài P0/P1 được định nghĩa.

## Quyết định đã chốt

- Frontend: **React + Vite + TypeScript + Tailwind CSS**, React Router, TanStack Query.
- Backend giai đoạn đầu: **Supabase Auth + PostgreSQL + Storage + Edge Functions**. Chưa có NestJS/Spring Boot riêng.
- Email: OTP qua `@ou.edu.vn`, xác minh domain ở server; phải cấu hình nhà cung cấp email trước khi chạy beta.
- Feed: một luồng chung, 2 cách sắp xếp **Mới nhất / Nổi bật 24h**, 5 tag cố định.
- Nội dung: text tối đa **1.000 ký tự**, tối đa **2 ảnh**, mỗi ảnh tối đa **2 MiB** sau xử lý.
- Tương tác: **upvote, không downvote** trong MVP; không tự ẩn chỉ vì nhiều report.
- Danh tính: **Ẩn danh (mặc định)** hoặc **Hiện biệt danh**; không bao giờ công khai email, MSSV, `author_id`.
- Mọi truy cập dữ liệu nghiệp vụ qua Edge Function `social-api`; frontend không gọi trực tiếp bảng nghiệp vụ bằng `.from(...)`.

## Tham khảo kỹ thuật chính (đối chiếu ngày 13/11/2026)

- Email OU: https://docs.ou.edu.vn/books/huong-dan-sinh-vien-su-dung-cac-dich-vu-tien-ich/page/thong-tin-cac-loai-tai-khoan-danh-cho-sinh-vien
- Supabase email OTP: https://supabase.com/docs/guides/auth/auth-email-passwordless
- Before User Created Hook: https://supabase.com/docs/guides/auth/auth-hooks/before-user-created-hook
- SMTP: https://supabase.com/docs/guides/auth/auth-smtp
- Edge Function auth: https://supabase.com/docs/guides/functions/auth
- RLS/grants: https://supabase.com/docs/guides/database/postgres/row-level-security
- Private Storage: https://supabase.com/docs/guides/storage/buckets/fundamentals

> **Lưu ý vận hành:** Các nguồn của trường có thể thay đổi theo khóa học; kiểm chứng việc nhận OTP ở tài khoản OU đang hoạt động trước khi mở đăng ký.
