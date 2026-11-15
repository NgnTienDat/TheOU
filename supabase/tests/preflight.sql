-- Chỉ đọc metadata; không đọc dữ liệu người dùng, credentials hoặc function body.
-- Chạy bằng db query --read-only với remote ref TheOU-dev tường minh.
select jsonb_build_object(
  'database', jsonb_build_object(
    'version', current_setting('server_version'), 'current_user', current_user,
    'read_only', current_setting('transaction_read_only'),
    'history_table', to_regclass('supabase_migrations.schema_migrations'),
    'private_schema_exists', to_regnamespace('theou_private') is not null,
    'postgres_create_database_objects', has_database_privilege('postgres', current_database(), 'CREATE'),
    'postgres_create_public', has_schema_privilege('postgres', 'public', 'CREATE'),
    'postgres_auth_usage', has_schema_privilege('postgres', 'auth', 'USAGE'),
    'postgres_auth_references', has_column_privilege('postgres', 'auth.users', 'id', 'REFERENCES')
  ),
  'roles', (select jsonb_agg(jsonb_build_object('name', rolname, 'superuser', rolsuper,
    'inherit', rolinherit, 'bypassrls', rolbypassrls)) from pg_roles
    where rolname in ('postgres', 'anon', 'authenticated', 'service_role', 'authenticator',
      'supabase_admin', 'supabase_auth_admin', 'supabase_storage_admin')),
  'memberships', (select jsonb_agg(jsonb_build_object('member', member::regrole::text,
    'role', roleid::regrole::text, 'inherit', inherit_option, 'set', set_option)) from pg_auth_members),
  'schemas', (select jsonb_agg(jsonb_build_object('name', nspname, 'owner', nspowner::regrole::text,
    'acl', nspacl::text)) from pg_namespace where nspname in ('public', 'auth', 'storage', 'extensions', 'theou_private')),
  'default_acls', (select jsonb_agg(jsonb_build_object('creator', defaclrole::regrole::text,
    'schema', case when defaclnamespace = 0 then '(global)' else defaclnamespace::regnamespace::text end,
    'type', defaclobjtype, 'acl', defaclacl::text)) from pg_default_acl),
  'auth_id', (select jsonb_agg(jsonb_build_object('type', format_type(atttypid, atttypmod),
    'not_null', attnotnull)) from pg_attribute where attrelid = 'auth.users'::regclass and attname = 'id'),
  'auth_keys', (select jsonb_agg(jsonb_build_object('name', conname, 'definition', pg_get_constraintdef(oid)))
    from pg_constraint where conrelid = 'auth.users'::regclass and contype in ('p', 'u')),
  'public_relations', (select jsonb_agg(jsonb_build_object('name', relname, 'kind', relkind,
    'owner', relowner::regrole::text)) from pg_class where relnamespace = 'public'::regnamespace),
  'public_types', (select jsonb_agg(typname) from pg_type where typnamespace = 'public'::regnamespace),
  'functions', (select jsonb_agg(jsonb_build_object('signature', p.oid::regprocedure::text,
    'schema', n.nspname, 'owner', p.proowner::regrole::text, 'security_definer', p.prosecdef,
    'acl', p.proacl::text, 'anon_execute', has_function_privilege('anon', p.oid, 'EXECUTE'),
    'authenticated_execute', has_function_privilege('authenticated', p.oid, 'EXECUTE'),
    'extension', e.extname)) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    left join pg_depend d on d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e'
    left join pg_extension e on e.oid = d.refobjid
    where n.nspname = 'public' or (p.prosecdef and n.nspname not in ('pg_catalog', 'information_schema'))),
  'extensions', (select jsonb_agg(jsonb_build_object('name', extname, 'schema', extnamespace::regnamespace::text,
    'owner', extowner::regrole::text, 'version', extversion)) from pg_extension),
  'service_function_owners', (select jsonb_agg(row_to_json(s)) from (
    select n.nspname as schema, p.proowner::regrole::text as owner, count(*) as functions
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('auth', 'storage') group by n.nspname, p.proowner) s),
  'publications', (select jsonb_agg(jsonb_build_object('name', pubname, 'all_tables', puballtables)) from pg_publication)
) as preflight;
