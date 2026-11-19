import { check } from './t06-cloud-inventory.ts'
import { identityHash } from './t09-cloud-inventory.ts'
import {
  type ModerationJournal,
  moderationSnapshotSql,
  reasonFor,
  roleReviewSql,
  validateModerationJournal,
} from './t11-cloud-inventory.ts'
import { canonical } from './t11-cloud-recovery.ts'
import { requestHash } from './t11-cloud-runner.ts'
import { assertModerationGrantSnapshot, assertReadyModerationFixture } from './t11-moderation-gate.ts'
import { adminUuidPlaceholder } from './t11-admin-grant-review.ts'

export function assertFinalModerationReview(
  j: ModerationJournal,
  ready: ModerationJournal,
  roleHash: string,
) {
  assertReadyModerationFixture(ready)
  validateModerationJournal(j)
  check(j.status === 'AWAITING_RETENTION_AND_ROLE_REVIEW' && !j.uncertain, 'T11_FINAL_NOT_SETTLED')
  const initial = structuredClone(ready.last)
  initial.roles = j.roles
  initial.business.counts.roles = 1
  initial.business.roleHash = roleHash
  assertModerationGrantSnapshot(ready, initial, roleHash)
  check(j.last.business.roleHash === roleHash, 'T11_FINAL_ROLE_FINGERPRINT')
  const inventory = structuredClone(j.inventory)
  for (const f of inventory.fixtures) {
    f.status = ready.inventory.fixtures.find((r) => r.label === f.label)!.status
  }
  check(canonical(inventory) === canonical(ready.inventory), 'T11_FINAL_INVENTORY_DRIFT')
  const status = (label: string) => j.inventory.fixtures.find((f) => f.label === label)!.status
  check(
    status('owner') === 'DELETED' && status('post-hide') === 'HIDDEN' && status('comments') === 'PUBLISHED' &&
      ['DELETED', 'HIDDEN'].includes(String(status('race'))) && status('draft') === 'DRAFT' &&
      status('owner-ref') === 'VISIBLE' && status('comment-hide') === 'HIDDEN' &&
      status('comment-delete') === 'DELETED',
    'T11_FINAL_FIXTURE_STATES',
  )
  check(
    canonical(j.events.slice(0, ready.events.length)) === canonical(ready.events),
    'T11_FINAL_PREFIX_DRIFT',
  )
  let index = ready.events.length, opaqueIntents = 0
  const take = (stage: string, phase: string, proof?: string) => {
    const e = j.events[index++]
    check(e?.stage === stage && e.phase === phase && (!proof || e.proof === proof), 'T11_FINAL_HISTORY')
    return e.proof
  }
  take('AUTH', 'VERIFIED', requestHash(JSON.stringify(initial)))
  const fixture = (label: string) => j.inventory.fixtures.find((f) => f.label === label)!
  const hide = (label: string) => ({
    targetType: fixture(label).kind,
    targetId: fixture(label).id,
    reason: reasonFor(j.inventory.runId, fixture(label).label),
  })
  const batch = (
    stage: string,
    requests: { actor: string; action: string; payload: unknown }[],
    outcomes: { http: number; code: string | null }[][],
    changed = false,
  ) => {
    const prior = j.events[index - 1].proof
    take('PRE_' + stage, 'VERIFIED', prior)
    for (const r of requests) {
      // Hai payload chỉ lưu hash: spoof adminId của A và random denial key không thể khôi phục từ journal.
      if (r.payload === undefined) {
        take(stage, 'INTENT')
        opaqueIntents++
      } else {take(
          stage,
          'INTENT',
          requestHash(
            JSON.stringify({
              actor: r.actor,
              bodyHash: requestHash(JSON.stringify({ action: r.action, payload: r.payload })),
            }),
          ),
        )}
    }
    check(
      outcomes.some((v) => requestHash(JSON.stringify(v)) === j.events[index]?.proof),
      'T11_FINAL_ACK_OUTCOME',
    )
    take(stage, 'ACK')
    const proof = take(stage, 'VERIFIED')
    check(changed ? proof !== prior : proof === prior, 'T11_FINAL_CHECKPOINT_DELTA')
  }
  const one = (
    stage: string,
    actor: string,
    action: string,
    payload: unknown,
    http = 200,
    code: string | null = null,
    changed = false,
  ) => batch(stage, [{ actor, action, payload }], [[{ http, code }]], changed)
  one('NON_ADMIN_DENIED', 'A', 'adminHideContent', hide('post-hide'), 403, 'FORBIDDEN')
  one('CROSS_OWNER_DENIED', 'B', 'deletePost', { postId: fixture('owner').id }, 404, 'NOT_FOUND')
  for (
    const payload of [
      { ...hide('post-hide'), role: 'ADMIN' },
      { ...hide('post-hide'), reason: '' },
      { ...hide('post-hide'), targetType: 'USER' },
      { ...hide('post-hide'), targetId: 'invalid' },
      undefined,
    ]
  ) one('VALIDATION_DENIED', 'B', 'adminHideContent', payload, 400, 'VALIDATION_ERROR')
  one('DRAFT_DELETE_DENIED', 'A', 'deletePost', { postId: fixture('draft').id }, 409, 'CONFLICT')
  one('DRAFT_HIDE_DENIED', 'B', 'adminHideContent', hide('draft'), 409, 'CONFLICT')
  one('OWNER_DELETE', 'A', 'deletePost', { postId: fixture('owner').id }, 200, null, true)
  one('OWNER_REPLAY', 'A', 'deletePost', { postId: fixture('owner').id })
  const success = { http: 200, code: null }, conflict = { http: 409, code: 'CONFLICT' }
  for (const label of ['post-hide', 'comment-hide']) {
    const stage = fixture(label).kind
    batch(
      stage + '_HIDE_CONCURRENT',
      [0, 1].map(() => ({ actor: 'B', action: 'adminHideContent', payload: hide(label) })),
      [[success, conflict], [conflict, success]],
      true,
    )
    one(stage + '_HIDE_REPLAY', 'B', 'adminHideContent', hide(label), 409, 'CONFLICT')
  }
  one('HIDDEN_OWNER_DELETE_DENIED', 'A', 'deletePost', { postId: fixture('post-hide').id }, 409, 'CONFLICT')
  batch(
    'OWNER_ADMIN_RACE',
    [{ actor: 'A', action: 'deletePost', payload: { postId: fixture('race').id } }, {
      actor: 'B',
      action: 'adminHideContent',
      payload: hide('race'),
    }],
    [status('race') === 'DELETED' ? [success, conflict] : [conflict, success]],
    true,
  )
  one(
    'T08_COMMENT_OWNER_DELETE',
    'B',
    'deleteComment',
    { commentId: fixture('comment-delete').id },
    200,
    null,
    true,
  )
  one('T08_COMMENT_REPLAY', 'B', 'deleteComment', { commentId: fixture('comment-delete').id })
  one('HIDDEN_PARENT_COMMENT_DENIED', 'A', 'createComment', undefined, 404, 'NOT_FOUND')
  one(
    'HIDDEN_PARENT_VOTE_DENIED',
    'A',
    'toggleUpvote',
    { postId: fixture('post-hide').id, desiredState: true },
    404,
    'NOT_FOUND',
  )
  take('MODERATION_COMPLETE', 'VERIFIED', j.events[index - 1].proof)
  check(
    index === j.events.length && j.events.at(-1)!.proof === requestHash(JSON.stringify(j.last)),
    'T11_FINAL_LAST_PROOF',
  )
  check(
    j.audits.every((a) => a.actorHash === j.inventory.actors.B && a.action === 'HIDE'),
    'T11_FINAL_AUDIT_B',
  )
  return { batches: 21, intents: 24, opaqueIntents }
}

