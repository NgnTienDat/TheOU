import { randomUUID } from 'node:crypto'
import { mkdir, open, readdir, readFile, rename, unlink } from 'node:fs/promises'
import { t04ProjectRef, uuidPattern } from './t04-cloud-recovery.ts'
import { check } from './t06-cloud-inventory.ts'
import { literal } from './t08-cloud-inventory.ts'
import {
  assertVoteBaseline,
  identityHash as md5String,
  keys,
  parseVoteSnapshot,
  type VoteSnapshot,
  voteSnapshotSql,
} from './t09-cloud-inventory.ts'
import { mediaAssets, sha256 } from './t10-media-assets.ts'

export interface MediaImage {
  id: string
  postId: string
  path: string
  mime: string
  size: number
  position: number
  status: 'PENDING' | 'READY'
}
export interface MediaSnapshot {
  business: VoteSnapshot
  security: {
    private: boolean
    size: number
    mimes: string[]
    rls: boolean
    policies: number
    migration: boolean
  }
  auxHash: string
  images: MediaImage[]
  objects: { path: string; size: number; mime: string; rowHash: string }[]
  postProofs: { id: string; keyHash: string; bodyHash: string; anonymous: boolean }[]
}
// Chỉ SELECT; Storage metadata không được dùng thay kiểm tra info/download thực tế.
export const mediaSnapshotSql = `with business as (${voteSnapshotSql})
select jsonb_build_object('business',(select snapshot from business),
 'security',jsonb_build_object(
  'private',coalesce((select not public from storage.buckets where id='post-media'),false),
  'size',(select file_size_limit from storage.buckets where id='post-media'),
  'mimes',(select to_jsonb(allowed_mime_types) from storage.buckets where id='post-media'),
  'rls',(select relrowsecurity from pg_class where oid='storage.objects'::regclass),
  'policies',(select count(*) from pg_policies where schemaname='storage' and tablename='objects'),
  'migration',exists(select 1 from supabase_migrations.schema_migrations where version='20261117155535')),
 'auxHash',md5(jsonb_build_array(
  (select coalesce(jsonb_agg(to_jsonb(x) order by id),'[]') from public.reports x),
  (select coalesce(jsonb_agg(to_jsonb(x) order by id),'[]') from public.moderation_actions x),
  (select coalesce(jsonb_agg(to_jsonb(x) order by actor_id,action,window_start),'[]') from public.rate_limit_counters x))::text),
 'images',(select coalesce(jsonb_agg(jsonb_build_object('id',id,'postId',post_id,'path',storage_path,
  'mime',mime_type,'size',size_bytes,'position',position,'status',status) order by position,id),'[]') from public.post_images),
 'objects',(select coalesce(jsonb_agg(jsonb_build_object('path',name,'size',(metadata->>'size')::bigint,
  'mime',metadata->>'mimetype','rowHash',md5(to_jsonb(o)::text)) order by name),'[]') from storage.objects o where bucket_id='post-media'),
 'postProofs',(select coalesce(jsonb_agg(jsonb_build_object('id',id,'keyHash',md5(idempotency_key::text),
  'bodyHash',md5(body),'anonymous',display_mode='ANONYMOUS' and tag='CONFESSION' and contact_url is null and nickname_snapshot is null) order by id),'[]') from public.posts)
) as snapshot`
const md5 = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{32}$/.test(v)
const uuid = (v: unknown): v is string => typeof v === 'string' && uuidPattern.test(v)
export function parseMediaSnapshot(value: unknown): MediaSnapshot {
  check(
    keys(value, ['business', 'security', 'auxHash', 'images', 'objects', 'postProofs']),
    'T10_SNAPSHOT_SHAPE',
  )
  const business = parseVoteSnapshot(value.business)
  check(
    keys(value.security, ['private', 'size', 'mimes', 'rls', 'policies', 'migration']) &&
      value.security.private === true && value.security.size === 2097152 && value.security.rls === true &&
      value.security.policies === 0 && value.security.migration === true &&
      Array.isArray(value.security.mimes) &&
      [...value.security.mimes].sort().join() === 'image/jpeg,image/png,image/webp',
    'T10_STORAGE_SECURITY_OR_MIGRATION',
  )
  check(
    md5(value.auxHash) && Array.isArray(value.images) && Array.isArray(value.objects) &&
      Array.isArray(value.postProofs),
    'T10_SNAPSHOT_ARRAYS',
  )
  check(
    value.images.every((i) =>
      keys(i, ['id', 'postId', 'path', 'mime', 'size', 'position', 'status']) &&
      uuid(i.id) && uuid(i.postId) && [1, 2].includes(Number(i.position)) &&
      ['image/jpeg', 'image/png', 'image/webp'].includes(String(i.mime)) &&
      ['PENDING', 'READY'].includes(String(i.status)) &&
      Number.isSafeInteger(i.size) && Number(i.size) > 0 && Number(i.size) <= 2097152 &&
      i.path === `posts/${i.postId}/${i.id}.${
          i.mime === 'image/png'
            ? 'png'
            : i.mime === 'image/webp'
            ? 'webp'
            : i.mime === 'image/jpeg'
            ? 'jpg'
            : 'INVALID'
        }`
    ),
    'T10_IMAGE_ROWS',
  )
  check(
    value.objects.every((o) =>
      keys(o, ['path', 'size', 'mime', 'rowHash']) && typeof o.path === 'string' &&
      Number.isSafeInteger(o.size) && Number(o.size) > 0 && typeof o.mime === 'string' && md5(o.rowHash)
    ),
    'T10_OBJECT_ROWS',
  )
  check(
    value.postProofs.every((p) =>
      keys(p, ['id', 'keyHash', 'bodyHash', 'anonymous']) && uuid(p.id) && md5(p.keyHash) &&
      md5(p.bodyHash) && typeof p.anonymous === 'boolean'
    ) &&
      value.postProofs.length === business.posts.length &&
      new Set(value.postProofs.map((p) => p.id)).size === business.posts.length &&
      value.postProofs.every((p) => business.posts.some((post) => post.id === p.id)) &&
      value.images.length === business.counts.images &&
      new Set(value.images.map((i) => i.id)).size === value.images.length &&
      new Set(value.objects.map((o) => o.path)).size === value.objects.length,
    'T10_SNAPSHOT_COUNTS',
  )
  return value as unknown as MediaSnapshot
}
export function mediaBaseline(snapshot: MediaSnapshot) {
  parseMediaSnapshot(snapshot)
  assertVoteBaseline(snapshot.business)
  check(
    snapshot.images.length === 0 && snapshot.objects.length === 0,
    'T10_BASELINE_IMAGES_OR_ORPHANS_REVIEW',
  )
}
export interface MediaInventory {
  version: 1
  projectRef: string
  runId: string
  mode: '--smoke' | '--draft-write'
  actors: { A: string; B: string }
  baseline: MediaSnapshot
  key: string
  body: string
  postId: string | null
  postStatus: 'DRAFT' | 'PUBLISHED' | null
  images: MediaImage[]
  objectPaths: string[]
  lastReservationAt: string | null
}
export type MediaState =
  | 'RUNNING'
  | 'UNCERTAIN'
  | 'COMPLETED'
  | 'AWAITING_PUBLISH_REVIEW'
  | 'AWAITING_RETENTION_OR_CLEANUP_REVIEW'
