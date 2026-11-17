# TheOU — Bộ tài liệu phát triển Prototype và MVP

> **Ngôn ngữ làm việc: tiếng Việt.** Tên biến, tên bảng, tên hàm và giá trị enum sử dụng tiếng Anh để thuận tiện lập trình; nội dung sản phẩm, UI, tài liệu, task, PR và báo cáo kiểm thử ưu tiên tiếng Việt.

**Phiên bản tài liệu:** 1.1 — 15/11/2026

**Trạng thái:** T01 đã có nền tảng frontend; T02 **COMPLETED** ngày 15/11/2026: migration/catalog Cloud đạt, offline 22/22 PASS, Cloud integration 8/8 PASS theo xác nhận chủ dự án; cleanup đã xác minh read-only. Xem [báo cáo T02](docs/reports/T02-STATUS-REPORT.md).

**T03 — COMPLETED 16/11/2026:** đăng ký email OU + mật khẩu → OTP xác minh; đăng nhập mật khẩu, passwordless bị chặn phía server. Offline gần nhất 47/47 PASS; signup/OTP sau đổi settings được theo dõi tại T05 khi có OU account mới. Xem [nghiệm thu T03](docs/reports/T03-STATUS-REPORT.md).

**T04 — COMPLETED — PASS 16/11/2026:** social-api/getMe đã deploy, smoke và BANNED/ADMIN/RACE Cloud PASS theo chủ dự án; cleanup khớp baseline. Offline gần nhất 99/99 PASS. Xem [nghiệm thu T04](docs/reports/T04-STATUS-REPORT.md).
**Sản phẩm:** Mạng xã hội độc lập cho cộng đồng sở hữu email OU; không đại diện hay được bảo trợ bởi Trường Đại học Mở TP.HCM.

## Cấu trúc repository và chạy frontend

**T05 — COMPLETED — PASS 16/11/2026:** UI login/signup/OTP/profile đã được chủ dự án duyệt; Cloud updateNickname và signup/OTP regression sau tắt passwordless đã PASS. Xem [nghiệm thu T05](docs/reports/T05-STATUS-REPORT.md) và [prototype/conventions](docs/fe-templates/README.md).

**T06 — COMPLETED — PASS 16/11/2026:** migration/Edge, smoke A/B, controlled writes, DB verification và cleanup đã nghiệm thu; baseline cuối users=2/profiles=2/roles=0/posts=0. Xem [nghiệm thu T06](docs/reports/T06-STATUS-REPORT.md).

**T07 — COMPLETED — PASS 17/11/2026:** Feed/Composer đã được chủ dự án duyệt6/6 UI checklist, A/B Cloud E2E đạt. Hai bài PUBLISHED được giữ lại theo quyết định chủ dự án, không cleanup. Xem [nghiệm thu T07](docs/reports/T07-STATUS-REPORT.md).

**T08 — COMPLETED — PASS (17/11/2026):** Comments API/UI được chủ dự án phê duyệt; frontend54/54, Supabase179/179 offline PASS. Cloud smoke/create/R1 và R2 delete/count đã đạt; chủ dự án xác nhận cleanup sáu fixture, cuối còn hai posts PUBLISHED/hai comments (VISIBLE1/DELETED1), counts1/0, mismatch0. **Giữ hai bài T07 và hai comment thủ công T08**, không cần cleanup thêm. Social UI V2 là thiết kế riêng chưa tích hợp React; không tính hoàn thành V2 hoặc toàn Prototype. Xem [nghiệm thu T08](docs/reports/T08-STATUS-REPORT.md) và [bằng chứng Cloud](docs/reports/T08-B-CLOUD-TESTS.md).

**UI-V2 — Post-T08 / Pre-T09: COMPLETED — PASS (17/11/2026).** Frontend54/54 và ba browser scripts offline PASS tại A; chủ dự án xác nhận visual6/6 và Cloud read-only regression6/6 PASS tại B. Ghi chú V2 chưa tích hợp trong snapshot nghiệm thu T08 phía trên là trạng thái trước task này. Xem [nghiệm thu UI-V2](docs/reports/UI-V2-STATUS-REPORT.md). **T09-A local completed / pending review**: toggleUpvote/trigger atomic và UI optimistic đã có local; Supabase193/193 và frontend63/63 PASS, chưa deploy/push migration/gọi Cloud. Xem [báo cáo T09-A](docs/reports/T09-A-IMPLEMENTATION.md). Không suy ra T09/W2/Prototype đã hoàn thành.