export function assembleFinalRevoke(j: ModerationJournal, original: string) {
  validateModerationJournal(j)
  check(
    original === roleReviewSql(j, 'B', true) && j.status === 'AWAITING_RETENTION_AND_ROLE_REVIEW' &&
      !j.uncertain,
    'T11_FINAL_REVOKE_TEMPLATE',
  )
  const expected = structuredClone(j.last)
  delete (expected.business as Partial<typeof expected.business>).readOnly
  expected.roles = []
  expected.business.counts.roles = 0
  expected.business.roleHash = identityHash('[]')
  const postcondition = `do $final_revoke_postcondition$
declare observed jsonb;
begin
 select snapshot into observed from (${moderationSnapshotSql}) s;
 observed:=jsonb_set(observed,'{business}',(observed->'business')-'readOnly');
 if observed is distinct from '${JSON.stringify(expected).replaceAll("'", "''")}'::jsonb then
   raise exception 'T11 final revoke postcondition failed; rollback';
 end if;
end;
$final_revoke_postcondition$;
`
  return original.replace(
    '-- Insert the exact SET LOCAL here after reviewing actor and connected project.',
    () => `set local theou.t11_admin_id='${adminUuidPlaceholder}';`,
  )
    .replace('commit;\n', () => postcondition + 'commit;\n')
}

export function finalRevokeVerification(j: ModerationJournal) {
  validateModerationJournal(j)
  const expected = structuredClone(j.last)
  expected.roles = []
  expected.business.counts.roles = 0
  expected.business.roleHash = identityHash('[]')
  return `-- READ ONLY after FINAL revoke; TheOU-dev; run ${j.inventory.runId}.
begin read only;
with live as (${moderationSnapshotSql})
select snapshot='${JSON.stringify(expected).replaceAll("'", "''")}'::jsonb as final_snapshot_matches,
  current_setting('transaction_read_only')='on' as read_only,
  (snapshot#>>'{business,counts,roles}')::integer as role_count,
  (snapshot#>>'{business,counts,moderation}')::integer as audit_count,
  snapshot#>>'{business,roleHash}' as role_fingerprint
from live;
commit;
`
}
