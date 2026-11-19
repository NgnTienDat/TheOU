import { randomUUID } from 'node:crypto'
import { mkdir, open, readdir, readFile, rename, unlink } from 'node:fs/promises'
import { check } from './t06-cloud-inventory.ts'
import { literal } from './t08-cloud-inventory.ts'
import {
  identityHash,
  keys,
  parseVoteSnapshot,
  type VoteSnapshot,
  voteSnapshotSql,
} from './t09-cloud-inventory.ts'
import { t04ProjectRef, uuidPattern } from './t04-cloud-recovery.ts'

export const retainedMediaPost = 'd8ce8b82-91e0-433a-a9ff-2113922351f3'
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{32}$/.test(v)
const uuid = (v: unknown): v is string => typeof v === 'string' && uuidPattern.test(v)
export type Label =
  | 'owner'
  | 'post-hide'
  | 'comments'
  | 'race'
  | 'draft'
  | 'owner-ref'
  | 'comment-hide'
  | 'comment-delete'
const plan: { label: Label; kind: 'POST' | 'COMMENT'; owner: 'A' | 'B'; parent: Label | null }[] = [
  ...(['owner', 'post-hide', 'comments', 'race', 'draft'] as const).map((label) => ({
    label,
    kind: 'POST' as const,
    owner: 'A' as const,
    parent: null,
  })),
  { label: 'owner-ref', kind: 'COMMENT', owner: 'B', parent: 'owner' },
  { label: 'comment-hide', kind: 'COMMENT', owner: 'A', parent: 'comments' },
  { label: 'comment-delete', kind: 'COMMENT', owner: 'B', parent: 'comments' },
]
interface Proof {
  id: string
  keyHash: string
  bodyHash: string
  immutableHash: string
  publishedHash: string
  publishedAt?: string | null
}
interface CommentProof extends Omit<Proof, 'publishedHash' | 'publishedAt'> {
  authorHash: string
}
export interface AuditProof {
  id: string
  actorHash: string
  type: 'POST' | 'COMMENT'
  targetId: string
  reasonHash: string
  rowHash: string
  action: string
}
export interface ModerationSnapshot {
  business: VoteSnapshot
  security: boolean
  storageHash: string
  auxHash: string
  postProofs: Proof[]
  commentProofs: CommentProof[]
  audits: AuditProof[]
  roles: { actorHash: string; role: string; rowHash: string }[]
}

