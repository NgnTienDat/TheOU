-- REVIEW ONLY. Không chạy riêng: chèn trong transaction grant đã review,
-- sau SET LOCAL exact UUID và các LOCK TABLE, trước DO grant gốc.
-- DO gốc vẫn phải pin đúng actor B và full snapshot; guard này không cấp role.
do $auth_review$
declare actor_id uuid := nullif(current_setting('theou.t11_admin_id', true), '')::uuid;
begin
  if actor_id is null then
    raise exception 'T11 exact approved actor required';
  end if;
  perform 1 from auth.users u join public.profiles p on p.id = u.id
    where u.id = actor_id and p.status = 'ACTIVE'
      -- Cùng dot-atom ASCII, giới hạn độ dài và anonymous/confirmation guard của authenticate().
      and char_length(u.email) <= 254 and char_length(split_part(u.email, '@', 1)) <= 64
      and u.email ~* $ou_email$^[a-z0-9!#$%&'*+/=?^_`{|}~-]+([.][a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@ou[.]edu[.]vn$$ou_email$
      and not coalesce(u.is_anonymous, false)
      and u.email_confirmed_at is not null and isfinite(u.email_confirmed_at)
    for share of u, p;
  if not found then
    raise exception 'T11 confirmed OU Auth identity and ACTIVE profile required';
  end if;
end;
$auth_review$;
