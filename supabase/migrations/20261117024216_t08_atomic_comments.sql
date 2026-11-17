-- T08-A: lifecycle/count cùng transaction; không mở RPC hoặc quyền bảng cho client.
begin;

-- Chặn writes trong lúc đối chiếu dữ liệu cũ, theo thứ tự comment rồi parent như trigger.
lock table public.comments, public.posts in share row exclusive mode;

with actual as (
  select p.id, count(c.id) filter (where c.status = 'VISIBLE')::integer as n
  from public.posts p left join public.comments c on c.post_id = p.id
  group by p.id
)
update public.posts p set comment_count = actual.n
from actual where p.id = actual.id and p.comment_count is distinct from actual.n;

create function theou_private.guard_comment_lifecycle()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if old.status = 'DELETED' and new.status <> 'DELETED' then
    raise exception 'Không thể khôi phục bình luận đã xóa.' using errcode = '23514';
  end if;
  return new;
end;
$$;

create function theou_private.sync_comment_count()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare
  delta integer;
  parent_id uuid;
begin
  if tg_op = 'INSERT' then
    delta := case when new.status = 'VISIBLE' then 1 else 0 end;
    parent_id := new.post_id;
  elsif tg_op = 'DELETE' then
    delta := case when old.status = 'VISIBLE' then -1 else 0 end;
    parent_id := old.post_id;
  else
    delta := (case when new.status = 'VISIBLE' then 1 else 0 end)
      - (case when old.status = 'VISIBLE' then 1 else 0 end);
    parent_id := new.post_id;
  end if;
  if delta <> 0 then
    -- AFTER tránh giữ parent lock trước unique-conflict; UPDATE cộng delta không đọc/sửa count ở Edge.
    update public.posts set comment_count = comment_count + delta
      where id = parent_id and (delta < 0 or status = 'PUBLISHED');
    if not found then
      raise exception 'Không tìm thấy bài viết được phép tương tác.' using errcode = 'P0002';
    end if;
  end if;
  return null;
end;
$$;

revoke all on function theou_private.guard_comment_lifecycle(), theou_private.sync_comment_count()
  from public, anon, authenticated, service_role, supabase_auth_admin;
grant execute on function theou_private.guard_comment_lifecycle(), theou_private.sync_comment_count()
  to service_role;

create trigger comments_lifecycle before update of status on public.comments
  for each row execute function theou_private.guard_comment_lifecycle();
create trigger comments_sync_count after insert or update of status or delete on public.comments
  for each row execute function theou_private.sync_comment_count();

commit;
