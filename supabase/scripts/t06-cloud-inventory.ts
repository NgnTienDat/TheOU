import { randomUUID } from 'node:crypto'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { t04ProjectRef, uuidPattern } from './t04-cloud-recovery.ts'
import { ManualAuthError } from './auth-helpers.ts'

export interface PostFixture {
  label: string
  key: string
  body: string
  postIds: string[]
  outcome: 'pending' | 'rejected' | 'ack'
}
export interface PostInventory {
  projectRef: string
  runId: string
  marker: string
  fixtures: PostFixture[]
}
export interface InventoryStore {
  save(record: PostInventory): Promise<void>
}
export function check(condition: unknown, stage: string): asserts condition {
  if (!condition) throw new ManualAuthError(`FAIL: ${stage}. Không in response, identity hoặc lỗi SDK thô.`)
}
export function validateInventory(record: PostInventory) {
  check(
    record && Object.keys(record).sort().join(',') === 'fixtures,marker,projectRef,runId' &&
      record.projectRef === t04ProjectRef && /^[a-f0-9]{32}$/.test(record.runId) &&
      record.marker === `T06-CLOUD-TEST-${record.runId}` && Array.isArray(record.fixtures),
    'INVENTORY_SCOPE',
  )
  const keys = new Set<string>(), ids = new Set<string>()
  for (const fixture of record.fixtures) {
    check(
      Object.keys(fixture).sort().join(',') === 'body,key,label,outcome,postIds' &&
        /^[a-z0-9-]{1,32}$/.test(fixture.label) && uuidPattern.test(fixture.key) && !keys.has(fixture.key) &&
        typeof fixture.body === 'string' && fixture.body.length <= 1200 &&
        (fixture.body === '' || fixture.body.startsWith(record.marker + ' ')) &&
        ['pending', 'rejected', 'ack'].includes(fixture.outcome) && Array.isArray(fixture.postIds),
      'INVENTORY_FIXTURE',
    )
    keys.add(fixture.key)
    for (const id of fixture.postIds) {
      check(typeof id === 'string' && uuidPattern.test(id) && !ids.has(id), 'INVENTORY_POST_ID')
      ids.add(id)
    }
    check(fixture.outcome !== 'ack' || fixture.postIds.length > 0, 'INVENTORY_ACK')
  }
}
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`

export function verificationSql(record: PostInventory) {
  validateInventory(record)
  if (!record.fixtures.length) return '-- No post fixture requests.\n'
  const values = record.fixtures.map((f) =>
    `(${literal(f.label)},${literal(f.key)}::uuid,${literal(f.body)},${literal(f.outcome)})`
  ).join(',\n  ')
  // Chỉ số đếm/UUID bài; không cần email, author UUID, nickname hoặc credentials.
  return `-- READ ONLY: review target TheOU-dev (${t04ProjectRef}); run ${record.runId}.
with expected(label,key,body,outcome) as (values
  ${values}
)
select e.label,e.outcome,count(p.id)::integer as row_count,
  coalesce(array_agg(p.id) filter(where p.id is not null),'{}'::uuid[]) as post_ids,
  coalesce(bool_and(p.body=e.body) filter(where p.id is not null),true) as body_matches,
  count(*) filter(where p.display_mode='ANONYMOUS' and (p.nickname_snapshot is not null or p.contact_url is not null))::integer as anonymous_violations,
  count(*) filter(where p.status='DRAFT')::integer as drafts,
  count(*) filter(where p.status='PUBLISHED')::integer as published
from expected e left join public.posts p on p.idempotency_key=e.key
group by e.label,e.outcome order by e.label;
`
}
export function cleanupSql(record: PostInventory) {
  validateInventory(record)
  const known = record.fixtures.flatMap((f) => f.postIds.map((id) => ({ id, key: f.key, body: f.body })))
  const pending = record.fixtures.filter((f) => f.outcome === 'pending')
  const header = `-- REVIEW ONLY; runner NEVER executes this file. Target TheOU-dev (${t04ProjectRef}).
-- Run ${record.runId}. Known posts=${known.length}; unresolved requests=${pending.length}.
-- Resolve pending UUIDs with verification SQL first; unknown UUIDs are NEVER deleted below.
-- Review every exact UUID/key/body; do not delete Auth users, profiles or dependencies.
`
  if (!known.length) return header + '-- No known post UUIDs to delete.\n'
  const expected = JSON.stringify(known)
  return header + `begin;
set local lock_timeout='3s';
set local statement_timeout='10s';
do $cleanup$
declare f record; ids uuid[] := '{}'::uuid[];
begin
  for f in select * from jsonb_to_recordset(${literal(expected)}::jsonb) as x(id uuid,key uuid,body text) loop
    perform 1 from public.posts where id=f.id for update;
    if found then
      if not exists(select 1 from public.posts p where p.id=f.id and p.idempotency_key=f.key
        and p.body=f.body and p.status in ('DRAFT','PUBLISHED')) then
        raise exception 'Fixture ownership/content/status mismatch; no cleanup';
      end if;
      if exists(select 1 from public.comments where post_id=f.id)
        or exists(select 1 from public.post_votes where post_id=f.id)
        or exists(select 1 from public.post_images where post_id=f.id)
        or exists(select 1 from public.reports where target_type='POST' and target_id=f.id)
        or exists(select 1 from public.moderation_actions where target_type='POST' and target_id=f.id) then
        raise exception 'Fixture has dependent data; review manually, no cleanup';
      end if;
      ids := array_append(ids,f.id);
    end if;
  end loop;
  delete from public.posts where id=any(ids);
end;
$cleanup$;
commit;
-- Run verification SQL again: every row_count must be 0 before cleanup is accepted.
`
}
export function filePostInventory(
  directory = new URL('../.temp/t06-cloud/', import.meta.url),
): InventoryStore {
  return {
    async save(record) {
      validateInventory(record)
      await mkdir(directory, { recursive: true })
      for (
        const [suffix, text] of [['json', JSON.stringify(record, null, 2) + '\n'], [
          'verify.sql',
          verificationSql(record),
        ], ['cleanup.sql', cleanupSql(record)]]
      ) {
        const destination = new URL(`${record.runId}.${suffix}`, directory)
        const temporary = new URL(`${record.runId}.${randomUUID()}.tmp`, directory)
        await writeFile(temporary, text, { mode: 0o600, flag: 'wx' })
        await rename(temporary, destination)
      }
    },
  }
}
