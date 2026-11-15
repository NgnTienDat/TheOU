# T02 — Deployment & Integration Testing

Ngày: **14/11/2026**. Môi trường: **TheOU-dev**, ref `puhkisyehspcmgzerutm`.

## Cập nhật nghiệm thu 15/11/2026: COMPLETED — PASS

Chủ dự án xác nhận Cloud integration **8/8 PASS, 0 FAIL** sau sửa fixture. Offline **22/22 PASS**; cleanup đã kiểm tra độc lập bằng SELECT read-only: không còn Auth user/identity T02 và cả chín bảng rỗng. Xem [báo cáo hiện hành](T02-STATUS-REPORT.md).

## Lịch sử deployment 14/11/2026: lần integration đầu FAIL

Các kết quả và điểm dừng dưới đây ghi nhận lần chạy đầu, không phải trạng thái nghiệm thu hiện tại.

Migration đã triển khai thành công và catalog sau triển khai đạt. Integration thất bại ngay khi tạo Auth fixture đầu tiên với mã `validation_failed`. Chưa tạo được phiên A/B, nên chưa chứng minh CRUD/authorization/ownership/privacy qua JWT và Data API thật. **T02 chưa được nghiệm thu.**

Đã dừng sau lỗi, không chạy lại, không sửa quyền, cấu hình Auth hoặc migration để làm test đạt. Sau lỗi chỉ đọc trạng thái Cloud phục vụ xác minh cleanup và báo cáo.

## 1. Xác nhận trước triển khai

- API projects list xác nhận `TheOU-dev`, linked=true, ACTIVE_HEALTHY; dùng ref tường minh trong mọi lệnh Cloud.
- SHA-256 migration khớp bản đã phê duyệt:

```text
1FE271E7D438AE8E66F23F4EA3C300672C757D4139C0AD2BC88E1F8993499148
```

- Chạy lại `db push --remote=puhkisyehspcmgzerutm --dry-run --skip-vault`: exit 0; chỉ có `20261113170214_t02_schema_security.sql`, seeds=[], roles=[]. Không có thay đổi kế hoạch so với báo cáo được duyệt.
- Nhãn cache CLI vẫn là TheOU/production; ref và tên sống từ API đúng TheOU-dev. Không relink hoặc đổi cấu hình project.

## 2. Thay đổi trên Cloud

Đã thực hiện lệnh sau theo phê duyệt của chủ dự án:

```powershell
supabase db push --remote=puhkisyehspcmgzerutm --skip-vault --yes
```

Kết quả exit 0; chỉ migration T02 được áp dụng. History sau triển khai có đúng version `20261113170214`, name `t02_schema_security`.

Migration tạo:

- Chín bảng: profiles, user_roles, posts, comments, post_votes, post_images, reports, moderation_actions, rate_limit_counters; cùng constraints/indexes đã duyệt.
- Schema `theou_private`, hai helper SECURITY INVOKER và triggers kiểm soát định danh/updated_at.
- ENABLE/FORCE RLS, restrictive client-deny policy trên chín bảng; grants CRUD cho service-role trên tám bảng, SELECT/INSERT cho audit.
- REVOKE CREATE public và default privileges của postgres đúng SQL đã duyệt, bao gồm default PUBLIC EXECUTE cho function tương lai.

Không reset/drop database, không Docker, không seed/custom roles/Vault update, không sửa migration hoặc chỉnh function có sẵn của Supabase. Fingerprint body `public.rls_auto_enable()` sau triển khai vẫn là `c44fb229ea8a6b0afd04a0a33261c16c`.

## 3. Kiểm tra schema/catalog sau triển khai

```powershell
supabase db query --remote=puhkisyehspcmgzerutm --file supabase/tests/catalog-check.sql --yes --output-format json
```

Exit 0, trả **T02 catalog checks passed**. File chỉ đọc catalog nhưng chứa DO nên CLI yêu cầu confirmation; không chạy SQL thay đổi quyền trong bước kiểm tra.

Catalog xác nhận chín bảng, ENABLE/FORCE RLS, restrictive policy, client table/column grants bị khóa, service-role có quyền theo thiết kế, audit không UPDATE/DELETE/TRUNCATE, helper không mở quyền client và ngoại lệ CF-01 hợp lệ. Kiểm tra riêng các constraints bằng SELECT metadata:

