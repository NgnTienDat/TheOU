import { check } from './t06-cloud-inventory.ts'
import { type ModerationJournal, moderationSnapshotSql, roleReviewSql } from './t11-cloud-inventory.ts'
import { assertReadyModerationFixture } from './t11-moderation-gate.ts'

export const adminUuidPlaceholder = '<EXACT_ACTOR_B_UUID>'
export const roleFingerprintPlaceholder = '<APPROVED_POST_GRANT_ROLE_FINGERPRINT>'
export const readyJournalPlaceholder = '<REVIEWED_UNCHANGED_READY_JOURNAL_SHA256>'
const identityMarker = '-- Insert the exact SET LOCAL here after reviewing actor and connected project.'

// Chỉ ghép bản đã review; không thay DO gốc hoặc thực thi SQL.
export function assembleAdminGrant(j: ModerationJournal, original: string, companion: string) {
  check(original === roleReviewSql(j, 'B', false), 'T11_GRANT_ORIGINAL_TEMPLATE_MISMATCH')
  return original.replace(identityMarker, () => `set local theou.t11_admin_id='${adminUuidPlaceholder}';`)
    .replace('do $review$', () => companion + '\ndo $review$')
}

export function emergencyAdminRevoke(j: ModerationJournal, readyJournalSha: string) {
  assertReadyModerationFixture(j)
  check(/^[a-f0-9]{64}$/.test(readyJournalSha), 'T11_REVOKE_READY_JOURNAL_SHA')
  const baseline = structuredClone(j.last)
  delete (baseline.business as Partial<typeof baseline.business>).readOnly
  const expected = JSON.stringify(baseline).replaceAll("'", "''")
  const actorHash = j.inventory.actors.B
  return `-- EMERGENCY REVIEW ONLY: TheOU-dev puhkisyehspcmgzerutm; run ${j.inventory.runId}; actor B.
-- ONLY before moderation starts: revalidate unchanged 19 evidence files, no lock/process or unresolved mutation.
-- SQL cannot read the local journal: entering its checksum attests to that separate fresh review.
-- Never run after RUNNING/INTENT/unknown commit, even if audit count is zero.
begin;
set local lock_timeout='3s'; set local statement_timeout='10s';
set local theou.t11_admin_id='${adminUuidPlaceholder}';
set local theou.t11_approved_role_fingerprint='${roleFingerprintPlaceholder}';
set local theou.t11_reviewed_ready_journal_sha256='${readyJournalPlaceholder}';
lock table public.comments,public.posts,public.profiles,public.user_roles,public.post_votes,
 public.post_images,public.moderation_actions,public.reports,public.rate_limit_counters in share row exclusive mode;
do $emergency_revoke$
declare
  approved_admin_id uuid:=nullif(current_setting('theou.t11_admin_id',true),'')::uuid;
  approved_role_hash text:=current_setting('theou.t11_approved_role_fingerprint',true);
  observed jsonb; normalized jsonb; baseline jsonb:='${expected}'::jsonb; n integer;
begin
  if approved_admin_id is null or md5(approved_admin_id::text)<>'${actorHash}' then
    raise exception 'T11 emergency revoke requires exact actor B';
  end if;
  if current_setting('theou.t11_reviewed_ready_journal_sha256',true) is distinct from '${readyJournalSha}'
    or approved_role_hash is null or approved_role_hash !~ '^[a-f0-9]{32}$' then
    raise exception 'T11 emergency revoke requires reviewed ready journal and role fingerprint';
  end if;
  select snapshot into observed from (${moderationSnapshotSql}) s;
  observed:=jsonb_set(observed,'{business}',(observed->'business')-'readOnly');
  if (observed->'audits'='[]'::jsonb and (observed#>>'{business,counts,moderation}')::integer=0
    and (select count(*) from public.moderation_actions)=0) is not true then
    raise exception 'T11 emergency revoke cannot follow moderation audit';
  end if;
  if (jsonb_array_length(observed->'roles')=1
    and observed#>>'{roles,0,actorHash}'='${actorHash}'
    and observed#>>'{roles,0,role}'='ADMIN'
    and (observed#>>'{business,counts,roles}')::integer=1
    and observed#>>'{business,roleHash}'=approved_role_hash) is not true then
    raise exception 'T11 emergency revoke role scope or fingerprint drift';
  end if;
  normalized:=jsonb_set(jsonb_set(jsonb_set(observed,'{roles}',baseline->'roles'),
    '{business,counts,roles}',baseline#>'{business,counts,roles}'),
    '{business,roleHash}',baseline#>'{business,roleHash}');
  if normalized is distinct from baseline then
    raise exception 'T11 emergency revoke protected snapshot drift';
  end if;
  delete from public.user_roles where user_id=approved_admin_id and role='ADMIN';
  get diagnostics n=row_count;
  if n<>1 then raise exception 'T11 emergency revoke expected exactly one row'; end if;
  select snapshot into observed from (${moderationSnapshotSql}) s;
  observed:=jsonb_set(observed,'{business}',(observed->'business')-'readOnly');
  if observed is distinct from baseline then
    raise exception 'T11 emergency revoke postcondition failed; rollback';
  end if;
end;
$emergency_revoke$;
commit;
-- Verify with the unchanged before-grant.sql: all booleans true, roles=0 and original fingerprint.
`
}

export function adminGrantVerification(j: ModerationJournal, after: boolean) {
  const expected = JSON.stringify(j.last).replaceAll("'", "''")
  const actorHash = j.inventory.actors.B
  check(/^[a-f0-9]{32}$/.test(actorHash), 'T11_GRANT_ACTOR_HASH')
  return `-- READ ONLY: exact TheOU-dev; run ${j.inventory.runId}; ${after ? 'AFTER' : 'BEFORE'} grant.
-- Chỉ trả booleans/count/fingerprint; không trả snapshot hoặc actor UUID.
begin read only;
with live as (${moderationSnapshotSql}), expected as (select '${expected}'::jsonb as snapshot),
proof as (select live.snapshot as actual, expected.snapshot as baseline from live, expected)
select current_setting('transaction_read_only')='on' as read_only,
  ${
    after
      ? `jsonb_array_length(actual->'roles')=1
    and actual#>>'{roles,0,actorHash}'='${actorHash}'
    and actual#>>'{roles,0,role}'='ADMIN'
    and (actual#>>'{business,counts,roles}')::integer=1`
      : `actual->'roles'='[]'::jsonb and (actual#>>'{business,counts,roles}')::integer=0`
  } as role_scope_matches,
  ${
    after
      ? `jsonb_set(jsonb_set(jsonb_set(actual,'{roles}',baseline->'roles'),
      '{business,counts,roles}',baseline#>'{business,counts,roles}'),
      '{business,roleHash}',baseline#>'{business,roleHash}')=baseline`
      : 'actual=baseline'
  } as protected_snapshot_matches,
  (actual#>>'{business,counts,roles}')::integer as role_count,
  actual#>>'{business,roleHash}' as role_fingerprint
from proof;
commit;
`
}