// SELECT duy nhất; không trả Auth UUID/email, raw body/reason hoặc Storage path.
export const moderationSnapshotSql = `with b as (${voteSnapshotSql})
select jsonb_build_object('business',(select snapshot from b),
 'security',
  exists(select 1 from supabase_migrations.schema_migrations where version='20261118092925')
  and (select count(*)=3 and bool_and(not prosecdef and proowner='postgres'::regrole and proconfig=array['search_path=""']::text[]
    and prorettype in ('void'::regtype,'trigger'::regtype)
    and has_function_privilege('service_role',oid,'EXECUTE')
    and not has_function_privilege('anon',oid,'EXECUTE')
    and not has_function_privilege('authenticated',oid,'EXECUTE')
    and not has_function_privilege('supabase_auth_admin',oid,'EXECUTE')
    and not exists(select 1 from aclexplode(coalesce(proacl,acldefault('f',proowner))) a
      where a.privilege_type='EXECUTE' and a.grantee not in (proowner,'service_role'::regrole)))
    from pg_proc where oid in (to_regprocedure('public.t11_admin_hide_content(uuid,text,uuid,text)'),
     to_regprocedure('theou_private.guard_post_lifecycle()'),to_regprocedure('theou_private.guard_audit_immutable()')))
  and (select count(*)=7 and bool_and(t.tgenabled='O' and t.tgfoid=case t.tgname
    when 'posts_lifecycle' then to_regprocedure('theou_private.guard_post_lifecycle()')
    when 'moderation_actions_immutable' then to_regprocedure('theou_private.guard_audit_immutable()')
    when 'comments_lifecycle' then to_regprocedure('theou_private.guard_comment_lifecycle()')
    when 'comments_sync_count' then to_regprocedure('theou_private.sync_comment_count()')
    when 'post_votes_sync_count' then to_regprocedure('theou_private.sync_upvote_count()')
    when 'posts_prepare_publish' then to_regprocedure('theou_private.prepare_post_publish()')
    when 'post_images_draft_guard' then to_regprocedure('theou_private.guard_draft_image()') end) from pg_trigger t
    join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and (c.relname,t.tgname) in
    (('posts','posts_lifecycle'),('moderation_actions','moderation_actions_immutable'),('comments','comments_lifecycle'),
     ('comments','comments_sync_count'),('post_votes','post_votes_sync_count'),
     ('posts','posts_prepare_publish'),('post_images','post_images_draft_guard')))
  and not exists(select 1 from pg_class c where c.relnamespace='public'::regnamespace and c.relkind='r'
    and (not c.relrowsecurity or has_table_privilege('anon',c.oid,'SELECT,INSERT,UPDATE,DELETE')
      or has_table_privilege('authenticated',c.oid,'SELECT,INSERT,UPDATE,DELETE')))
  and coalesce((select not public and file_size_limit=2097152 from storage.buckets where id='post-media'),false)
  and (select relrowsecurity from pg_class where oid='storage.objects'::regclass)
  and (select count(*)=2 from storage.objects where bucket_id='post-media')
  and (select count(*)=2 from public.post_images where status='READY')
  and not exists(select 1 from pg_policies where schemaname='storage' and tablename='objects'),
 'storageHash',md5(jsonb_build_array(
   (select coalesce(jsonb_agg(to_jsonb(x) order by id),'[]') from storage.buckets x),
   (select coalesce(jsonb_agg(to_jsonb(x) order by bucket_id,name),'[]') from storage.objects x))::text),
 'auxHash',md5(jsonb_build_array(
   (select coalesce(jsonb_agg(to_jsonb(x) order by id),'[]') from public.post_images x),
   (select coalesce(jsonb_agg(to_jsonb(x) order by id),'[]') from public.reports x),
   (select coalesce(jsonb_agg(to_jsonb(x) order by actor_id,action,window_start),'[]') from public.rate_limit_counters x))::text),
 'postProofs',(select coalesce(jsonb_agg(jsonb_build_object('id',id,'keyHash',md5(idempotency_key::text),
   'bodyHash',md5(body),'immutableHash',md5((to_jsonb(p)-'status'-'updated_at'-'comment_count'-'upvote_count'-'published_at')::text),
   'publishedHash',md5(coalesce(published_at::text,'')),
   'publishedAt',to_char(published_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')) order by id),'[]') from public.posts p),
 'commentProofs',(select coalesce(jsonb_agg(jsonb_build_object('id',id,'keyHash',md5(idempotency_key::text),
   'bodyHash',md5(body),'authorHash',md5(author_id::text),
   'immutableHash',md5((to_jsonb(c)-'status'-'updated_at')::text)) order by id),'[]') from public.comments c),
 'audits',(select coalesce(jsonb_agg(jsonb_build_object('id',id,'actorHash',md5(admin_id::text),
   'type',target_type,'targetId',target_id,'action',action,'reasonHash',md5(reason),
   'rowHash',md5(to_jsonb(a)::text)) order by id),'[]') from public.moderation_actions a),
 'roles',(select coalesce(jsonb_agg(jsonb_build_object('actorHash',md5(user_id::text),'role',role,
   'rowHash',md5(to_jsonb(r)::text)) order by user_id,role),'[]') from public.user_roles r)
) as snapshot`

