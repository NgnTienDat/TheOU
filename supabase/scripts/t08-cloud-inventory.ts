import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { check } from './t06-cloud-inventory.ts'
import { t04ProjectRef, uuidPattern } from './t04-cloud-recovery.ts'

export interface CommentSnapshot {
  id: string
  postId: string
  authorHash: string
  keyHash: string
  bodyHash: string
  status: string
  rowHash: string
}
export interface PostSnapshot {
  id: string
  authorHash: string
  status: string
  commentCount: number
  visibleCount: number
  immutableHash: string
  rowHash: string
}
export interface CommentBaseline {
  readOnly: string
  users: number
  profiles: number
  roles: number
  profileHash: string
  roleHash: string
  profileOwners: { authorHash: string; status: string }[]
  posts: PostSnapshot[]
  comments: CommentSnapshot[]
}
export interface CommentFixture {
  label: string
  key: string
  body: string
  postId: string
  authorHash: string
  ids: string[]
  state: 'pending' | 'VISIBLE' | 'DELETED'
}
export interface CommentInventory {
  projectRef: string
  runId: string
  marker: string
  mode: '--smoke' | '--write'
  baseline: CommentBaseline
  fixtures: CommentFixture[]
}
export interface CommentInventoryStore {
  save(record: CommentInventory): Promise<void>
}
export async function readCommentInventory(
  runId: string,
  directory = new URL('../.temp/t08-comments/', import.meta.url),
): Promise<CommentInventory> {
  check(/^[a-f0-9]{32}$/.test(runId), 'T08_RESUME_RUN_ID')
  let record: CommentInventory
  try {
    record = JSON.parse(await readFile(new URL(`${runId}.json`, directory), 'utf8'))
  } catch {
    check(false, 'T08_RESUME_INVENTORY_READ')
  }
  validateCommentInventory(record)
  check(record.runId === runId, 'T08_RESUME_INVENTORY_RUN_ID')
  return record
}
export const literal = (value: string) => `'${value.replaceAll("'", "''")}'`
const hash = /^[a-f0-9]{32}$/
export function validateBaseline(value: CommentBaseline) {
  check(
    value?.readOnly === 'on' &&
      [value.users, value.profiles, value.roles].every((n) => Number.isSafeInteger(n) && n >= 0) &&
      hash.test(value.profileHash) && hash.test(value.roleHash) &&
      Array.isArray(value.posts) && Array.isArray(value.comments) &&
      Array.isArray(value.profileOwners) &&
      value.profileOwners.every((p) => hash.test(p.authorHash) && ['ACTIVE', 'BANNED'].includes(p.status)),
    'DB_BASELINE_SHAPE',
  )
  for (const post of value.posts) {
    check(
      uuidPattern.test(post.id) && hash.test(post.authorHash) &&
        hash.test(post.immutableHash) && hash.test(post.rowHash) &&
        post.status === 'PUBLISHED' &&
        Number.isSafeInteger(post.commentCount) && post.commentCount >= 0 &&
        post.commentCount === post.visibleCount,
      'DB_POST_COUNT_OR_STATE',
    )
  }
  for (const comment of value.comments) {
    check(
      uuidPattern.test(comment.id) && value.posts.some((p) => p.id === comment.postId) &&
        [comment.authorHash, comment.keyHash, comment.bodyHash, comment.rowHash]
          .every((h) => hash.test(h)) &&
        ['VISIBLE', 'HIDDEN', 'DELETED'].includes(comment.status),
      'DB_COMMENT_SHAPE',
    )
  }
  check(
    new Set(value.posts.map((p) => p.id)).size === value.posts.length &&
      new Set(value.comments.map((c) => c.id)).size === value.comments.length,
    'DB_DUPLICATE_IDS',
  )
}
export function validateCommentInventory(record: CommentInventory) {
  check(
    record?.projectRef === t04ProjectRef &&
      /^[a-f0-9]{32}$/.test(record.runId) &&
      record.marker === `T08-CLOUD-TEST-${record.runId}` &&
      ['--smoke', '--write'].includes(record.mode) &&
      Array.isArray(record.fixtures) && record.fixtures.length <= 6,
    'COMMENT_INVENTORY_SCOPE',
  )
  validateBaseline(record.baseline)
  const keys = new Set<string>(), ids = new Set<string>()
  for (const f of record.fixtures) {
    check(
      /^[a-z-]{1,30}$/.test(f.label) && uuidPattern.test(f.key) &&
        !keys.has(f.key) &&
        f.body === `${record.marker} ${f.label}` &&
        record.baseline.posts.some((p) => p.id === f.postId) &&
        hash.test(f.authorHash) &&
        ['pending', 'VISIBLE', 'DELETED'].includes(f.state) &&
        Array.isArray(f.ids),
      'COMMENT_INVENTORY_FIXTURE',
    )
    keys.add(f.key)
    for (const id of f.ids) {
      check(
        uuidPattern.test(id) && !ids.has(id) &&
          !record.baseline.comments.some((c) => c.id === id),
        'COMMENT_INVENTORY_PROTECTED_ID',
      )
      ids.add(id)
    }
    check(f.state === 'pending' || f.ids.length > 0, 'COMMENT_INVENTORY_ACK')
  }
}

