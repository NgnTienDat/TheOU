import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readdir, readFile, rename, unlink } from 'node:fs/promises'
import { check } from './t06-cloud-inventory.ts'
import { literal } from './t08-cloud-inventory.ts'
import { t04ProjectRef, uuidPattern } from './t04-cloud-recovery.ts'

export const approvedVotePost = '2cd34597-dd32-40b6-850e-0d62bfe52a2a'
export const identityHash = (id: string) => createHash('md5').update(id).digest('hex')
export function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
export function keys(value: unknown, names: string[]): value is Record<string, unknown> {
  return object(value) && Object.keys(value).sort().join(',') === [...names].sort().join(',')
}
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{32}$/.test(v)
const uuid = (v: unknown): v is string => typeof v === 'string' && uuidPattern.test(v)
const count = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0
const tableNames = [
  'users',
  'profiles',
  'roles',
  'posts',
  'comments',
  'votes',
  'images',
  'reports',
  'moderation',
  'limits',
] as const
export interface VoteSnapshot {
  readOnly: 'on'
  counts: Record<typeof tableNames[number], number>
  authHash: string
  profileHash: string
  roleHash: string
  otherHash: string
  owners: { hash: string; status: string }[]
  posts: {
    id: string
    authorHash: string
    status: string
    upvoteCount: number
    voteCount: number
    commentCount: number
    visibleCount: number
    protectedHash: string
    rowHash: string
  }[]
  comments: { id: string; postId: string; status: string; rowHash: string }[]
  votes: { postId: string; userHash: string; rowHash: string }[]
}
// Một SELECT snapshot: không trả body/email/UUID Auth hoặc raw profile/comment records.
export const voteSnapshotSql = `select jsonb_build_object(
 'readOnly',current_setting('transaction_read_only'),
 'counts',jsonb_build_object('users',(select count(*) from auth.users),
  'profiles',(select count(*) from public.profiles),'roles',(select count(*) from public.user_roles),
  'posts',(select count(*) from public.posts),'comments',(select count(*) from public.comments),
  'votes',(select count(*) from public.post_votes),'images',(select count(*) from public.post_images),
  'reports',(select count(*) from public.reports),'moderation',(select count(*) from public.moderation_actions),
  'limits',(select count(*) from public.rate_limit_counters)),
 'authHash',(select md5(coalesce(jsonb_agg(id order by id)::text,'[]')) from auth.users),
 'profileHash',(select md5(coalesce(jsonb_agg(to_jsonb(p) order by id)::text,'[]')) from public.profiles p),
 'roleHash',(select md5(coalesce(jsonb_agg(to_jsonb(r) order by user_id,role)::text,'[]')) from public.user_roles r),
 'otherHash',md5(jsonb_build_array(
  (select coalesce(jsonb_agg(to_jsonb(x) order by id),'[]') from public.post_images x),
  (select coalesce(jsonb_agg(to_jsonb(x) order by id),'[]') from public.reports x),
  (select coalesce(jsonb_agg(to_jsonb(x) order by id),'[]') from public.moderation_actions x),
  (select coalesce(jsonb_agg(to_jsonb(x) order by actor_id,action,window_start),'[]') from public.rate_limit_counters x))::text),
 'owners',(select coalesce(jsonb_agg(jsonb_build_object('hash',md5(id::text),'status',status) order by id),'[]') from public.profiles),
 'posts',(select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'authorHash',md5(p.author_id::text),
  'status',p.status,'upvoteCount',p.upvote_count,'voteCount',(select count(*) from public.post_votes v where v.post_id=p.id),
  'commentCount',p.comment_count,'visibleCount',(select count(*) from public.comments c where c.post_id=p.id and c.status='VISIBLE'),
  'protectedHash',md5((to_jsonb(p)-'upvote_count'-'updated_at')::text),'rowHash',md5(to_jsonb(p)::text)) order by p.id),'[]') from public.posts p),
 'comments',(select coalesce(jsonb_agg(jsonb_build_object('id',id,'postId',post_id,'status',status,'rowHash',md5(to_jsonb(c)::text)) order by id),'[]') from public.comments c),
 'votes',(select coalesce(jsonb_agg(jsonb_build_object('postId',post_id,'userHash',md5(user_id::text),'rowHash',md5(to_jsonb(v)::text)) order by post_id,user_id),'[]') from public.post_votes v)
) as snapshot`

