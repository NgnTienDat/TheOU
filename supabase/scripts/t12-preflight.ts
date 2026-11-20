import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { isOuEmail, normalizeOuEmail } from './auth-helpers.ts'
import { check } from './t06-cloud-inventory.ts'
import { t04ProjectRef, uuidPattern } from './t04-cloud-recovery.ts'
import { identityHash, keys, object } from './t09-cloud-inventory.ts'
import {
  type ModerationSnapshot,
  moderationSnapshotSql,
  parseModerationSnapshot,
} from './t11-cloud-inventory.ts'
import { canonical } from './t11-cloud-recovery.ts'

export const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
export const adminTargetEmailHash = '82e206c91e0b319cf8272950396171c1475ce89c146e5fe4db4a3b9e339a24c7'
export const t12Origin = `https://${t04ProjectRef}.supabase.co`
export const t12ApprovalFlags = [
  'THEOU_ALLOW_T12_AUTH',
  'THEOU_ALLOW_T12_FIXTURES',
  'THEOU_ALLOW_T12_MODERATION',
  'THEOU_ALLOW_T12_ROLE_REVIEW',
] as const

export function readT12Config(env: NodeJS.ProcessEnv, linkedRef: string, args: string[]) {
  const mode = args[0] ?? '--preflight'
  check(args.length <= 1 && ['--prepare', '--preflight'].includes(mode), 'T12_MODE_NOT_IMPLEMENTED_NO_WRITES')
  check(
    t12ApprovalFlags.every((key) => !env[key]) &&
      !Object.entries(env).some(([key, value]) =>
        value && /^THEOU_ALLOW_T\d+_.*(?:WRIT|DELET)|^THEOU_T11_SMOKE_RECOVERY_RUN_ID$/.test(key)
      ),
    'T12_READ_ONLY_FLAGS_REQUIRED',
  )
  if (mode === '--preflight') {
    check(env.THEOU_ALLOW_T12_PREFLIGHT === 'theou-dev', 'T12_PREFLIGHT_APPROVAL_REQUIRED')
    check(
      linkedRef.trim() === t04ProjectRef && env.THEOU_AUTH_SUPABASE_URL === t12Origin,
      'T12_EXACT_PROJECT',
    )
  }
  return { mode: mode as '--prepare' | '--preflight' }
}

export const t12FixturePlan = [
  {
    label: 'one-image',
    kind: 'POST',
    owner: 'A',
    parent: null,
    initial: 'DRAFT',
    final: 'DELETED',
    images: 1,
    visibleCount: 2,
    mutations: [
      'createPost',
      'createImageUpload',
      'finalizeImage',
      'publishPost',
      'toggleUpvote',
      'deletePost',
    ],
  },
  {
    label: 'post-hide',
    kind: 'POST',
    owner: 'A',
    parent: null,
    initial: 'DRAFT',
    final: 'HIDDEN',
    images: 0,
    visibleCount: 0,
    mutations: ['createPost', 'publishPost', 'adminHideContent'],
  },
  {
    label: 'two-images',
    kind: 'POST',
    owner: 'A',
    parent: null,
    initial: 'DRAFT',
    final: 'PUBLISHED',
    images: 2,
    visibleCount: 1,
    mutations: ['createPost', 'createImageUpload', 'finalizeImage', 'publishPost'],
  },
  {
    label: 'failed-upload',
    kind: 'POST',
    owner: 'A',
    parent: null,
    initial: 'DRAFT',
    final: 'DRAFT',
    images: 0,
    visibleCount: 0,
    mutations: ['createPost', 'createImageUpload'],
  },
  {
    label: 'b-comment',
    kind: 'COMMENT',
    owner: 'B',
    parent: 'one-image',
    initial: 'VISIBLE',
    final: 'VISIBLE',
    mutations: ['createComment'],
  },
  {
    label: 'op-reply',
    kind: 'COMMENT',
    owner: 'A',
    parent: 'one-image',
    initial: 'VISIBLE',
    final: 'VISIBLE',
    mutations: ['createComment'],
  },
  {
    label: 'own-delete',
    kind: 'COMMENT',
    owner: 'B',
    parent: 'one-image',
    initial: 'VISIBLE',
    final: 'DELETED',
    mutations: ['createComment', 'deleteComment'],
  },
  {
    label: 'comment-hide',
    kind: 'COMMENT',
    owner: 'A',
    parent: 'two-images',
    initial: 'VISIBLE',
    final: 'HIDDEN',
    mutations: ['createComment', 'adminHideContent'],
  },
  {
    label: 'visible-comment',
    kind: 'COMMENT',
    owner: 'B',
    parent: 'two-images',
    initial: 'VISIBLE',
    final: 'VISIBLE',
    mutations: ['createComment'],
  },
] as const

