-- T02: bảng nội bộ; mọi thao tác của sinh viên đi qua social-api.
begin;

create schema theou_private;
revoke all on schema theou_private from public, anon, authenticated, service_role;
grant usage on schema theou_private to service_role;
revoke create on schema public from public, anon, authenticated;

-- Áp dụng cho object tương lai do postgres tạo; mỗi migration vẫn phải cấp quyền tường minh.
alter default privileges for role postgres in schema public
  revoke all on tables from public, anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  revoke all on sequences from public, anon, authenticated, service_role;
-- EXECUTE của PUBLIC là mặc định toàn cục, không thể thu hồi chỉ bằng IN SCHEMA.
alter default privileges for role postgres revoke execute on functions from public;
alter default privileges for role postgres in schema public
  revoke execute on functions from anon, authenticated, service_role;

create table public.profiles (
  id uuid primary key references auth.users(id) on delete restrict,
  nickname varchar(30) not null,
  status text not null default 'ACTIVE' check (status in ('ACTIVE', 'BANNED')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint profiles_nickname_valid check (
    char_length(nickname) between 3 and 30 and nickname = btrim(nickname)
    and nickname !~ '[[:cntrl:]]' and nickname !~* '(https?://|www\.)'
  )
);

create table public.user_roles (
  user_id uuid not null references auth.users(id) on delete restrict,
  role text not null check (role = 'ADMIN'),
  created_at timestamptz not null default now(),
  granted_by uuid references auth.users(id) on delete restrict,
  primary key (user_id, role)
);

create table public.posts (
  id uuid primary key default gen_random_uuid(),
  author_id uuid not null references auth.users(id) on delete restrict,
  tag text not null check (tag in ('CONFESSION', 'REVIEW_MON', 'TAI_LIEU', 'TIM_TRO', 'HOI_GAP')),
  body varchar(1000) not null check (body = btrim(body) and body ~ '[^[:space:]]'),
  display_mode text not null default 'ANONYMOUS' check (display_mode in ('ANONYMOUS', 'NICKNAME')),
  nickname_snapshot varchar(30),
  contact_url text,
  status text not null default 'DRAFT' check (status in ('DRAFT', 'PUBLISHED', 'HIDDEN', 'DELETED')),
  idempotency_key uuid not null,
  upvote_count integer not null default 0 check (upvote_count >= 0),
  comment_count integer not null default 0 check (comment_count >= 0),
  created_at timestamptz not null default now(),
  published_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (author_id, idempotency_key),
  constraint posts_identity_valid check (
    (display_mode = 'ANONYMOUS' and nickname_snapshot is null and contact_url is null)
    or (display_mode = 'NICKNAME' and nickname_snapshot is not null
      and char_length(nickname_snapshot) between 3 and 30
      and nickname_snapshot = btrim(nickname_snapshot)
      and nickname_snapshot !~ '[[:cntrl:]]' and nickname_snapshot !~* '(https?://|www\.)')
  ),
  constraint posts_contact_valid check (
    contact_url is null or (display_mode = 'NICKNAME' and tag in ('TAI_LIEU', 'TIM_TRO')
      and contact_url ~ '^https://(zalo\.me|facebook\.com|www\.facebook\.com|m\.facebook\.com|m\.me)(/[^[:space:][:cntrl:]]*)?$')
  ),
  constraint posts_published_at_valid check (
    (status <> 'PUBLISHED' or published_at is not null)
    and (status <> 'DRAFT' or published_at is null)
  )
);

create table public.comments (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.posts(id) on delete restrict,
  author_id uuid not null references auth.users(id) on delete restrict,
  idempotency_key uuid not null,
  body varchar(500) not null check (body = btrim(body) and body ~ '[^[:space:]]'),
  status text not null default 'VISIBLE' check (status in ('VISIBLE', 'HIDDEN', 'DELETED')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (author_id, idempotency_key)
);

create table public.post_votes (
  post_id uuid not null references public.posts(id) on delete restrict,
  user_id uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  primary key (post_id, user_id)
);

create table public.post_images (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.posts(id) on delete restrict,
  storage_path text not null unique,
  mime_type text not null check (mime_type in ('image/jpeg', 'image/png', 'image/webp')),
  size_bytes integer not null check (size_bytes between 1 and 2097152),
  position smallint not null check (position in (1, 2)),
  status text not null default 'PENDING' check (status in ('PENDING', 'READY')),
  created_at timestamptz not null default now(),
  unique (post_id, position),
  constraint post_images_path_valid check (
    storage_path = 'posts/' || post_id::text || '/' || id::text ||
      case mime_type when 'image/jpeg' then '.jpg' when 'image/png' then '.png' else '.webp' end
  )
);

-- Chỉ chuẩn bị cấu trúc W3; chưa có API xử lý report hay tự động ẩn bài.
create table public.reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid not null references auth.users(id) on delete restrict,
  target_type text not null check (target_type in ('POST', 'COMMENT')),
  target_id uuid not null,
  reason text not null check (reason in ('SPAM', 'HARASSMENT', 'PRIVACY', 'MISINFORMATION', 'COPYRIGHT', 'OTHER')),
  detail varchar(300),
  status text not null default 'PENDING' check (status in ('PENDING', 'RESOLVED', 'DISMISSED')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid references auth.users(id) on delete restrict,
  unique (reporter_id, target_type, target_id),
  constraint reports_resolution_valid check (
    (status = 'PENDING' and resolved_at is null and resolved_by is null)
    or (status <> 'PENDING' and resolved_at is not null and resolved_by is not null)
  )
);

create table public.moderation_actions (
  id uuid primary key default gen_random_uuid(),
  admin_id uuid not null references auth.users(id) on delete restrict,
  target_type text not null check (target_type in ('POST', 'COMMENT', 'USER', 'REPORT')),
  target_id uuid not null,
  action text not null,
  reason text not null check (reason = btrim(reason) and reason ~ '[^[:space:]]'),
  created_at timestamptz not null default now(),
  constraint moderation_actions_target_valid check (
    (target_type in ('POST', 'COMMENT') and action in ('HIDE', 'RESTORE'))
    or (target_type = 'USER' and action in ('BAN_USER', 'UNBAN_USER'))
    or (target_type = 'REPORT' and action in ('REPORT_RESOLVE', 'REPORT_DISMISS'))
  )
);

create table public.rate_limit_counters (
  actor_id uuid not null references auth.users(id) on delete restrict,
  action varchar(40) not null check (action = btrim(action) and action ~ '[^[:space:]]'),
  window_start timestamptz not null,
  count integer not null default 0 check (count >= 0),
  primary key (actor_id, action, window_start)
);

create index posts_feed_idx on public.posts (status, published_at desc, id desc);
create index posts_tag_feed_idx on public.posts (status, tag, published_at desc, id desc);
create index comments_post_idx on public.comments (post_id, created_at, id);
create index post_votes_user_idx on public.post_votes (user_id);
create index user_roles_granted_by_idx on public.user_roles (granted_by);
create index reports_queue_idx on public.reports (status, created_at desc);
create index reports_resolved_by_idx on public.reports (resolved_by);
create index moderation_actions_admin_idx on public.moderation_actions (admin_id);

create function theou_private.guard_immutable_columns()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare
  column_name text;
begin
  foreach column_name in array tg_argv loop
    if (to_jsonb(new) -> column_name) is distinct from (to_jsonb(old) -> column_name) then
      raise exception 'Không được thay đổi định danh hoặc chủ sở hữu.' using errcode = '23514';
    end if;
  end loop;
  return new;
end;
$$;

create function theou_private.set_updated_at()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  new.updated_at := clock_timestamp();
  return new;
end;
$$;

revoke all on function theou_private.guard_immutable_columns(), theou_private.set_updated_at()
  from public, anon, authenticated, service_role;
grant execute on function theou_private.guard_immutable_columns(), theou_private.set_updated_at() to service_role;

create trigger profiles_identity before update on public.profiles
  for each row execute function theou_private.guard_immutable_columns('id', 'created_at');
create trigger posts_identity before update on public.posts
  for each row execute function theou_private.guard_immutable_columns('id', 'author_id', 'idempotency_key', 'created_at');
create trigger comments_identity before update on public.comments
  for each row execute function theou_private.guard_immutable_columns('id', 'post_id', 'author_id', 'idempotency_key', 'created_at');
create trigger post_votes_identity before update on public.post_votes
  for each row execute function theou_private.guard_immutable_columns('post_id', 'user_id', 'created_at');
create trigger post_images_identity before update on public.post_images
  for each row execute function theou_private.guard_immutable_columns('id', 'post_id', 'storage_path', 'created_at');
create trigger user_roles_identity before update on public.user_roles
  for each row execute function theou_private.guard_immutable_columns('user_id', 'role', 'granted_by', 'created_at');
create trigger reports_identity before update on public.reports
  for each row execute function theou_private.guard_immutable_columns('id', 'reporter_id', 'target_type', 'target_id', 'created_at');
create trigger rate_limit_counters_identity before update on public.rate_limit_counters
  for each row execute function theou_private.guard_immutable_columns('actor_id', 'action', 'window_start');

create trigger profiles_updated_at before update on public.profiles
  for each row execute function theou_private.set_updated_at();
create trigger posts_updated_at before update on public.posts
  for each row execute function theou_private.set_updated_at();
create trigger comments_updated_at before update on public.comments
  for each row execute function theou_private.set_updated_at();

do $$
declare
  table_name text;
begin
  foreach table_name in array array['profiles', 'user_roles', 'posts', 'comments', 'post_votes',
    'post_images', 'reports', 'moderation_actions', 'rate_limit_counters'] loop
    execute format('alter table public.%I enable row level security', table_name);
    execute format('alter table public.%I force row level security', table_name);
    execute format('revoke all on table public.%I from public, anon, authenticated, service_role', table_name);
    -- Vẫn chặn nếu một migration sau vô tình thêm grant hoặc permissive policy.
    execute format('create policy deny_direct_client on public.%I as restrictive for all
      to anon, authenticated using (false) with check (false)', table_name);
    if table_name = 'moderation_actions' then
      execute format('grant select, insert on table public.%I to service_role', table_name);
    else
      execute format('grant select, insert, update, delete on table public.%I to service_role', table_name);
    end if;
  end loop;
end;
$$;

commit;
