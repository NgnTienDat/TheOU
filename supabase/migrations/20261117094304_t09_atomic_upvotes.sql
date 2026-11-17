-- T09-A: count đổi cùng row vote; không RPC public hoặc quyền client mới.
begin;

lock table public.post_votes, public.posts in share row exclusive mode;
with actual as (
  select p.id, count(v.user_id)::integer as n
  from public.posts p left join public.post_votes v on v.post_id = p.id
  group by p.id
)
update public.posts p set upvote_count = actual.n
from actual where p.id = actual.id and p.upvote_count is distinct from actual.n;

create function theou_private.sync_upvote_count()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare
  parent_id uuid;
  delta integer;
begin
  if tg_op = 'INSERT' then
    parent_id := new.post_id;
    delta := 1;
  else
    parent_id := old.post_id;
    delta := -1;
  end if;
  -- AFTER lấy child/unique lock trước parent; count không sửa khóa FK của parent.
  update public.posts set upvote_count = upvote_count + delta
    where id = parent_id and (delta < 0 or status = 'PUBLISHED');
  if not found then
    raise exception 'Không tìm thấy bài viết được phép tương tác.' using errcode = 'P0002';
  end if;
  return null;
end;
$$;

revoke all on function theou_private.sync_upvote_count()
  from public, anon, authenticated, service_role, supabase_auth_admin;
grant execute on function theou_private.sync_upvote_count() to service_role;

create trigger post_votes_sync_count after insert or delete on public.post_votes
  for each row execute function theou_private.sync_upvote_count();

commit;