export function parseVoteSnapshot(value: unknown): VoteSnapshot {
  check(
    keys(value, [
      'readOnly',
      'counts',
      'authHash',
      'profileHash',
      'roleHash',
      'otherHash',
      'owners',
      'posts',
      'comments',
      'votes',
    ]) && value.readOnly === 'on' &&
      keys(value.counts, [...tableNames]) && Object.values(value.counts).every(count) &&
      [value.authHash, value.profileHash, value.roleHash, value.otherHash].every(hash) &&
      Array.isArray(value.owners) && Array.isArray(value.posts) && Array.isArray(value.comments) &&
      Array.isArray(value.votes),
    'T09_SNAPSHOT_SCHEMA',
  )
  check(
    value.owners.every((p) =>
      keys(p, ['hash', 'status']) && hash(p.hash) && ['ACTIVE', 'BANNED'].includes(String(p.status))
    ) &&
      value.posts.every((p) =>
        keys(p, [
          'id',
          'authorHash',
          'status',
          'upvoteCount',
          'voteCount',
          'commentCount',
          'visibleCount',
          'protectedHash',
          'rowHash',
        ]) &&
        uuid(p.id) && hash(p.authorHash) &&
        ['PUBLISHED', 'DRAFT', 'HIDDEN', 'DELETED'].includes(String(p.status)) &&
        [p.upvoteCount, p.voteCount, p.commentCount, p.visibleCount].every(count) && hash(p.protectedHash) &&
        hash(p.rowHash)
      ) &&
      value.comments.every((c) =>
        keys(c, ['id', 'postId', 'status', 'rowHash']) && uuid(c.id) && uuid(c.postId) &&
        ['VISIBLE', 'HIDDEN', 'DELETED'].includes(String(c.status)) && hash(c.rowHash)
      ) &&
      value.votes.every((v) =>
        keys(v, ['postId', 'userHash', 'rowHash']) && uuid(v.postId) && hash(v.userHash) && hash(v.rowHash)
      ),
    'T09_SNAPSHOT_ROWS',
  )
  const snapshot = value as unknown as VoteSnapshot
  check(
    snapshot.posts.length === snapshot.counts.posts &&
      snapshot.comments.length === snapshot.counts.comments &&
      snapshot.votes.length === snapshot.counts.votes &&
      snapshot.owners.length === snapshot.counts.profiles &&
      new Set(snapshot.posts.map((p) => p.id)).size === snapshot.posts.length &&
      new Set(snapshot.comments.map((c) => c.id)).size === snapshot.comments.length &&
      new Set(snapshot.votes.map((v) => `${v.postId}:${v.userHash}`)).size === snapshot.votes.length &&
      new Set(snapshot.owners.map((p) => p.hash)).size === snapshot.owners.length,
    'T09_SNAPSHOT_COUNTS_OR_DUPLICATES',
  )
  check(
    snapshot.posts.every((p) =>
      p.upvoteCount === p.voteCount &&
      p.voteCount === snapshot.votes.filter((v) => v.postId === p.id).length &&
      p.commentCount === p.visibleCount &&
      p.visibleCount === snapshot.comments.filter((c) => c.postId === p.id && c.status === 'VISIBLE').length
    ) &&
      [...snapshot.comments, ...snapshot.votes].every((row) =>
        snapshot.posts.some((p) => p.id === row.postId)
      ),
    'T09_DB_COUNT_INVARIANT',
  )
  return snapshot
}
export function assertVoteBaseline(value: VoteSnapshot) {
  parseVoteSnapshot(value)
  check(
    value.counts.users === 2 && value.counts.profiles === 2 && value.counts.roles === 0 &&
      value.counts.posts === 2 && value.counts.comments === 3 && value.counts.votes === 0 &&
      value.posts.some((p) => p.id === approvedVotePost) &&
      value.posts.every((p) => p.status === 'PUBLISHED' && p.upvoteCount === 0) &&
      value.posts.map((p) => p.commentCount).sort().join(',') === '0,2' &&
      value.comments.filter((c) => c.status === 'VISIBLE').length === 2 &&
      value.comments.filter((c) => c.status === 'DELETED').length === 1 &&
      value.owners.every((p) => p.status === 'ACTIVE'),
    'T09_BASELINE_MISMATCH',
  )
}
function protectedView(value: VoteSnapshot) {
  return {
    ...value,
    counts: { ...value.counts, votes: 0 },
    votes: value.votes.filter((v) => v.postId !== approvedVotePost),
    posts: value.posts.map((p) =>
      p.id !== approvedVotePost ? p : { ...p, upvoteCount: 0, voteCount: 0, rowHash: '' }
    ),
  }
}
export function assertVoteProtected(baseline: VoteSnapshot, current: VoteSnapshot, actors: string[]) {
  parseVoteSnapshot(current)
  check(
    JSON.stringify(protectedView(baseline)) === JSON.stringify(protectedView(current)),
    'T09_PROTECTED_DATA_DRIFT',
  )
  check(
    current.votes.every((v) => v.postId === approvedVotePost && actors.includes(v.userHash)),
    'T09_VOTES_OUTSIDE_EXACT_SCOPE',
  )
}
export interface VoteInventory {
  version: 1
  projectRef: string
  runId: string
  postId: string
  mode: '--smoke' | '--write'
  baseline: VoteSnapshot
  actors: { A: string; B: string }
}
export const stages = [
  'C1',
  'C2',
  'C3',
  'C4',
  'C5',
  'C6_PREPARE',
  'C6_LOST',
  'C6_RETRY',
  'C7',
  'C8',
  'FINISH',
] as const
export interface VoteEvent {
  stage: typeof stages[number]
  phase: 'INTENT' | 'ACK' | 'DROPPED' | 'VERIFIED' | 'FAILED'
  requests?: { seq: number; actor: 'A' | 'B'; desiredState: boolean }[]
  seq?: number
  http?: number
  result?: { hasUpvoted: boolean; upvoteCount: number }
  snapshot?: VoteSnapshot
}
export interface VoteJournal {
  inventory: VoteInventory
  status: 'PREPARED' | 'RUNNING' | 'FAILED' | 'AWAITING_CLEANUP' | 'COMPLETED'
  uncertain: boolean
  events: VoteEvent[]
}
export function validateVoteInventory(record: VoteInventory) {
  check(
    keys(record, ['version', 'projectRef', 'runId', 'postId', 'mode', 'baseline', 'actors']) &&
      record.version === 1 && record.projectRef === t04ProjectRef &&
      /^[a-f0-9]{32}$/.test(record.runId) && record.postId === approvedVotePost &&
      ['--smoke', '--write'].includes(record.mode) &&
      keys(record.actors, ['A', 'B']) && hash(record.actors.A) && hash(record.actors.B) &&
      record.actors.A !== record.actors.B,
    'T09_INVENTORY_SCOPE',
  )
  assertVoteBaseline(record.baseline)
  check(
    Object.values(record.actors).every((h) => record.baseline.owners.some((p) => p.hash === h)),
    'T09_INVENTORY_ACTORS',
  )
}
export function validateVoteJournal(journal: VoteJournal) {
  check(
    keys(journal, ['inventory', 'status', 'uncertain', 'events']) &&
      ['PREPARED', 'RUNNING', 'FAILED', 'AWAITING_CLEANUP', 'COMPLETED'].includes(journal.status) &&
      typeof journal.uncertain === 'boolean' && Array.isArray(journal.events),
    'T09_JOURNAL_SHAPE',
  )
  validateVoteInventory(journal.inventory)
  const issued = new Map<number, VoteEvent['stage']>(), acked = new Set<number>()
  for (const e of journal.events) {
    check(
      object(e) && Object.keys(e).every((k) =>
        ['stage', 'phase', 'requests', 'seq', 'http', 'result', 'snapshot'].includes(k)
      ) && stages.includes(e.stage) && ['INTENT', 'ACK', 'DROPPED', 'VERIFIED', 'FAILED'].includes(e.phase),
      'T09_JOURNAL_EVENT',
    )
    check(
      journal.inventory.mode === '--write' || !['INTENT', 'ACK', 'DROPPED'].includes(e.phase),
      'T09_SMOKE_JOURNAL_NO_MUTATION',
    )
    check(e.phase !== 'INTENT' || !!e.requests, 'T09_JOURNAL_INTENT')
    if (e.requests) {
      check(
        e.phase === 'INTENT' && e.requests.length >= 1 && e.requests.length <= 3 && e.requests.every((r) =>
          keys(r, ['seq', 'actor', 'desiredState']) && count(r.seq) && r.seq > 0 &&
          ['A', 'B'].includes(r.actor) && typeof r.desiredState === 'boolean'
        ),
        'T09_JOURNAL_INTENT',
      )
      for (const request of e.requests) {
        check(!issued.has(request.seq) && request.seq === issued.size + 1, 'T09_JOURNAL_REQUEST_SEQUENCE')
        issued.set(request.seq, e.stage)
      }
    }
    check(!['ACK', 'DROPPED'].includes(e.phase) || e.seq !== undefined, 'T09_JOURNAL_ACK')
    if (e.seq !== undefined) {
      check(
        count(e.seq) && e.seq > 0 && ['ACK', 'DROPPED'].includes(e.phase) && e.http === 200,
        'T09_JOURNAL_ACK',
      )
      check(
        issued.get(e.seq) === e.stage && !acked.has(e.seq) &&
          (e.phase === 'ACK' ? !!e.result : e.stage === 'C6_LOST' && !e.result),
        'T09_JOURNAL_ACK_MATCHES_INTENT',
      )
      acked.add(e.seq)
    }
    if (e.result) {
      check(
        keys(e.result, ['hasUpvoted', 'upvoteCount']) && typeof e.result.hasUpvoted === 'boolean' &&
          count(e.result.upvoteCount) && e.result.upvoteCount <= 2,
        'T09_JOURNAL_RESULT',
      )
    }
    if (e.snapshot) {
      check(
        e.phase === 'VERIFIED' && [...issued].filter(([, stage]) =>
          stage === e.stage
        ).every(([seq]) =>
          acked.has(seq)
        ),
        'T09_JOURNAL_VERIFICATION_ORDER',
      )
      parseVoteSnapshot(e.snapshot)
      assertVoteProtected(journal.inventory.baseline, e.snapshot, Object.values(journal.inventory.actors))
    }
  }
  check(journal.uncertain || issued.size === acked.size, 'T09_JOURNAL_UNRESOLVED_INTENT')
  const verified = journal.events.findLast((e) => e.phase === 'VERIFIED')
  if (['COMPLETED', 'AWAITING_CLEANUP'].includes(journal.status)) {
    check(!journal.uncertain && verified?.stage === 'FINISH' && !!verified.snapshot, 'T09_COMPLETION_PROOF')
    check(
      journal.inventory.mode === '--smoke'
        ? journal.status === 'COMPLETED' &&
          JSON.stringify(verified.snapshot) === JSON.stringify(journal.inventory.baseline)
        : journal.status === 'AWAITING_CLEANUP',
      'T09_COMPLETION_MODE',
    )
  }
}