// C.1 chỉ chuẩn bị read-only; approval không tự biến thành bộ thực thi mutation.
export function assertT12WriteGate(
  _phase: 'auth' | 'fixtures' | 'moderation' | 'role',
  _env: NodeJS.ProcessEnv,
): never {
  check(false, 'T12_EXECUTION_NOT_IMPLEMENTED_REQUIRES_SEPARATE_REVIEW')
  throw new Error('unreachable')
}

export function verifyT12Actor(
  user: unknown,
  expectedEmail: string,
  snapshot: ModerationSnapshot,
  admin = false,
) {
  check(
    object(user) && typeof user.id === 'string' && uuidPattern.test(user.id) &&
      typeof user.email === 'string' && isOuEmail(user.email),
    'T12_VERIFIED_AUTH_IDENTITY_REQUIRED',
  )
  check(
    (user.is_anonymous === undefined || user.is_anonymous === false) &&
      typeof user.email_confirmed_at === 'string' &&
      Number.isFinite(Date.parse(user.email_confirmed_at)),
    'T12_CONFIRMED_NON_ANONYMOUS_REQUIRED',
  )
  check(normalizeOuEmail(user.email) === normalizeOuEmail(expectedEmail), 'T12_EXACT_ACTOR_EMAIL')
  if (admin) check(sha256(normalizeOuEmail(expectedEmail)) === adminTargetEmailHash, 'T12_OWNER_ADMIN_TARGET')
  const actorHash = identityHash(user.id.toLowerCase())
  check(
    snapshot.business.owners.some((p) => p.hash === actorHash && p.status === 'ACTIVE'),
    'T12_EXISTING_ACTIVE_PROFILE_REQUIRED',
  )
  return actorHash
}

export async function readT12Compatibility(directory = new URL('../migrations/', import.meta.url)) {
  const files = (await readdir(directory)).filter((n) => n.endsWith('.sql')).sort()
  check(files.length === 7, 'T12_MIGRATION_SET_REVIEW_REQUIRED')
  const functions = new Map<string, string>()
  for (const file of files) {
    const sql = (await readFile(new URL(file, directory), 'utf8')).replaceAll('\r\n', '\n')
    for (
      const match of sql.matchAll(
        /create(?: or replace)? function ([\w.]+)\([^)]*\)[\s\S]*?as \$\$([\s\S]*?)\$\$/gi,
      )
    ) functions.set(match[1], identityHash(match[2]))
  }
  check(functions.size === 11, 'T12_FUNCTION_SET_REVIEW_REQUIRED')
  return {
    versions: files.map((n) => n.split('_')[0]),
    functions: [...functions].map(([name, hash]) => ({ name, hash })),
  }
}