const stages = [
  'BASELINE',
  'CREATE',
  'CREATE_RETRY',
  'RESERVE_1',
  'RESERVE_RETRY_1',
  'RESERVE_2',
  'RESERVE_RETRY_2',
  'UPLOAD_1',
  'UPLOAD_2',
  'FINALIZE_1',
  'FINALIZE_RETRY_1',
  'FINALIZE_2',
  'FINALIZE_RETRY_2',
  'NEGATIVE',
  'PUBLISH',
  'READ',
  'FINISH',
] as const
export type MediaStage = typeof stages[number]
export interface MediaJournal {
  inventory: MediaInventory
  status: MediaState
  uncertain: boolean
  events: {
    stage: MediaStage
    phase: 'INTENT' | 'ACK' | 'VERIFIED' | 'UNCERTAIN'
    at: string
    proof: string
  }[]
}
export function validateMediaInventory(i: MediaInventory) {
  check(
    keys(i, [
      'version',
      'projectRef',
      'runId',
      'mode',
      'actors',
      'baseline',
      'key',
      'body',
      'postId',
      'postStatus',
      'images',
      'objectPaths',
      'lastReservationAt',
    ]) &&
      i.version === 1 && i.projectRef === t04ProjectRef && md5(i.runId) &&
      ['--smoke', '--draft-write'].includes(i.mode) &&
      keys(i.actors, ['A', 'B']) && md5(i.actors.A) && md5(i.actors.B) && i.actors.A !== i.actors.B &&
      uuid(i.key) && i.body === `T10-CLOUD-TEST-${i.runId}` && (i.postId === null || uuid(i.postId)) &&
      [null, 'DRAFT', 'PUBLISHED'].includes(i.postStatus) &&
      (i.postId === null) === (i.postStatus === null) &&
      Array.isArray(i.images) && i.images.length <= 2 && Array.isArray(i.objectPaths) &&
      (i.lastReservationAt === null ||
        typeof i.lastReservationAt === 'string' && Number.isFinite(Date.parse(i.lastReservationAt))),
    'T10_INVENTORY_SCOPE',
  )
  mediaBaseline(i.baseline)
  check(
    Object.values(i.actors).every((h) =>
      i.baseline.business.owners.some((o) => o.hash === h && o.status === 'ACTIVE')
    ),
    'T10_INVENTORY_ACTORS',
  )
  const assets = mediaAssets()
  check(
    i.images.every((image) => {
      const asset = assets.find((a) => a.position === image.position)
      return keys(image, ['id', 'postId', 'path', 'mime', 'size', 'position', 'status']) && uuid(image.id) &&
        image.postId === i.postId && image.path === `posts/${i.postId}/${image.id}.${asset?.extension}` &&
        image.mime === asset?.mime && image.size === asset.size && ['PENDING', 'READY'].includes(image.status)
    }) && new Set(i.images.map((r) => r.position)).size === i.images.length &&
      new Set(i.images.map((r) => r.id)).size === i.images.length &&
      new Set(i.objectPaths).size === i.objectPaths.length &&
      i.objectPaths.every((p) => i.images.some((r) => r.path === p)),
    'T10_INVENTORY_IMAGES',
  )
  check(
    i.mode !== '--smoke' ||
      i.postId === null && i.images.length === 0 && i.objectPaths.length === 0 &&
        i.lastReservationAt === null,
    'T10_SMOKE_NO_WRITES',
  )
}
export function validateMediaJournal(j: MediaJournal) {
  check(
    keys(j, ['inventory', 'status', 'uncertain', 'events']) &&
      ['RUNNING', 'UNCERTAIN', 'COMPLETED', 'AWAITING_PUBLISH_REVIEW', 'AWAITING_RETENTION_OR_CLEANUP_REVIEW']
        .includes(j.status) &&
      typeof j.uncertain === 'boolean' && Array.isArray(j.events),
    'T10_JOURNAL_SHAPE',
  )
  validateMediaInventory(j.inventory)
  let pending: MediaStage | null = null, ack = false
  for (const e of j.events) {
    check(
      keys(e, ['stage', 'phase', 'at', 'proof']) && stages.includes(e.stage) &&
        ['INTENT', 'ACK', 'VERIFIED', 'UNCERTAIN'].includes(e.phase) &&
        typeof e.at === 'string' && Number.isFinite(Date.parse(e.at)) && /^[a-f0-9]{64}$/.test(e.proof),
      'T10_JOURNAL_EVENT',
    )
    if (e.phase === 'INTENT') {
      check(pending === null && j.inventory.mode === '--draft-write', 'T10_JOURNAL_INTENT_ORDER')
      pending = e.stage
      ack = false
    }
    if (e.phase === 'ACK') {
      check(pending === e.stage && !ack, 'T10_JOURNAL_ACK_ORDER')
      ack = true
    }
    if (e.phase === 'VERIFIED' && pending) {
      check(pending === e.stage && ack, 'T10_JOURNAL_VERIFY_ORDER')
      pending = null
    }
  }
  check(j.uncertain || pending === null, 'T10_UNRESOLVED_INTENT')
  if (j.status !== 'RUNNING' && j.status !== 'UNCERTAIN') {
    check(
      !j.uncertain && j.events.at(-1)?.phase === 'VERIFIED' && j.events.at(-1)?.stage === 'FINISH',
      'T10_COMPLETION_PROOF',
    )
    check(
      j.inventory.mode === '--smoke'
        ? j.status === 'COMPLETED'
        : j.inventory.postId !== null && j.inventory.images.length === 2 && j.inventory.images.every((i) =>
          i.status === 'READY'
        ) && j.inventory.objectPaths.length === 2 &&
          (j.status === 'AWAITING_PUBLISH_REVIEW'
            ? j.inventory.postStatus === 'DRAFT'
            : j.status === 'AWAITING_RETENTION_OR_CLEANUP_REVIEW' && j.inventory.postStatus === 'PUBLISHED'),
      'T10_COMPLETION_SCOPE',
    )
  }
}
export function assertMediaScope(i: MediaInventory, current: MediaSnapshot) {
  validateMediaInventory(i)
  parseMediaSnapshot(current)
  const base = i.baseline
  const protectedBusiness = (s: MediaSnapshot, fixture: boolean) => ({
    ...s.business,
    counts: { ...s.business.counts, posts: s.business.counts.posts - (fixture ? 1 : 0), images: 0 },
    otherHash: '',
    posts: s.business.posts.filter((p) => p.id !== i.postId),
  })
  check(
    JSON.stringify(protectedBusiness(base, false)) ===
        JSON.stringify(protectedBusiness(current, i.postId !== null)) &&
      current.auxHash === base.auxHash &&
      JSON.stringify(current.security) === JSON.stringify(base.security) &&
      JSON.stringify(current.postProofs.filter((p) => p.id !== i.postId)) === JSON.stringify(base.postProofs),
    'T10_PROTECTED_DATA_DRIFT',
  )
  check(
    current.images.length === i.images.length &&
      current.images.every((row) =>
        i.images.some((expected) =>
          Object.entries(expected).every(([key, value]) => row[key as keyof MediaImage] === value)
        )
      ) &&
      current.objects.map((o) => o.path).sort().join() === [...i.objectPaths].sort().join(),
    'T10_EXACT_IMAGE_OBJECT_SCOPE',
  )
  for (const image of current.images) {
    const object = current.objects.find((o) => o.path === image.path)
    check(
      !object || object.size === image.size && object.mime === image.mime,
      'T10_STORAGE_METADATA_MISMATCH',
    )
    check(image.status !== 'READY' || !!object, 'T10_READY_OBJECT_MISSING')
  }
  if (i.postId) {
    const post = current.business.posts.find((p) => p.id === i.postId)
    const proof = current.postProofs.find((p) => p.id === i.postId)
    check(
      post?.authorHash === i.actors.A && post.status === i.postStatus && post.commentCount === 0 &&
        post.upvoteCount === 0 &&
        proof?.keyHash === md5String(i.key) && proof.bodyHash === md5String(i.body) &&
        proof.anonymous === true,
      'T10_EXACT_POST_SCOPE',
    )
  }
}