```text
TheOU/
├── frontend/    # React + Vite + TypeScript, cấu hình và test frontend
├── supabase/    # Migrations, tests DB/Auth/API, Edge Function social-api
├── docs/        # 7 tài liệu đặc tả tiếng Việt
├── .github/     # CI kiểm tra frontend
├── .gitignore
├── AGENTS.md
└── README.md
```

Dùng Node.js >= 22.18 (CI dùng 24). Trong `frontend/`, chạy `npm ci`, tạo `.env.local` từ `.env.example` nếu chưa có, điền URL và publishable key rồi chạy `npm run dev`. Xem [hướng dẫn frontend](frontend/README.md) để cấu hình và chạy lint/typecheck/test/build.

Chỉ đưa publishable key vào frontend; không commit `.env.local`, secret/service-role key hay signing keys. Frontend gọi nghiệp vụ bằng adapter `createSocialApi`; không truy cập bảng trực tiếp. Development dùng **Supabase Cloud TheOU-dev**, không Docker/Local Stack. Xem [hướng dẫn Supabase](supabase/README.md) để kiểm tra offline và review trước khi triển khai Cloud.

## Mục tiêu theo mốc

| Mốc | Thời gian | Kết quả phải có |
|---|---|---|
| **Prototype** | Tuần 1–2 | Hai tài khoản OU đăng ký mật khẩu, xác minh OTP rồi đăng nhập mật khẩu → bảng tin → đăng ẩn danh → bình luận/upvote → phản hồi với nhãn Chủ bài; có tag, ảnh và công cụ admin gỡ nội dung tối thiểu; chạy online trong nhóm test khép kín. |
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
- Auth: đăng ký email `@ou.edu.vn` + mật khẩu, OTP 6 số xác minh đăng ký; đăng nhập email + mật khẩu, không OTP. Xác minh domain ở server; phải cấu hình nhà cung cấp email trước beta.
- Feed: một luồng chung, 2 cách sắp xếp **Mới nhất / Nổi bật 24h**, 5 tag cố định.
- Nội dung: text tối đa **1.000 ký tự**, tối đa **2 ảnh**, mỗi ảnh tối đa **2 MiB** sau xử lý.
- Tương tác: **upvote, không downvote** trong MVP; không tự ẩn chỉ vì nhiều report.
- Danh tính: **Ẩn danh (mặc định)** hoặc **Hiện biệt danh**; không bao giờ công khai email, MSSV, `author_id`.
- Mọi truy cập dữ liệu nghiệp vụ qua Edge Function `social-api`; frontend không gọi trực tiếp bảng nghiệp vụ bằng `.from(...)`.

## Tham khảo kỹ thuật chính (đối chiếu ngày 13/11/2026)

- Email OU: https://docs.ou.edu.vn/books/huong-dan-sinh-vien-su-dung-cac-dich-vu-tien-ich/page/thong-tin-cac-loai-tai-khoan-danh-cho-sinh-vien
- Supabase email/password: https://supabase.com/docs/guides/auth/passwords
- Template OTP xác minh signup: https://supabase.com/docs/guides/auth/auth-email-templates
- Before User Created Hook: https://supabase.com/docs/guides/auth/auth-hooks/before-user-created-hook
- SMTP: https://supabase.com/docs/guides/auth/auth-smtp
- Edge Function auth: https://supabase.com/docs/guides/functions/auth
- RLS/grants: https://supabase.com/docs/guides/database/postgres/row-level-security
- Private Storage: https://supabase.com/docs/guides/storage/buckets/fundamentals

> **Lưu ý vận hành:** Các nguồn của trường có thể thay đổi theo khóa học; kiểm chứng việc nhận OTP ở tài khoản OU đang hoạt động trước khi mở đăng ký.


## Bổ sung, tập trung vào giá trị cốt lõi của TheOU
TheOU tập trung vào hai giá trị:
- Tính cộng đồng: Đọc những câu chuyện, tình cảm, sự kiện, share meme và vấn đề mà chỉ sinh viên OU mới thấy gần gũi.
- Tính hữu ích: Tìm lại bài về môn học, tài liệu, kinh nghiệm, câu hỏi đã được giải đáp một cách dễ dàng.