export function voteVerificationSql(record: VoteInventory) {
  validateVoteInventory(record)
  return `-- READ ONLY: TheOU-dev ${t04ProjectRef}; run ${record.runId}. Identity chỉ hash, không raw UUID Auth.
${voteSnapshotSql};
select post_id,md5(user_id::text) as user_hash,count(*) as tuple_rows from public.post_votes
where post_id=${literal(record.postId)}::uuid group by post_id,user_id order by user_hash;
select not exists(select 1 from public.post_votes where post_id<>${literal(record.postId)}::uuid
 or md5(user_id::text) not in (${literal(record.actors.A)},${literal(record.actors.B)})) as exact_scope;
`
}
export function voteCleanupSql(journal: VoteJournal) {
  validateVoteJournal(journal)
  const record = journal.inventory
  const last = journal.events.findLast((e) => e.phase === 'VERIFIED' && e.snapshot)?.snapshot
  if (!last || journal.uncertain || journal.events.at(-1)?.phase === 'INTENT') {
    return `-- REVIEW ONLY; run ${record.runId}. Uncertain/unverified: không có DELETE được phép.
do $$begin raise exception 'T09 unresolved intent; verify requests and exact scope before cleanup review';end;$$;\n`
  }
  const expected = structuredClone(last) as Omit<VoteSnapshot, 'readOnly'> & { readOnly?: string }
  delete expected.readOnly
  const restored = structuredClone(record.baseline) as Omit<VoteSnapshot, 'readOnly'> & { readOnly?: string }
  delete restored.readOnly
  const baseline = {
    ...restored,
    posts: restored.posts.map((p) => {
      const copy: Partial<typeof p> = { ...p }
      if (p.id === record.postId) delete copy.rowHash
      return copy
    }),
  }
  return `-- REVIEW ONLY: ${t04ProjectRef}; run ${record.runId}. NEVER executed by runner.
-- Reviewer supplies exact Auth UUIDs locally using SET LOCAL theou.t09_user_a / theou.t09_user_b inside this transaction.
-- Không tìm/xóa theo hash/domain. Thiếu UUID hoặc lệch ownership thì rollback.
begin;
set local lock_timeout='3s';
set local statement_timeout='10s';
lock table public.post_votes,public.comments,public.posts,public.profiles,public.user_roles,
 public.post_images,public.reports,public.moderation_actions,public.rate_limit_counters in share row exclusive mode;
do $cleanup$
declare a_id uuid:=nullif(current_setting('theou.t09_user_a',true),'')::uuid;
 b_id uuid:=nullif(current_setting('theou.t09_user_b',true),'')::uuid;
 observed jsonb; n integer;
begin
 if a_id is null or b_id is null or a_id=b_id or md5(a_id::text)<>${
    literal(record.actors.A)
  } or md5(b_id::text)<>${literal(record.actors.B)} then
  raise exception 'T09 exact caller UUID ownership mismatch'; end if;
 select snapshot into observed from (${voteSnapshotSql}) s;
 if observed-'readOnly'<>${
    literal(JSON.stringify(expected))
  }::jsonb then raise exception 'T09 snapshot drift; no cleanup';end if;
 delete from public.post_votes where post_id=${literal(record.postId)}::uuid and user_id in (a_id,b_id);
 get diagnostics n=row_count;
 if n<>${last.votes.length} then raise exception 'T09 tuple count mismatch';end if;
 select snapshot into observed from (${voteSnapshotSql}) s;
 observed:=jsonb_set(observed-'readOnly','{posts}',(select jsonb_agg(case when p->>'id'=${
    literal(record.postId)
  } then p-'rowHash' else p end order by p->>'id') from jsonb_array_elements(observed->'posts') p));
 if observed<>${
    literal(JSON.stringify(baseline))
  }::jsonb then raise exception 'T09 baseline/count mismatch; rollback, never reset counts';end if;
end;$cleanup$;
commit;
-- Verify baseline/counts/protected data again. Keep journals; cleanup approval is separate.
`
}