export function mediaVerificationSql(i: MediaInventory) {
  validateMediaInventory(i)
  return `-- READ ONLY ${t04ProjectRef}; run ${i.runId}. Không chạy cleanup.
${mediaSnapshotSql};
select id,status,md5(author_id::text) as author_hash from public.posts
 where idempotency_key=${literal(i.key)}::uuid and body=${literal(i.body)} and md5(author_id::text)=${
    literal(i.actors.A)
  };
-- Đối chiếu exact IDs/paths và toàn protected baseline trong inventory; không tự nhận UUID sau unknown ACK.
`
}
export function mediaCleanupPlan(i: MediaInventory) {
  validateMediaInventory(i)
  return `# REVIEW ONLY — T10 ${i.runId}
Project: ${t04ProjectRef}. Post: ${
    i.postId ?? 'UNKNOWN — verify key/body/owner trước'
  }; key: ${i.key}; owner hash: ${i.actors.A}.
Exact image inventory: ${JSON.stringify(i.images)}
Object paths có ACK upload (chỉ VERIFIED sau checkpoint SQL/Storage, xem journal): ${
    JSON.stringify(i.objectPaths)
  }
Asset SHA-256: ${mediaAssets().map((a) => `${a.position}:${a.hash}`).join(', ')}.
Lần reserve/reissue cuối: ${
    i.lastReservationAt ?? 'chưa có ACK'
  }. INTENT chưa ACK có thể vẫn cấp token trên server.

- Không có DELETE tự động hoặc SQL cleanup có thể chạy trong runner.
- PENDING: chờ mọi request settle; upload capability có thể tồn tại ít nhất 2 giờ từ lần cấp/reissue cuối (kể cả ACK bị mất). Không xóa metadata/reset slot để rồi coi object không thể xuất hiện muộn. Review TTL và kiểm tra lại exact path trước/sau cleanup.
- DRAFT READY: phê duyệt riêng removeDraftImage cho exact IDs trên; xác minh object biến mất, DB còn REMOVED tombstones. Không replay upload. Physical metadata/post deletion cần SQL review riêng: exact UUID/key/body/owner/status, protected hashes, FK reports/moderation/comments/votes/images, transaction rollback khi mismatch. Không reset count.
- PUBLISHED READY: removeDraftImage không áp dụng; deletePost chưa triển khai; FK ON DELETE RESTRICT và trigger chặn DELETE metadata PUBLISHED. BLOCKED / RETAIN_FIXTURE_REVIEW. Không xóa object hoặc dùng service-role xóa bù.
- Không DELETE storage.objects, không prefix/domain/marker-only cleanup, không đổi signing key. File lock không bảo vệ máy khác; review hoạt động ngoài runner.
`
}
export interface MediaStore {
  acquire(runId: string, resume: boolean): Promise<void>
  load(runId: string): Promise<MediaJournal>
  save(journal: MediaJournal): Promise<void>
  release(): Promise<void>
}
export function fileMediaStore(directory = new URL('../.temp/t10-media/', import.meta.url)): MediaStore {
  let owned = false, id = '', prior = ''
  const lock = new URL('scope.lock', directory)
  const atomic = async (name: string, text: string) => {
    const temp = new URL(`${name}.${randomUUID()}.tmp`, directory)
    const file = await open(temp, 'wx', 0o600)
    try {
      await file.writeFile(text, 'utf8')
      await file.sync()
    } finally {
      await file.close()
    }
    await rename(temp, new URL(name, directory))
  }
  async function load(runId: string) {
    check(md5(runId), 'T10_RUN_ID')
    const j: MediaJournal = JSON.parse(await readFile(new URL(`${runId}.journal.json`, directory), 'utf8'))
    validateMediaJournal(j)
    check(
      j.inventory.runId === runId &&
        JSON.stringify(j.inventory) ===
          JSON.stringify(JSON.parse(await readFile(new URL(`${runId}.json`, directory), 'utf8'))),
      'T10_ARTIFACT_MISMATCH',
    )
    return j
  }
  return {
    load,
    async acquire(runId, resume) {
      check(md5(runId) && !owned, 'T10_STORE_SCOPE')
      await mkdir(directory, { recursive: true })
      const f = await open(lock, 'wx', 0o600)
      try {
        await f.writeFile(JSON.stringify({ projectRef: t04ProjectRef, runId }))
        await f.sync()
      } finally {
        await f.close()
      }
      owned = true
      id = runId
      const names = await readdir(directory)
      for (const name of names) {
        const found = /^([a-f0-9]{32})\./.exec(name)?.[1]
        check(!found || names.includes(`${found}.journal.json`), 'T10_ORPHAN_ARTIFACT_REVIEW')
        if (!name.endsWith('.journal.json')) continue
        const j = await load(name.slice(0, 32))
        check(
          j.status === 'COMPLETED' && !j.uncertain ||
            resume && j.inventory.runId === runId && j.status === 'AWAITING_PUBLISH_REVIEW' && !j.uncertain,
          'T10_UNRESOLVED_RUN_NO_REPLAY',
        )
      }
      if (resume) prior = JSON.stringify(await load(runId))
      else check(!names.some((name) => name.startsWith(`${runId}.`)), 'T10_RUN_ALREADY_EXISTS')
    },
    async save(j) {
      validateMediaJournal(j)
      check(owned && j.inventory.runId === id, 'T10_STORE_OWNERSHIP')
      if (prior) {
        const disk = await load(id), previous: MediaJournal = JSON.parse(prior)
        check(
          JSON.stringify(disk) === prior &&
            JSON.stringify(j.events.slice(0, previous.events.length)) === JSON.stringify(previous.events) &&
            sha256(
                JSON.stringify({
                  ...j.inventory,
                  postId: null,
                  postStatus: null,
                  images: [],
                  objectPaths: [],
                  lastReservationAt: null,
                }),
              ) ===
              sha256(
                JSON.stringify({
                  ...previous.inventory,
                  postId: null,
                  postStatus: null,
                  images: [],
                  objectPaths: [],
                  lastReservationAt: null,
                }),
              ),
          'T10_HISTORY_OR_BASELINE_CHANGED',
        )
      }
      // Journal trước projection: crash giữa hai rename khóa mọi resume cho đến review.
      await atomic(`${id}.journal.json`, JSON.stringify(j, null, 2) + '\n')
      prior = JSON.stringify(j)
      await atomic(`${id}.json`, JSON.stringify(j.inventory, null, 2) + '\n')
      await atomic(`${id}.verify.sql`, mediaVerificationSql(j.inventory))
      await atomic(`${id}.cleanup-plan.md`, mediaCleanupPlan(j.inventory))
    },
    async release() {
      if (owned) {
        await unlink(lock)
        owned = false
      }
    },
  }
}