// Chỉ hash nội dung/identity cũ; không trả email, body, author UUID hoặc thông tin Auth nhạy cảm.
export const commentSnapshotSql = `select jsonb_build_object(
  'readOnly', current_setting('transaction_read_only'),
  'users', (select count(*) from auth.users),
  'profiles', (select count(*) from public.profiles),
  'roles', (select count(*) from public.user_roles),
  'profileHash', (select md5(coalesce(jsonb_agg(to_jsonb(p) order by id)::text,'[]')) from public.profiles p),
  'roleHash', (select md5(coalesce(jsonb_agg(to_jsonb(r) order by user_id,role)::text,'[]')) from public.user_roles r),
  'profileOwners', (select coalesce(jsonb_agg(jsonb_build_object('authorHash',md5(id::text),'status',status) order by id),'[]') from public.profiles),
  'posts', (select coalesce(jsonb_agg(jsonb_build_object(
    'id',p.id,'authorHash',md5(p.author_id::text),'status',p.status,'commentCount',p.comment_count,
    'visibleCount',(select count(*) from public.comments c where c.post_id=p.id and c.status='VISIBLE'),
    'immutableHash',md5((to_jsonb(p)-'comment_count'-'updated_at')::text),'rowHash',md5(to_jsonb(p)::text)
  ) order by p.id),'[]') from public.posts p),
  'comments', (select coalesce(jsonb_agg(jsonb_build_object(
    'id',c.id,'postId',c.post_id,'authorHash',md5(c.author_id::text),'keyHash',md5(c.idempotency_key::text),
    'bodyHash',md5(c.body),'status',c.status,'rowHash',md5(to_jsonb(c)::text)
  ) order by c.id),'[]') from public.comments c)
) as snapshot;`

export function commentResumeSnapshotSql(record: CommentInventory) {
  validateCommentInventory(record)
  return `select s.snapshot, not exists(
  select 1 from jsonb_to_recordset(${literal(JSON.stringify(record.fixtures))}::jsonb)
    as f(key uuid,body text,"postId" uuid,"authorHash" text,ids jsonb,state text)
  where (select count(*) from public.comments c where c.id=(f.ids->>0)::uuid
    and c.idempotency_key=f.key and c.post_id=f."postId" and c.body=f.body
    and md5(c.author_id::text)=f."authorHash" and c.status=f.state)<>1
    or exists(select 1 from public.comments c where c.idempotency_key=f.key and c.id<>(f.ids->>0)::uuid)
) as "fixtureScopeMatches"
from (${commentSnapshotSql.trim().replace(/;$/, '')}) s;`
}

export function commentVerificationSql(record: CommentInventory) {
  validateCommentInventory(record)
  const expected = literal(JSON.stringify(record.fixtures))
  const posts = literal(JSON.stringify(record.baseline.posts)),
    comments = literal(JSON.stringify(record.baseline.comments))
  return `-- READ ONLY; TheOU-dev ${t04ProjectRef}; run ${record.runId}. Never execute cleanup automatically.
select current_setting('transaction_read_only') as read_only;
with expected as (select * from jsonb_to_recordset(${expected}::jsonb)
  as f(label text,key uuid,body text,"postId" uuid,"authorHash" text,ids jsonb,state text))
select f.label,f.state,count(c.id)::integer row_count,
  coalesce(jsonb_agg(c.id) filter(where c.id is not null),'[]') comment_ids,
  coalesce(bool_and(c.post_id=f."postId" and c.body=f.body and md5(c.author_id::text)=f."authorHash") filter(where c.id is not null),true) scope_matches,
  coalesce(bool_and(f.ids ? c.id::text) filter(where c.id is not null),true) known_ids_match,
  coalesce(bool_and(c.status=f.state) filter(where c.id is not null),f.state='pending') status_matches
from expected f left join public.comments c on c.idempotency_key=f.key
group by f.label,f.state order by f.label;
select e.id,p.comment_count,(select count(*) from public.comments c where c.post_id=p.id and c.status='VISIBLE') visible_count,
  p.id is not null and md5((to_jsonb(p)-'comment_count'-'updated_at')::text)=e."immutableHash" protected_post_unchanged
from jsonb_to_recordset(${posts}::jsonb) as e(id uuid,"immutableHash" text) left join public.posts p on p.id=e.id;
select e.id,c.id is not null and md5(to_jsonb(c)::text)=e."rowHash" protected_comment_unchanged
from jsonb_to_recordset(${comments}::jsonb) as e(id uuid,"rowHash" text) left join public.comments c on c.id=e.id;
-- After reviewed cleanup: every fixture row_count=0; posts/counts return to baseline below.
-- Baseline counts: ${record.baseline.posts.map((p) => `${p.id}=${p.commentCount}`).join(', ')}.
`
}