export function parseModerationSnapshot(value: unknown): ModerationSnapshot {
  check(
    keys(value, [
      'business',
      'security',
      'storageHash',
      'auxHash',
      'postProofs',
      'commentProofs',
      'audits',
      'roles',
    ]),
    'T11_SNAPSHOT_SHAPE',
  )
  const b = parseVoteSnapshot(value.business)
  check(
    value.security === true && hash(value.storageHash) && hash(value.auxHash),
    'T11_SECURITY_OR_STORAGE_PROOF',
  )
  check(
    Array.isArray(value.postProofs) && Array.isArray(value.commentProofs) && Array.isArray(value.audits) &&
      Array.isArray(value.roles),
    'T11_SNAPSHOT_ARRAYS',
  )
  check(
    value.postProofs.every((p) =>
      (keys(p, ['id', 'keyHash', 'bodyHash', 'immutableHash', 'publishedHash']) ||
        keys(p, ['id', 'keyHash', 'bodyHash', 'immutableHash', 'publishedHash', 'publishedAt']) &&
          (p.publishedAt === null ||
            typeof p.publishedAt === 'string' &&
              /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(p.publishedAt) &&
              Number.isFinite(Date.parse(p.publishedAt)))) &&
      uuid(p.id) &&
      [p.keyHash, p.bodyHash, p.immutableHash, p.publishedHash].every(hash)
    ) &&
      value.commentProofs.every((p) =>
        keys(p, ['id', 'keyHash', 'bodyHash', 'immutableHash', 'authorHash']) && uuid(p.id) &&
        [p.keyHash, p.bodyHash, p.immutableHash, p.authorHash].every(hash)
      ) &&
      value.audits.every((a) =>
        keys(a, ['id', 'actorHash', 'type', 'targetId', 'action', 'reasonHash', 'rowHash']) && uuid(a.id) &&
        uuid(a.targetId) && ['POST', 'COMMENT'].includes(String(a.type)) && a.action === 'HIDE' &&
        [a.actorHash, a.reasonHash, a.rowHash].every(hash)
      ) &&
      value.roles.every((r) =>
        keys(r, ['actorHash', 'role', 'rowHash']) && hash(r.actorHash) && r.role === 'ADMIN' &&
        hash(r.rowHash)
      ),
    'T11_SNAPSHOT_PROOFS',
  )
  for (const [rows, expected] of [[value.postProofs, b.posts], [value.commentProofs, b.comments]] as const) {
    check(
      rows.length === expected.length && new Set(rows.map((r) => r.id)).size === rows.length &&
        rows.every((r) => expected.some((e) => e.id === r.id)),
      'T11_PROOF_EXACT_IDS',
    )
  }
  check(
    value.audits.length === b.counts.moderation &&
      new Set(value.audits.map((a) => a.id)).size === value.audits.length &&
      value.roles.length === b.counts.roles &&
      new Set(value.roles.map((r) => r.actorHash)).size === value.roles.length,
    'T11_AUDIT_ROLE_COUNTS',
  )
  return value as unknown as ModerationSnapshot
}
export function assertModerationBaseline(s: ModerationSnapshot) {
  parseModerationSnapshot(s)
  const b = s.business
  check(
    b.counts.users === 2 && b.counts.profiles === 2 && b.counts.roles === 0 && b.counts.posts === 3 &&
      b.posts.every((p) => p.status === 'PUBLISHED') && b.posts.some((p) => p.id === retainedMediaPost) &&
      b.counts.comments === 3 && b.comments.filter((c) => c.status === 'VISIBLE').length === 2 &&
      b.comments.filter((c) => c.status === 'DELETED').length === 1 && b.counts.votes === 0 &&
      b.counts.images === 2 && b.counts.moderation === 0 && b.owners.every((o) => o.status === 'ACTIVE'),
    'T11_BASELINE_REVIEW_REQUIRED',
  )
}
export interface ModerationFixture {
  label: Label
  kind: 'POST' | 'COMMENT'
  owner: 'A' | 'B'
  parent: Label | null
  key: string
  body: string
  id: string | null
  status: 'DRAFT' | 'PUBLISHED' | 'VISIBLE' | 'HIDDEN' | 'DELETED' | null
  immutableHash: string | null
  publishedHash: string | null
}
export interface ModerationInventory {
  version: 1
  projectRef: string
  runId: string
  actors: { A: string; B: string }
  baseline: ModerationSnapshot
  fixtures: ModerationFixture[]
  retention: 'KEEP_FIXTURES_AND_AUDIT'
}
export interface ModerationJournal {
  inventory: ModerationInventory
  status:
    | 'RUNNING'
    | 'COMPLETED_SMOKE'
    | 'AWAITING_MODERATION_REVIEW'
    | 'AWAITING_RETENTION_AND_ROLE_REVIEW'
    | 'UNCERTAIN'
  uncertain: boolean
  roles: ModerationSnapshot['roles']
  audits: AuditProof[]
  events: { stage: string; phase: 'INTENT' | 'ACK' | 'VERIFIED'; proof: string }[]
  last: ModerationSnapshot
}
export function makeModerationInventory(
  runId: string,
  baseline: ModerationSnapshot,
  actors: ModerationInventory['actors'],
  smoke = false,
): ModerationInventory {
  return {
    version: 1,
    projectRef: t04ProjectRef,
    runId,
    actors,
    baseline,
    retention: 'KEEP_FIXTURES_AND_AUDIT',
    fixtures: smoke ? [] : plan.map((p) => ({
      ...p,
      key: randomUUID(),
      body: `T11-CLOUD-TEST-${runId} ${p.label}`,
      id: null,
      status: null,
      immutableHash: null,
      publishedHash: null,
    })),
  }
}
export function validateModerationInventory(i: ModerationInventory) {
  check(
    keys(i, ['version', 'projectRef', 'runId', 'actors', 'baseline', 'fixtures', 'retention']) &&
      i.version === 1 && i.projectRef === t04ProjectRef && hash(i.runId) &&
      i.retention === 'KEEP_FIXTURES_AND_AUDIT' && keys(i.actors, ['A', 'B']) && hash(i.actors.A) &&
      hash(i.actors.B) && i.actors.A !== i.actors.B && Array.isArray(i.fixtures),
    'T11_INVENTORY_SCHEMA',
  )
  assertModerationBaseline(i.baseline)
  check(
    Object.values(i.actors).every((h) =>
      i.baseline.business.owners.some((o) => o.hash === h && o.status === 'ACTIVE')
    ) && [0, plan.length].includes(i.fixtures.length),
    'T11_INVENTORY_ACTORS_OR_PLAN',
  )
  for (const [index, f] of i.fixtures.entries()) {
    const p = plan[index]
    check(
      keys(f, [
        'label',
        'kind',
        'owner',
        'parent',
        'key',
        'body',
        'id',
        'status',
        'immutableHash',
        'publishedHash',
      ]) && f.label === p.label && f.kind === p.kind && f.owner === p.owner && f.parent === p.parent &&
        uuid(f.key) && f.body === `T11-CLOUD-TEST-${i.runId} ${p.label}` && (f.id === null || uuid(f.id)) &&
        (f.id === null
          ? f.status === null && f.immutableHash === null && f.publishedHash === null
          : f.kind === 'POST'
          ? ['DRAFT', 'PUBLISHED', 'HIDDEN', 'DELETED'].includes(String(f.status))
          : ['VISIBLE', 'HIDDEN', 'DELETED'].includes(String(f.status))) &&
        (f.immutableHash === null || hash(f.immutableHash)) &&
        (f.publishedHash === null || hash(f.publishedHash)),
      'T11_FIXTURE_SCHEMA',
    )
    check(
      !i.baseline.business.posts.some((p) => p.id === f.id) &&
        !i.baseline.business.comments.some((c) => c.id === f.id),
      'T11_PROTECTED_TARGET',
    )
  }
  check(
    new Set(i.fixtures.map((f) => f.key)).size === i.fixtures.length && new Set(
          i.fixtures.filter((f) => f.id).map((f) => f.id),
        ).size === i.fixtures.filter((f) => f.id).length,
    'T11_FIXTURE_DUPLICATE',
  )
}
export const reasonFor = (runId: string, label: Label) => `T11 controlled moderation ${runId} ${label}`
export function assertModerationScope(j: ModerationJournal, s: ModerationSnapshot) {
  validateModerationInventory(j.inventory)
  parseModerationSnapshot(s)
  const i = j.inventory, b = i.baseline.business, c = s.business
  check(
    s.security === i.baseline.security && s.storageHash === i.baseline.storageHash &&
      s.auxHash === i.baseline.auxHash && c.authHash === b.authHash && c.profileHash === b.profileHash &&
      JSON.stringify(c.owners) === JSON.stringify(b.owners) && c.counts.users === b.counts.users &&
      c.counts.profiles === b.counts.profiles && c.counts.images === b.counts.images &&
      c.counts.reports === b.counts.reports && c.counts.limits === b.counts.limits &&
      JSON.stringify(c.votes) === JSON.stringify(b.votes) &&
      JSON.stringify(s.roles) === JSON.stringify(j.roles),
    'T11_PROTECTED_OR_ROLE_DRIFT',
  )
  for (const name of ['posts', 'comments'] as const) {
    check(
      b[name].every((row) => JSON.stringify(c[name].find((p) => p.id === row.id)) === JSON.stringify(row)),
      'T11_PROTECTED_ROW_DRIFT',
    )
    const fs = i.fixtures.filter((f) => f.kind === (name === 'posts' ? 'POST' : 'COMMENT') && f.id)
    check(
      c[name].length === b[name].length + fs.length &&
        c[name].every((row) => b[name].some((p) => p.id === row.id) || fs.some((f) => f.id === row.id)),
      'T11_UNKNOWN_OR_MISSING_FIXTURE',
    )
  }
  for (const f of i.fixtures.filter((f) => f.id)) {
    const row = f.kind === 'POST' ? c.posts.find((p) => p.id === f.id) : c.comments.find((p) => p.id === f.id)
    const proof = f.kind === 'POST'
      ? s.postProofs.find((p) => p.id === f.id)
      : s.commentProofs.find((p) => p.id === f.id)
    check(
      row && proof && row.status === f.status && proof.keyHash === identityHash(f.key) &&
        proof.bodyHash === identityHash(f.body) &&
        (!f.immutableHash || proof.immutableHash === f.immutableHash),
      'T11_FIXTURE_SCOPE_MISMATCH',
    )
    if (f.kind === 'POST') {
      check(
        'authorHash' in row && row.authorHash === i.actors[f.owner] && 'publishedHash' in proof &&
          (!f.publishedHash || f.publishedHash === proof.publishedHash),
        'T11_POST_OWNER_OR_PUBLISH_DRIFT',
      )
    } else {check(
        'authorHash' in proof && proof.authorHash === i.actors[f.owner] && 'postId' in row &&
          row.postId === i.fixtures.find((p) => p.label === f.parent)?.id,
        'T11_COMMENT_OWNER_OR_PARENT',
      )}
  }
  const hidden = i.fixtures.filter((f) => f.status === 'HIDDEN')
  check(
    s.audits.length === hidden.length &&
      s.audits.every((a) =>
        hidden.some((f) =>
          f.id === a.targetId && f.kind === a.type &&
          a.reasonHash === identityHash(reasonFor(i.runId, f.label))
        ) && j.roles.some((r) => r.actorHash === a.actorHash)
      ) && new Set(s.audits.map((a) => a.targetId)).size === hidden.length &&
      j.audits.every((a) => JSON.stringify(s.audits.find((x) => x.id === a.id)) === JSON.stringify(a)),
    'T11_AUDIT_TRANSITION_OR_FINGERPRINT',
  )
}
export function validateModerationJournal(j: ModerationJournal) {
  check(
    keys(j, ['inventory', 'status', 'uncertain', 'roles', 'audits', 'events', 'last']) &&
      [
        'RUNNING',
        'COMPLETED_SMOKE',
        'AWAITING_MODERATION_REVIEW',
        'AWAITING_RETENTION_AND_ROLE_REVIEW',
        'UNCERTAIN',
      ].includes(j.status) && typeof j.uncertain === 'boolean' && Array.isArray(j.events) &&
      j.events.every((e) =>
        keys(e, ['stage', 'phase', 'proof']) && /^[A-Z0-9_]{1,64}$/.test(e.stage) &&
        ['INTENT', 'ACK', 'VERIFIED'].includes(e.phase) && /^[a-f0-9]{64}$/.test(e.proof)
      ),
    'T11_JOURNAL_SCHEMA',
  )
  validateModerationInventory(j.inventory)
  parseModerationSnapshot(j.last)
  check(
    j.uncertain || j.events.length === 0 && j.status === 'RUNNING' || j.events.at(-1)?.phase === 'VERIFIED',
    'T11_UNRESOLVED_INTENT',
  )
  check(
    JSON.stringify(j.roles) === JSON.stringify(j.last.roles) &&
      JSON.stringify(j.audits) === JSON.stringify(j.last.audits),
    'T11_JOURNAL_LAST_PROOF',
  )
  if (!j.uncertain) assertModerationScope(j, j.last)
}

