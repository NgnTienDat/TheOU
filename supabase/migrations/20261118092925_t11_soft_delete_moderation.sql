-- T11: soft-delete giữ references; hide và audit trong cùng transaction RPC.
begin;

create function theou_private.guard_post_lifecycle()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if (old.status in ('HIDDEN', 'DELETED') and new.status <> old.status)
     or (old.status = 'DRAFT' and new.status not in ('DRAFT', 'PUBLISHED'))
     or (old.status = 'PUBLISHED' and new.status not in ('PUBLISHED', 'HIDDEN', 'DELETED')) then
    raise exception 'Chuyển trạng thái bài viết không hợp lệ.' using errcode = '23514';
  end if;
  if old.status = 'PUBLISHED' and new.status = 'DELETED' then
    perform 1 from public.profiles where id = old.author_id and status = 'ACTIVE' for share;
    if not found then raise exception 'Không có quyền.' using errcode = '42501'; end if;
  end if;
  return new;
end;
$$;
revoke all on function theou_private.guard_post_lifecycle() from public, anon, authenticated, service_role, supabase_auth_admin;
grant execute on function theou_private.guard_post_lifecycle() to service_role;
create trigger posts_lifecycle before update of status on public.posts
  for each row execute function theou_private.guard_post_lifecycle();

-- Exposed schema chỉ để PostgREST gọi được; browser không có quyền EXECUTE.
create function public.t11_admin_hide_content(p_admin_id uuid, p_target_type text, p_target_id uuid, p_reason text)
returns void language plpgsql security invoker set search_path = '' as $$
declare changed_id uuid;
begin
  if p_target_type is null or p_target_type not in ('POST', 'COMMENT') or p_target_id is null
     or p_reason is null or p_reason <> btrim(p_reason) or char_length(p_reason) not between 1 and 500
     or p_reason !~ '[^[:space:]]' or p_reason ~ '[[:cntrl:]]' then
    raise exception 'Yêu cầu không hợp lệ.' using errcode = '22023';
  end if;
  perform 1 from public.profiles where id = p_admin_id and status = 'ACTIVE' for share;
  if not found then raise exception 'Không có quyền.' using errcode = '42501'; end if;
  perform 1 from public.user_roles where user_id = p_admin_id and role = 'ADMIN' for share;
  if not found then raise exception 'Không có quyền.' using errcode = '42501'; end if;
  if p_target_type = 'POST' then
    update public.posts set status = 'HIDDEN' where id = p_target_id and status = 'PUBLISHED' returning id into changed_id;
    if changed_id is null then
      if exists(select 1 from public.posts where id = p_target_id) then
        raise exception 'Trạng thái đã thay đổi.' using errcode = '23514';
      end if;
      raise exception 'Không tìm thấy nội dung.' using errcode = 'P0002';
    end if;
  else
    -- Comment -> parent như trigger T08; không giữ parent trước child.
    update public.comments set status = 'HIDDEN' where id = p_target_id and status = 'VISIBLE' returning id into changed_id;
    if changed_id is null then
      if exists(select 1 from public.comments where id = p_target_id) then
        raise exception 'Trạng thái đã thay đổi.' using errcode = '23514';
      end if;
      raise exception 'Không tìm thấy nội dung.' using errcode = 'P0002';
    end if;
  end if;
  insert into public.moderation_actions(admin_id,target_type,target_id,action,reason)
    values(p_admin_id,p_target_type,p_target_id,'HIDE',p_reason);
end;
$$;
revoke all on function public.t11_admin_hide_content(uuid,text,uuid,text) from public, anon, authenticated, service_role, supabase_auth_admin;
grant execute on function public.t11_admin_hide_content(uuid,text,uuid,text) to service_role;

create function theou_private.guard_audit_immutable()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  raise exception 'Không được sửa lịch sử kiểm duyệt.' using errcode = '42501';
end;
$$;
revoke all on function theou_private.guard_audit_immutable() from public, anon, authenticated, service_role, supabase_auth_admin;
grant execute on function theou_private.guard_audit_immutable() to service_role;
create trigger moderation_actions_immutable before update or delete on public.moderation_actions
  for each row execute function theou_private.guard_audit_immutable();

commit;
