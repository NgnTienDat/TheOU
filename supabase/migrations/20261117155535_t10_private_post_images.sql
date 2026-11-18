-- T10: metadata riêng tư; Storage chỉ được gọi ngoài transaction DB.
begin;

alter table public.post_images drop constraint post_images_status_check;
alter table public.post_images add constraint post_images_status_check
  check (status in ('PENDING', 'READY', 'REMOVING', 'REMOVED'));
alter table public.post_images drop constraint post_images_post_id_position_key;
create unique index post_images_live_position on public.post_images(post_id, position)
  where status <> 'REMOVED';

create function theou_private.guard_draft_image()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare parent_status text; owner_id uuid; account_status text;
  target_post_id uuid;
begin
  if tg_op = 'DELETE' then
    target_post_id := old.post_id;
  else
    target_post_id := new.post_id;
  end if;
  -- Cùng khóa parent với publish; không giữ transaction trong lúc gọi Storage.
  select status, author_id into parent_status, owner_id from public.posts
    where id = target_post_id for no key update;
  if not found or parent_status <> 'DRAFT' then
    raise exception 'Bài không còn là bản nháp.' using errcode = '23514';
  end if;
  select status into account_status from public.profiles where id = owner_id for share;
  if account_status is distinct from 'ACTIVE' then
    raise exception 'Tài khoản không được phép thao tác.' using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  if tg_op = 'INSERT' then
    if new.status <> 'PENDING' then
      raise exception 'Ảnh phải được xác minh trước.' using errcode = '23514';
    end if;
  else
    if (new.mime_type, new.size_bytes, new.position) is distinct from
       (old.mime_type, old.size_bytes, old.position)
       or not ((new.status = old.status) or
         (old.status = 'PENDING' and new.status in ('READY', 'REMOVING')) or
         (old.status = 'READY' and new.status = 'REMOVING') or
         (old.status = 'REMOVING' and new.status = 'REMOVED')) then
      raise exception 'Chuyển trạng thái ảnh không hợp lệ.' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function theou_private.guard_draft_image()
  from public, anon, authenticated, service_role, supabase_auth_admin;
grant execute on function theou_private.guard_draft_image() to service_role;
create trigger post_images_draft_guard before insert or update or delete on public.post_images
  for each row execute function theou_private.guard_draft_image();

create or replace function theou_private.prepare_post_publish()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare author_nickname text; author_status text;
begin
  select nickname, status into author_nickname, author_status
    from public.profiles where id = old.author_id for share;
  if not found or author_status <> 'ACTIVE' then
    raise exception 'Tài khoản không đủ điều kiện đăng bài.' using errcode = '42501';
  end if;
  if exists(select 1 from public.post_images where post_id = old.id
      and status not in ('READY', 'REMOVED')) then
    raise exception 'Ảnh chưa sẵn sàng.' using errcode = '23514';
  end if;
  new.nickname_snapshot := case when new.display_mode = 'NICKNAME' then author_nickname else null end;
  new.published_at := clock_timestamp();
  return new;
end;
$$;
commit;