export interface VoteStore {
  acquire(runId: string): Promise<void>
  begin(record: VoteInventory): Promise<void>
  save(journal: VoteJournal): Promise<void>
  release(): Promise<void>
}
export function fileVoteStore(directory = new URL('../.temp/t09-votes/', import.meta.url)): VoteStore {
  let runId = '', owned = false, prior = ''
  const lock = new URL(`${approvedVotePost}.lock`, directory)
  async function write(name: string, data: string, exclusive = false) {
    const target = new URL(name, directory), temp = new URL(`${name}.${randomUUID()}.tmp`, directory)
    const handle = await open(exclusive ? target : temp, 'wx', 0o600)
    try {
      await handle.writeFile(data, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    if (!exclusive) await rename(temp, target)
  }
  return {
    async acquire(id) {
      check(/^[a-f0-9]{32}$/.test(id) && !owned, 'T09_STORE_RUN_ID')
      await mkdir(directory, { recursive: true })
      try {
        const handle = await open(lock, 'wx', 0o600)
        owned = true
        try {
          await handle.writeFile(
            JSON.stringify({ projectRef: t04ProjectRef, runId: id, postId: approvedVotePost }),
          )
          await handle.sync()
        } finally {
          await handle.close()
        }
      } catch {
        check(false, 'T09_SCOPE_BUSY_OR_LOCK_IO')
      }
      runId = id
      const names = await readdir(directory)
      for (const name of names) {
        const priorId = /^([a-f0-9]{32})\./.exec(name)?.[1]
        check(!priorId || names.includes(`${priorId}.journal.json`), 'T09_ORPHAN_ARTIFACT_REVIEW_REQUIRED')
      }
      for (const name of names) {
        if (!name.endsWith('.journal.json')) continue
        let journal: VoteJournal
        try {
          journal = JSON.parse(await readFile(new URL(name, directory), 'utf8'))
          validateVoteJournal(journal)
          check(name === `${journal.inventory.runId}.journal.json`, 'T09_JOURNAL_FILENAME')
        } catch {
          check(false, 'T09_EXISTING_JOURNAL_INVALID_REVIEW_REQUIRED')
        }
        check(
          journal.inventory.mode === '--smoke' && journal.status === 'COMPLETED' && !journal.uncertain,
          'T09_UNRESOLVED_JOURNAL_NO_RERUN',
        )
      }
    },
    async begin(record) {
      validateVoteInventory(record)
      check(owned && record.runId === runId, 'T09_STORE_OWNERSHIP')
      await write(`${runId}.json`, JSON.stringify(record, null, 2) + '\n', true)
      await write(`${runId}.verify.sql`, voteVerificationSql(record), true)
      const journal: VoteJournal = { inventory: record, status: 'PREPARED', uncertain: false, events: [] }
      await write(`${runId}.cleanup.sql`, voteCleanupSql(journal), true)
      prior = JSON.stringify(journal)
      await write(`${runId}.journal.json`, prior + '\n', true)
    },
    async save(journal) {
      validateVoteJournal(journal)
      check(owned && runId === journal.inventory.runId && prior !== '', 'T09_STORE_OWNERSHIP')
      const disk = (await readFile(new URL(`${runId}.journal.json`, directory), 'utf8')).trim()
      check(disk === prior, 'T09_JOURNAL_EXTERNAL_CHANGE')
      const old: VoteJournal = JSON.parse(prior)
      check(
        JSON.stringify(old.inventory) === JSON.stringify(journal.inventory) &&
          journal.events.length >= old.events.length &&
          JSON.stringify(journal.events.slice(0, old.events.length)) === JSON.stringify(old.events),
        'T09_JOURNAL_HISTORY_IMMUTABLE',
      )
      // Journal trước artifacts: I/O lỗi vẫn giữ INTENT/uncertain và khóa rerun.
      const next = JSON.stringify(journal)
      await write(`${runId}.journal.json`, next + '\n')
      prior = next
      await write(`${runId}.cleanup.sql`, voteCleanupSql(journal))
    },
    async release() {
      if (owned) {
        await unlink(lock)
        owned = false
      }
    },
  }
}
