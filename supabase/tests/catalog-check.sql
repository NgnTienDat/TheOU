-- Chỉ đọc catalog; chạy lại trên Cloud sau khi migration được phê duyệt và áp dụng.
do $$
declare
  table_name text;
  role_name text;
  privilege_name text;
  relation regclass;
begin
  foreach table_name in array array['profiles', 'user_roles', 'posts', 'comments', 'post_votes',
    'post_images', 'reports', 'moderation_actions', 'rate_limit_counters'] loop
    relation := to_regclass('public.' || table_name);
    if relation is null then raise exception 'Thiếu bảng %', table_name; end if;
    if not exists (select 1 from pg_class where oid = relation and relrowsecurity and relforcerowsecurity) then
      raise exception 'RLS chưa bật đầy đủ: %', table_name;
    end if;
    if not exists (select 1 from pg_policy where polrelid = relation
      and polname = 'deny_direct_client' and not polpermissive
      and polcmd = '*' and pg_get_expr(polqual, polrelid) = 'false'
      and pg_get_expr(polwithcheck, polrelid) = 'false'
      and polroles @> array[(select oid from pg_roles where rolname = 'anon'),
        (select oid from pg_roles where rolname = 'authenticated')]) then
      raise exception 'Thiếu restrictive policy: %', table_name;
    end if;
    foreach role_name in array array['anon', 'authenticated'] loop
      foreach privilege_name in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] loop
        if has_table_privilege(role_name, relation, privilege_name) then
          raise exception 'Quyền client không hợp lệ: % / % / %', table_name, role_name, privilege_name;
        end if;
      end loop;
      if exists (select 1 from pg_attribute where attrelid = relation and attnum > 0 and not attisdropped
        and (has_column_privilege(role_name, relation, attnum, 'SELECT')
          or has_column_privilege(role_name, relation, attnum, 'INSERT')
          or has_column_privilege(role_name, relation, attnum, 'UPDATE'))) then
        raise exception 'Có quyền cấp riêng theo cột: % / %', table_name, role_name;
      end if;
    end loop;
    if exists (select 1 from pg_class c,
      lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) acl
      where c.oid = relation and acl.grantee = 0) then
      raise exception 'Bảng có quyền PUBLIC: %', table_name;
    end if;
    if not has_table_privilege('service_role', relation, 'SELECT')
      or not has_table_privilege('service_role', relation, 'INSERT') then
      raise exception 'Thiếu quyền server: %', table_name;
    end if;
    if table_name <> 'moderation_actions' and
      (not has_table_privilege('service_role', relation, 'UPDATE')
        or not has_table_privilege('service_role', relation, 'DELETE')) then
      raise exception 'Thiếu quyền UPDATE/DELETE server: %', table_name;
    end if;
    if has_table_privilege('service_role', relation, 'TRUNCATE') then
      raise exception 'Server không cần quyền TRUNCATE: %', table_name;
    end if;
    if table_name = 'moderation_actions' and
      (has_table_privilege('service_role', relation, 'UPDATE') or has_table_privilege('service_role', relation, 'DELETE')) then
      raise exception 'Audit không được sửa/xóa bởi service_role';
    end if;
  end loop;
  if has_schema_privilege('anon', 'theou_private', 'USAGE')
    or has_schema_privilege('authenticated', 'theou_private', 'USAGE') then
    raise exception 'Schema helper bị mở cho client';
  end if;
  if exists (select 1 from pg_proc where pronamespace = 'theou_private'::regnamespace
    and (prosecdef or has_function_privilege('anon', oid, 'EXECUTE')
      or has_function_privilege('authenticated', oid, 'EXECUTE'))) then
    raise exception 'Helper có quyền không an toàn';
  end if;
  -- CF-01: chỉ chấp nhận event trigger đã review trên TheOU-dev ngày 14/11/2026.
  -- Fingerprint là kiểm tra drift, không phải cơ chế xác thực chống DB admin độc hại.
  if exists (select 1 from pg_class where relnamespace = 'public'::regnamespace and relkind in ('v', 'm'))
    or exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and not coalesce((
      (p.proname = 'rls_auto_enable' and p.pronargs = 0 and p.prokind = 'f'
      and p.prorettype = 'event_trigger'::regtype and not p.proretset
      and p.proowner = 'postgres'::regrole and p.prosecdef
      and p.prolang = (select oid from pg_language where lanname = 'plpgsql')
      and p.proconfig = array['search_path=pg_catalog']::text[]
      and md5(p.prosrc) = 'c44fb229ea8a6b0afd04a0a33261c16c'
      and (select count(*) from pg_event_trigger where evtfoid = p.oid) = 1
      and exists (select 1 from pg_event_trigger e where e.evtfoid = p.oid
        and e.evtname = 'ensure_rls' and e.evtowner = 'postgres'::regrole
        and e.evtevent = 'ddl_command_end' and e.evtenabled = 'O'
        and array(select unnest(e.evttags) order by 1)
          = array['CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO']::text[]))
      -- T11: RPC đã review, chỉ service_role; không mở schema private.
      or (p.proname = 't11_admin_hide_content' and p.pronargs = 4 and p.prokind = 'f'
        and p.proargtypes = '2950 25 2950 25'::oidvector and p.prorettype = 'void'::regtype
        and not p.proretset and not p.prosecdef and p.proowner = 'postgres'::regrole
        and p.proconfig = array['search_path=""']::text[]
        and not has_function_privilege('anon',p.oid,'EXECUTE')
        and not has_function_privilege('authenticated',p.oid,'EXECUTE')
        and not has_function_privilege('supabase_auth_admin',p.oid,'EXECUTE')
        and has_function_privilege('service_role',p.oid,'EXECUTE'))
    ), false)) then
    raise exception 'Có public view/function cần rà soát trước khi nghiệm thu T02';
  end if;
end;
$$;

select 'T02 catalog checks passed' as result;