export function t12SnapshotSql(compatibility: Awaited<ReturnType<typeof readT12Compatibility>>) {
  // T11 khóa số ảnh=2; T12 kiểm soát bằng full baseline/manifest, không sửa SQL T11.
  const base = moderationSnapshotSql
    .replace("  and (select count(*)=2 from storage.objects where bucket_id='post-media')\n", '')
    .replace("  and (select count(*)=2 from public.post_images where status='READY')\n", '')
  const literal = (value: unknown) => `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`
  return `with original as (${base})
select jsonb_build_object('snapshot',snapshot,
 'compatibility',
 (select count(*)=${compatibility.versions.length} and bool_and(version in
   (select jsonb_array_elements_text(${
    literal(compatibility.versions)
  }))) from supabase_migrations.schema_migrations)
 and (select count(*)=${compatibility.functions.length} and bool_and(not p.prosecdef and p.proconfig=array['search_path=""']::text[]
   and md5(replace(p.prosrc,E'\\r\\n',E'\\n'))=e.hash
   and not has_function_privilege('anon',p.oid,'EXECUTE') and not has_function_privilege('authenticated',p.oid,'EXECUTE'))
   from jsonb_to_recordset(${literal(compatibility.functions)}) e(name text,hash text)
   join pg_namespace n on n.nspname=split_part(e.name,'.',1)
   join pg_proc p on p.pronamespace=n.oid and p.proname=split_part(e.name,'.',2))
 and (select count(*)=9 and bool_and(c.relrowsecurity and c.relforcerowsecurity) from pg_class c
   where c.relnamespace='public'::regnamespace and c.relkind='r'
   and c.relname in ('profiles','posts','comments','post_votes','post_images','reports','moderation_actions','user_roles','rate_limit_counters'))
 and not exists(select 1 from pg_class where relnamespace='public'::regnamespace and relkind in ('v','m'))
 -- T02 CF-01: tên function khác tên event trigger; NULL không được miễn allowlist.
 and not exists(select 1 from pg_proc p where p.pronamespace='public'::regnamespace and not coalesce((
   (p.oid=to_regprocedure('public.t11_admin_hide_content(uuid,text,uuid,text)')
     and p.prokind='f' and p.prorettype='void'::regtype and not p.proretset
     and not p.prosecdef and p.proowner='postgres'::regrole
     and p.proconfig=array['search_path=""']::text[]
     and not has_function_privilege('anon',p.oid,'EXECUTE')
     and not has_function_privilege('authenticated',p.oid,'EXECUTE')
     and not has_function_privilege('supabase_auth_admin',p.oid,'EXECUTE')
     and has_function_privilege('service_role',p.oid,'EXECUTE'))
   or (p.oid=to_regprocedure('public.rls_auto_enable()') and p.pronargs=0 and p.prokind='f'
     and p.prorettype='event_trigger'::regtype and not p.proretset and p.prosecdef
     and p.proowner='postgres'::regrole
     and p.prolang=(select oid from pg_language where lanname='plpgsql')
     and p.proconfig=array['search_path=pg_catalog']::text[]
     and md5(p.prosrc)='c44fb229ea8a6b0afd04a0a33261c16c'
     and (select count(*) from pg_event_trigger where evtfoid=p.oid)=1
     and exists(select 1 from pg_event_trigger e where e.evtfoid=p.oid
       and e.evtname='ensure_rls' and e.evtowner='postgres'::regrole
       and e.evtevent='ddl_command_end' and e.evtenabled='O'
       and array(select unnest(e.evttags) order by 1)
         =array['CREATE TABLE','CREATE TABLE AS','SELECT INTO']::text[]))
 ),false))
 and (select count(*)=1 and bool_and(allowed_mime_types @> array['image/jpeg','image/png','image/webp']::text[] and cardinality(allowed_mime_types)=3)
   from storage.buckets where id='post-media'),
 'existingAuthEligible',not exists(select 1 from auth.users u left join public.profiles p on p.id=u.id
   where p.status is distinct from 'ACTIVE' or coalesce(u.is_anonymous,false) or u.email_confirmed_at is null
   or not isfinite(u.email_confirmed_at) or u.email is null or char_length(u.email)>254 or char_length(split_part(u.email,'@',1))>64
   or u.email !~* $ou$^[a-z0-9!#$%&'*+/=?^_\x60{|}~-]+([.][a-z0-9!#$%&'*+/=?^_\x60{|}~-]+)*@ou[.]edu[.]vn$$ou$)
) as proof from original`
}

export function parseT12Proof(value: unknown, expected: ModerationSnapshot) {
  check(
    keys(value, ['snapshot', 'compatibility', 'existingAuthEligible']) && value.compatibility === true &&
      value.existingAuthEligible === true,
    'T12_COMPATIBILITY_OR_EXISTING_AUTH',
  )
  const snapshot = parseModerationSnapshot(value.snapshot)
  check(
    snapshot.roles.length === 0 && snapshot.business.counts.roles === 0 &&
      snapshot.business.roleHash === identityHash('[]'),
    'T12_ROLES_MUST_BE_ZERO',
  )
  check(canonical(snapshot) === canonical(expected), 'T12_PROTECTED_FULL_SNAPSHOT_DRIFT')
  return snapshot
}

export function t12RoleReviewTemplate(kind: 'grant' | 'revoke') {
  return `# T12 ${kind.toUpperCase()} — BLOCKED / REVIEW TEMPLATE ONLY
No executable SQL in C.1. Never use T11 grant/revoke SQL.
1. Pin exact project + fresh phase snapshot and T12 manifest SHA-256, settled journal and local lock/quiescence.
2. Auth getUser verifies exact owner-approved ADMIN target, confirmed OU, non-anonymous, existing ACTIVE profile; hash alone cannot recover UUID.
3. One BEGIN/COMMIT; SET LOCAL exact UUID supplied locally; comment->post->profile->role lock order; no network inside transaction.
4. Full snapshot equality, not counts only. ${
    kind === 'grant'
      ? 'Require roles=0, Auth/profile row locks and exact approved actor hash.'
      : 'Require exactly one ADMIN of approved actor, exact approved role fingerprint/row hash; keep all audits.'
  }
5. Exactly one ${
    kind === 'grant' ? 'INSERT (actor,ADMIN)' : 'DELETE (actor,ADMIN)'
  }, affected rows=1. No Auth/profile/content/audit writes.
6. Same-transaction postcondition: only approved role delta, all other full proofs unchanged; any failure rolls back.
7. Fresh read-only verification + getMe/admin denial after revoke. Unknown outcome -> stop and review, never retry automatically.
Missing phase-specific SQL/assertions/UUID/approval -> BLOCKED. Review/implement transaction separately before owner execution.
`
}
