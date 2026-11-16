-- T06-A: snapshot và thời gian publish nằm trong cùng UPDATE; không có RPC public.
begin;

create function theou_private.prepare_post_publish()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  author_nickname text;
  author_status text;
begin
  -- Giữ profile ổn định trong statement publish, kể cả khi nickname/status đổi đồng thời.
  select nickname, status into author_nickname, author_status
    from public.profiles where id = old.author_id for share;
  if not found or author_status <> 'ACTIVE' then
    raise exception 'Tài khoản không đủ điều kiện đăng bài.' using errcode = '42501';
  end if;
  if exists (select 1 from public.post_images where post_id = old.id) then
    raise exception 'Luồng đăng bài text chưa hỗ trợ ảnh.' using errcode = '23514';
  end if;
  new.nickname_snapshot := case when new.display_mode = 'NICKNAME' then author_nickname else null end;
  new.published_at := clock_timestamp();
  return new;
end;
$$;

revoke all on function theou_private.prepare_post_publish()
  from public, anon, authenticated, service_role, supabase_auth_admin;
grant execute on function theou_private.prepare_post_publish() to service_role;

create trigger posts_prepare_publish before update of status on public.posts
  for each row when (old.status = 'DRAFT' and new.status = 'PUBLISHED')
  execute function theou_private.prepare_post_publish();

commit;