export function commentCleanupSql(record: CommentInventory) {
  validateCommentInventory(record)
  const header =
    `-- REVIEW ONLY: TheOU-dev ${t04ProjectRef}; run ${record.runId}. Runner NEVER executes DELETE.
-- Resolve pending requests with verify.sql; do not infer unknown UUIDs or delete by marker/domain.
`
  if (!record.fixtures.length) {
    return header + '-- No fixture writes in smoke. No cleanup.\n'
  }
  if (
    record.fixtures.some((f) => f.state === 'pending' || f.ids.length !== 1)
  ) {
    return header +
      "begin; do $$ begin raise exception 'Unresolved inventory; review verification and exact UUIDs first'; end $$; rollback;\n"
  }
  const expected = literal(JSON.stringify(record.fixtures)),
    posts = literal(JSON.stringify(record.baseline.posts)),
    comments = literal(JSON.stringify(record.baseline.comments))
  return header + `begin;
set local lock_timeout='3s';
set local statement_timeout='10s';
-- Same comment -> parent order as T08. Short review-only maintenance transaction; no writes may overlap.
lock table public.comments, public.posts in share row exclusive mode;
do $cleanup$
declare f record; n integer; ids uuid[] := '{}'::uuid[];
begin
  if exists(select 1 from jsonb_to_recordset(${posts}::jsonb) as e(id uuid,"immutableHash" text)
    left join public.posts p on p.id=e.id where p.id is null or md5((to_jsonb(p)-'comment_count'-'updated_at')::text)<>e."immutableHash")
    or exists(select 1 from jsonb_to_recordset(${comments}::jsonb) as e(id uuid,"rowHash" text)
    left join public.comments c on c.id=e.id where c.id is null or md5(to_jsonb(c)::text)<>e."rowHash") then
    raise exception 'Protected data changed; no cleanup';
  end if;
  for f in select * from jsonb_to_recordset(${expected}::jsonb)
    as x(key uuid,body text,"postId" uuid,"authorHash" text,ids jsonb,state text) loop
    if exists(select 1 from public.comments where idempotency_key=f.key and id<>(f.ids->>0)::uuid) then
      raise exception 'Unexpected UUID for key; no cleanup';
    end if;
    select count(*) into n from public.comments c where c.id=(f.ids->>0)::uuid;
    if n=1 then
      if not exists(select 1 from public.comments c where c.id=(f.ids->>0)::uuid and c.idempotency_key=f.key
        and c.post_id=f."postId" and c.body=f.body and md5(c.author_id::text)=f."authorHash" and c.status=f.state) then
        raise exception 'Fixture UUID/key/post/body/author/status mismatch; no cleanup';
      end if;
      if exists(select 1 from public.reports where target_type='COMMENT' and target_id=(f.ids->>0)::uuid)
        or exists(select 1 from public.moderation_actions where target_type='COMMENT' and target_id=(f.ids->>0)::uuid) then
        raise exception 'Fixture has dependencies; no cleanup';
      end if;
      ids:=array_append(ids,(f.ids->>0)::uuid);
    end if;
  end loop;
  delete from public.comments where id=any(ids);
  if exists(select 1 from jsonb_to_recordset(${posts}::jsonb) as e(id uuid,"commentCount" integer)
    join public.posts p on p.id=e.id where p.comment_count<>e."commentCount"
      or p.comment_count<>(select count(*) from public.comments c where c.post_id=p.id and c.status='VISIBLE')) then
    raise exception 'Count/baseline drift; rollback cleanup, do not reset counts';
  end if;
end;
$cleanup$;
commit;
-- Re-run verify.sql: all fixture row_count=0, protected data unchanged, baseline counts restored.
`
}

export function fileCommentInventory(
  directory = new URL('../.temp/t08-comments/', import.meta.url),
): CommentInventoryStore {
  return {
    async save(record) {
      validateCommentInventory(record)
      await mkdir(directory, { recursive: true })
      for (
        const [suffix, text] of [
          ['json', JSON.stringify(record, null, 2) + '\n'],
          ['verify.sql', commentVerificationSql(record)],
          ['cleanup.sql', commentCleanupSql(record)],
        ]
      ) {
        const destination = new URL(`${record.runId}.${suffix}`, directory),
          temporary = new URL(`${record.runId}.${randomUUID()}.tmp`, directory)
        await writeFile(temporary, text, { mode: 0o600, flag: 'wx' })
        await rename(temporary, destination)
      }
    },
  }
}