export function moderationVerificationSql(i: ModerationInventory) {
  validateModerationInventory(i)
  return `-- READ ONLY: ${t04ProjectRef}; run ${i.runId}. Inspect locally, never print raw records.
${moderationSnapshotSql};
with expected as (select * from jsonb_to_recordset(${literal(JSON.stringify(i.fixtures))}::jsonb)
 as x(label text,kind text,key uuid,body text,id uuid,status text,owner text,parent text))
select e.label,e.kind,e.status as expected_status,
 (select count(*) from public.posts p where e.kind='POST' and p.idempotency_key=e.key
   and p.id=e.id and p.body=e.body and p.status=e.status and md5(p.author_id::text)=case e.owner when 'A' then ${
    literal(i.actors.A)
  } else ${literal(i.actors.B)} end) +
 (select count(*) from public.comments c where e.kind='COMMENT' and c.idempotency_key=e.key
   and c.id=e.id and c.body=e.body and c.status=e.status and c.post_id=(select id from expected where label=e.parent)
   and md5(c.author_id::text)=case e.owner when 'A' then ${literal(i.actors.A)} else ${
    literal(i.actors.B)
  } end) as exact_rows
from expected e order by e.label;
-- If a request ACK was lost, exact_rows may be 0 because id is unknown. Use key/body/owner hashes locally;
-- do not adopt UUIDs, change journal, or replay the batch without a separate recovery review.
`
}
const withoutReadOnly = (s: ModerationSnapshot) => ({
  ...s,
  business: { ...s.business, readOnly: undefined },
})
export function roleReviewSql(j: ModerationJournal, actor: 'A' | 'B', revoke: boolean) {
  validateModerationJournal(j)
  const ready = !j.uncertain &&
    j.status === (revoke ? 'AWAITING_RETENTION_AND_ROLE_REVIEW' : 'AWAITING_MODERATION_REVIEW')
  if (!ready) {
    return "-- REVIEW ONLY: not ready.\ndo $$begin raise exception 'T11 role review blocked';end;$$;\n"
  }
  const expected = literal(JSON.stringify(withoutReadOnly(j.last))), actorHash = j.inventory.actors[actor]
  check(
    revoke ? j.roles.length === 1 && j.roles[0].actorHash === actorHash : j.roles.length === 0,
    'T11_ROLE_REVIEW_ACTOR',
  )
  return `-- REVIEW ONLY; NEVER executed by runner. ${t04ProjectRef}; run ${j.inventory.runId}; actor ${actor}.
-- Reviewer must provide exact UUID locally inside this transaction: SET LOCAL theou.t11_admin_id='...';
-- No lookup by domain/prefix/hash and no user/profile/audit deletion. Review retention separately.
begin;
set local lock_timeout='3s'; set local statement_timeout='10s';
-- Insert the exact SET LOCAL here after reviewing actor and connected project.
lock table public.comments,public.posts,public.profiles,public.user_roles,public.post_votes,
 public.post_images,public.moderation_actions,public.reports,public.rate_limit_counters in share row exclusive mode;
do $review$
declare approved_admin_id uuid:=nullif(current_setting('theou.t11_admin_id',true),'')::uuid; observed jsonb; n integer;
begin
 if approved_admin_id is null or md5(approved_admin_id::text)<>${
    literal(actorHash)
  } then raise exception 'T11 exact approved actor required'; end if;
 select snapshot into observed from (${moderationSnapshotSql}) s;
 observed:=jsonb_set(observed,'{business}',(observed->'business')-'readOnly');
 if observed<>${expected}::jsonb then raise exception 'T11 snapshot/audit/role drift; no role change';end if;
 if not exists(select 1 from public.profiles where id=approved_admin_id and status='ACTIVE') then raise exception 'T11 actor not active';end if;
 ${
    revoke
      ? "delete from public.user_roles where user_id=approved_admin_id and role='ADMIN';"
      : "insert into public.user_roles(user_id,role) values(approved_admin_id,'ADMIN');"
  }
 get diagnostics n=row_count;
 if n<>1 then raise exception 'T11 exact role change expected';end if;
end;$review$;
commit;
-- Re-run read-only verification; keep Auth user, fixture rows and immutable audits.
`
}
export function moderationRetentionPlan(i: ModerationInventory) {
  validateModerationInventory(i)
  return `# T11 retention review — ${i.runId}\n\nProject ${t04ProjectRef}. KEEP_FIXTURES_AND_AUDIT must be approved before writes.\nKeep PUBLISHED/DRAFT, HIDDEN/DELETED posts, HIDDEN/DELETED comments and append-only audits. No automatic cleanup, DELETE/TRUNCATE, counter reset or Storage deletion.\nRetain both existing Auth actors/profiles. FK audit admin_id blocks deleting an audited admin identity. Review exact temporary ADMIN role separately using grant-review.sql/revoke-review.sql.\nProtected baseline: three original posts including ${retainedMediaPost}, three original comments, two image rows and Storage objects. Full hashes live only in local inventory/journal.\nInterrupted/unknown commit: stop; verify.sql and fresh read-only snapshots, never replay a batch or edit a journal to force PASS.\n`
}
export interface ModerationStore {
  acquire(runId: string, resume: boolean, mode?: string): Promise<void>
  load(runId: string): Promise<ModerationJournal>
  save(j: ModerationJournal, adminActor: 'A' | 'B'): Promise<void>
  release(): Promise<void>
  verifyRecoverySnapshot?(snapshot: ModerationSnapshot): Promise<void>
}
export function fileModerationStore(
  directory = new URL('../.temp/t11-moderation/', import.meta.url),
  recovery?: {
    runId: string
    purpose: 'review' | 'retry' | 'fixture' | 'moderate'
    resumeRunId?: string
    verify(j: ModerationJournal): Promise<void>
  },
): ModerationStore {
  let owned = false, runId = '', prior = ''
  const lock = new URL('theou-dev.lock', directory)
  const read = async (id: string) => {
    check(hash(id), 'T11_STORE_RUN_ID')
    const j = JSON.parse(
      await readFile(new URL(`${id}.journal.json`, directory), 'utf8'),
    ) as ModerationJournal
    validateModerationJournal(j)
    check(
      j.inventory.runId === id &&
        JSON.stringify(JSON.parse(await readFile(new URL(`${id}.json`, directory), 'utf8'))) ===
          JSON.stringify(j.inventory),
      'T11_ARTIFACT_MISMATCH',
    )
    return j
  }
  async function write(name: string, value: string) {
    const temp = new URL(`${name}.${randomUUID()}.tmp`, directory), handle = await open(temp, 'wx', 0o600)
    try {
      await handle.writeFile(value)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temp, new URL(name, directory))
  }
  return {
    async acquire(id, resume, mode) {
      check(hash(id) && !owned, 'T11_STORE_RUN_ID')
      if (recovery) {
        check(
          recovery.purpose === 'moderate'
            ? resume && mode === '--moderate-write' && id === recovery.resumeRunId && id !== recovery.runId
            : !resume &&
              (recovery.purpose === 'review'
                ? mode === '--review-failed-smoke' && id === recovery.runId
                : mode === (recovery.purpose === 'fixture' ? '--fixture-write' : '--smoke') &&
                  id !== recovery.runId),
          'T11_RECOVERY_SMOKE_ONLY',
        )
      }
      await mkdir(directory, { recursive: true })
      try {
        const h = await open(lock, 'wx', 0o600)
        owned = true
        try {
          await h.writeFile(id)
          await h.sync()
        } finally {
          await h.close()
        }
      } catch {
        check(false, 'T11_LOCAL_SCOPE_LOCK')
      }
      runId = id
      const names = await readdir(directory)
      let reviewed: ModerationJournal | undefined
      for (const name of names) {
        const other = /^([a-f0-9]{32})\./.exec(name)?.[1]
        check(!other || names.includes(`${other}.journal.json`), 'T11_ORPHAN_ARTIFACT_REVIEW')
        if (!name.endsWith('.journal.json')) continue
        check(other, 'T11_JOURNAL_FILENAME')
        const j = await read(other)
        if (recovery && other === recovery.runId) {
          reviewed = j
          continue
        }
        check(
          !j.uncertain &&
            (other === id && resume && j.status === 'AWAITING_MODERATION_REVIEW' ||
              j.status === 'COMPLETED_SMOKE'),
          'T11_UNRESOLVED_JOURNAL_NO_RETRY',
        )
      }
      check(
        resume || recovery?.purpose === 'review'
          ? names.includes(`${id}.journal.json`)
          : !names.includes(`${id}.journal.json`),
        'T11_RESUME_FILE_OR_RUN_EXISTS',
      )
      if (recovery) {
        check(reviewed, 'T11_RECOVERY_ORIGINAL_REQUIRED')
        await recovery.verify(reviewed)
      }
    },
    async load(id) {
      check(owned && runId === id, 'T11_STORE_LOCK_REQUIRED')
      const j = await read(id)
      prior = JSON.stringify(j)
      return j
    },
    async save(j, actor) {
      check(
        !recovery || recovery.purpose !== 'review' && j.inventory.runId !== recovery.runId,
        'T11_RECOVERY_ORIGINAL_IMMUTABLE',
      )
      check(owned && j.inventory.runId === runId, 'T11_STORE_LOCK_REQUIRED')
      validateModerationJournal(j)
      if (prior) {
        const disk = await read(runId), old = JSON.parse(prior) as ModerationJournal
        check(
          JSON.stringify(disk) === prior &&
            JSON.stringify(j.events.slice(0, old.events.length)) === JSON.stringify(old.events) &&
            JSON.stringify(j.inventory.baseline) === JSON.stringify(old.inventory.baseline) &&
            JSON.stringify(j.inventory.actors) === JSON.stringify(old.inventory.actors),
          'T11_EXTERNAL_OR_HISTORY_CHANGE',
        )
      }
      await write(`${runId}.journal.json`, JSON.stringify(j, null, 2) + '\n')
      prior = JSON.stringify(j)
      await write(`${runId}.json`, JSON.stringify(j.inventory, null, 2) + '\n')
      await write(`${runId}.verify.sql`, moderationVerificationSql(j.inventory))
      await write(`${runId}.retention-plan.md`, moderationRetentionPlan(j.inventory))
      await write(`${runId}.grant-review.sql`, roleReviewSql(j, actor, false))
      await write(`${runId}.revoke-review.sql`, roleReviewSql(j, actor, true))
    },
    async release() {
      if (owned) {
        await unlink(lock)
        owned = false
      }
    },
  }
}
