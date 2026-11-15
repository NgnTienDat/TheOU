-- T03-A: chỉ tạo hook và quyền; bật Before User Created trên Dashboard sau review.
begin;

create function theou_private.before_user_created(event jsonb)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  email text := event #>> '{user,email}';
begin
  -- Chỉ đọc email của Auth, không tin domain/role trong user_metadata.
  if jsonb_typeof(event #> '{user,email}') = 'string'
    and char_length(email) <= 254 and char_length(split_part(email, '@', 1)) <= 64
    and lower(email) ~ '^[a-z0-9!#$%&''*+/=?^_`{|}~-]+([.][a-z0-9!#$%&''*+/=?^_`{|}~-]+)*@ou[.]edu[.]vn$'
  then
    return '{}'::jsonb;
  end if;

  return jsonb_build_object('error', jsonb_build_object(
    'http_code', 403,
    'message', 'TheOU chỉ cho phép đăng ký bằng email @ou.edu.vn.'
  ));
end;
$$;

revoke all on function theou_private.before_user_created(jsonb)
  from public, anon, authenticated, service_role, supabase_auth_admin;
grant usage on schema theou_private to supabase_auth_admin;
grant execute on function theou_private.before_user_created(jsonb) to supabase_auth_admin;

commit;