| Bảng | PK | FK | UNIQUE | CHECK | Đã validated |
|---|---:|---:|---:|---:|---|
| profiles | 1 | 1 | 0 | 2 | Có |
| user_roles | 1 | 2 | 0 | 1 | Có |
| posts | 1 | 1 | 1 | 9 | Có |
| comments | 1 | 2 | 1 | 2 | Có |
| post_votes | 1 | 2 | 0 | 0 | Có |
| post_images | 1 | 1 | 2 | 5 | Có |
| reports | 1 | 2 | 1 | 4 | Có |
| moderation_actions | 1 | 1 | 0 | 3 | Có |
| rate_limit_counters | 1 | 1 | 0 | 2 | Có |

Đây là xác minh metadata, chưa phải bằng chứng toàn bộ constraints đã được thử bằng request Cloud hợp lệ/bất hợp lệ.

## 4. Integration: kết quả chạy thực tế

Chạy đúng suite đã review bằng `node --test tests/cloud.integration.ts` trong `supabase/`. Không dùng script npm yêu cầu `.env.test.local` vì file đó chưa có: lấy publishable/secret key sẵn có của đúng project qua CLI, giữ trong biến tiến trình rồi truyền qua environment. Giữ explicit flag `THEOU_ALLOW_CLOUD_TESTS=theou-dev` và guard ref/link/URL. Không tạo key mới, không in key hoặc lưu key vào repository; xóa environment tạm trong finally.

**Kết quả: exit 1; 1 test, 0 pass, 1 fail.**

```text
AssertionError: Tạo Auth fixture
actual: validation_failed
expected: null
```

Lỗi tại `cloud.integration.ts:67`, khi kiểm tra response của `admin.auth.admin.createUser`. Suite chưa nhận được user đầu tiên và chưa chạy đăng nhập/getUser hoặc các subtest CRUD. Không có bằng chứng để khẳng định Auth từ chối vì email, mật khẩu, hook hay cấu hình cụ thể; mã lỗi hiện có chưa đủ kết luận nguyên nhân. Không tự đổi `.invalid`, password, hook, grants hoặc API key rồi thử lại.

Các ca A/B trực tiếp đọc bảng, đổi owner, tự nâng admin, constraints, service CRUD và kiểm tra identity **chưa chạy**, không được ghi PASS. 20/20 offline tests ở lượt trước là bằng chứng riêng; lượt deployment này không sửa code/test và không chạy lại offline để thay thế kết quả Cloud.

## 5. Cleanup

Trước suite: cả chín bảng đều 0 dòng; số Auth users khớp `theou-t02-%@example.invalid` bằng 0.

Sau lỗi: truy vấn SELECT chỉ đọc xác nhận lại **cả chín bảng vẫn 0 dòng và Auth test users vẫn 0**. Hook `t.after` không báo lỗi; vì chưa nhận được user nên danh sách users/sessions rỗng, không có fixture được ghi nhận để xóa. Không cần thao tác cleanup thủ công hoặc mở quyền.

**Không còn fixture của suite trong Auth và các bảng nghiệp vụ theo số đếm đã kiểm tra.** Đây không phải kiểm thử thành công toàn bộ nhánh cleanup khi đã tạo đủ fixtures; nhánh đó vẫn cần được kiểm chứng khi suite chạy qua bước tạo user. Auth/platform logs của request thử không thuộc dữ liệu fixture và không bị xóa.

## 6. File cập nhật và giới hạn

- Tạo báo cáo này trong `docs/reports/` theo yêu cầu.
- Cập nhật trạng thái tại `docs/T02-FINAL-REVIEW.md`, `supabase/README.md`, `docs/07-IMPLEMENTATION-PLAN.md` và README root.
- Không sửa source integration, migration, dependencies hoặc security grants ngoài migration đã được duyệt.

Migration đã commit trên Cloud và được giữ nguyên; không rollback/reset sau lỗi integration. Catalogue đạt không thay thế JWT/PostgREST tests. Chưa kiểm chứng OTP/domain OU, BANNED, API ownership, DTO nhiều bài ẩn danh, OP, signed Storage, atomic counters hoặc nghiệp vụ khác; không triển khai T03.

## 7. Bước tiếp theo cần review

Điều tra `validation_failed` ở Auth fixture bằng thông tin lỗi đã lọc an toàn hoặc logs phù hợp, xác định nguyên nhân rồi đề xuất sửa fixture/config tối thiểu. Không nới grants hoặc tắt kiểm soát Auth để chạy test. Sau khi phương án được duyệt, chạy lại suite A/B và xác minh cleanup trước khi nghiệm thu T02.

**Điểm dừng:** báo cáo FAIL theo yêu cầu khi integration thất bại; không tiếp tục thử ghi Cloud.
