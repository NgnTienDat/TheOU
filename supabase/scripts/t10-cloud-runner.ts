import { randomUUID } from 'node:crypto'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { ManualAuthError, normalizeOuEmail, parsePassword, readManualAuthConfig } from './auth-helpers.ts'
import { requireVerifiedSession } from './auth-manual-flow.ts'
import { runGetMeChecks, type SocialApiIdentity } from './social-api-manual.ts'
import { t04ProjectRef, uuidPattern } from './t04-cloud-recovery.ts'
import { check } from './t06-cloud-inventory.ts'
import { publicPost } from './t06-cloud-runner.ts'
import { identityHash, keys } from './t09-cloud-inventory.ts'
import {
  assertMediaScope,
  mediaBaseline,
  type MediaImage,
  type MediaInventory,
  type MediaJournal,
  type MediaSnapshot,
  type MediaStage,
  type MediaStore,
  validateMediaJournal,
} from './t10-cloud-inventory.ts'
import { mediaAssets, sha256 } from './t10-media-assets.ts'

export function readT10Config(env: NodeJS.ProcessEnv, linkedRef: string, args: string[]) {
  const auth = readManualAuthConfig(env, linkedRef)
  const mode = args[0] ?? '--smoke'
  check(
    ['--smoke', '--draft-write', '--publish-write'].includes(mode) &&
      (mode === '--publish-write' ? args.length === 2 && /^[a-f0-9]{32}$/.test(args[1]) : args.length <= 1),
    'T10_ARGS',
  )
  if (mode === '--draft-write') {
    check(env.THEOU_ALLOW_T10_DRAFT_WRITES === 'theou-dev', 'T10_DRAFT_APPROVAL_REQUIRED')
  }
  if (mode === '--publish-write') {
    check(env.THEOU_ALLOW_T10_PUBLISH_WRITES === 'theou-dev', 'T10_PUBLISH_APPROVAL_REQUIRED')
    // Chưa có deletePost; retention cần được chủ dự án phê duyệt riêng trước publish.
    check(env.THEOU_T10_RETAIN_PUBLISHED_FIXTURE === 'approved', 'T10_PUBLISH_BLOCKED_RETAIN_FIXTURE_REVIEW')
  }
  if (mode !== '--smoke') {
    check(
      /^sb_secret_[A-Za-z0-9_-]+$/.test(env.THEOU_TEST_SECRET_KEY ?? ''),
      'T10_NODE_READONLY_STORAGE_VERIFIER_KEY',
    )
  }
  return {
    ...auth,
    mode: mode as '--smoke' | '--draft-write' | '--publish-write',
    runId: mode === '--publish-write' ? args[1] : null,
  }
}
type Config = ReturnType<typeof readT10Config>
interface Actor {
  client: SupabaseClient
  identity: SocialApiIdentity
  label: 'A' | 'B'
}
interface Permit {
  actor: 'A' | 'B'
  bodyHash: string
}
export interface MediaNetworkScope {
  tokens: Map<string, 'A' | 'B'>
  permits: Permit[]
  upload: { path: string; token: string; size: number; mime: string; hash: string } | null
  directUploadProbe?: { path: string; hash: string }
  images: MediaImage[]
  signedReads: Set<string>
}
export function guardT10Fetch(
  config: Config,
  scope: MediaNetworkScope,
  request: typeof fetch,
  secret = '',
): typeof fetch {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
    check(
      config.url === `https://${t04ProjectRef}.supabase.co` && url.origin === config.url && !url.username &&
        !url.password && !url.hash,
      'T10_NETWORK_TARGET',
    )
    const key = headers.get('apikey'), bearer = headers.get('authorization')?.replace(/^Bearer /, '')
    const actor = scope.tokens.get(bearer ?? '')
    const privileged = !!secret && key === secret
    if (privileged) {
      check(
        config.mode !== '--smoke' && method === 'GET' && bearer === secret && !url.search &&
          scope.images.some((i) =>
            url.pathname === `/storage/v1/object/info/post-media/${i.path}` ||
            url.pathname === `/storage/v1/object/post-media/${i.path}`
          ),
        'T10_PRIVILEGED_READONLY_EXACT_OBJECT',
      )
    } else {
      const signedRead = method === 'GET' && scope.signedReads.has(url.href) && key === null && !bearer
      check(
        signedRead || key === config.publishableKey && /^sb_publishable_[A-Za-z0-9_-]+$/.test(String(key)),
        'T10_NETWORK_KEY',
      )
      const auth =
        url.pathname === '/auth/v1/token' && method === 'POST' && url.search === '?grant_type=password' ||
        url.pathname === '/auth/v1/user' && method === 'GET' && !!actor ||
        url.pathname === '/auth/v1/logout' && method === 'POST' && url.search === '?scope=local' && !!actor
      // getUser pendant signIn xảy ra trước khi actor được đăng ký; chỉ JWT chưa biết trên Auth GET.
      const verifying = url.pathname === '/auth/v1/user' && method === 'GET' && !!bearer &&
        bearer !== config.publishableKey
      if (url.pathname === '/functions/v1/social-api' && method === 'POST' && !url.search) {
        let body: unknown
        try {
          body = JSON.parse(String(init?.body))
        } catch {
          check(false, 'T10_REQUEST_JSON')
        }
        check(keys(body, ['action', 'payload']), 'T10_REQUEST_SHAPE')
        if (!['getMe', 'getPost', 'listPosts', '__t04_unknown__'].includes(String(body.action))) {
          const actions = config.mode === '--draft-write'
            ? ['createPost', 'createImageUpload', 'finalizeImage']
            : config.mode === '--publish-write'
            ? ['publishPost']
            : []
          check(actions.includes(String(body.action)) && !!actor, 'T10_NO_UNAPPROVED_MUTATION')
          const index = scope.permits.findIndex((p) =>
            p.actor === actor && p.bodyHash === sha256(String(init?.body))
          )
          check(index >= 0, 'T10_MUTATION_REQUIRES_DURABLE_INTENT')
          scope.permits.splice(index, 1)
        }
      } else if (
        scope.directUploadProbe && method === 'POST' &&
        url.pathname === `/storage/v1/object/post-media/${scope.directUploadProbe.path}`
      ) {
        check(
          config.mode === '--draft-write' && actor === 'A' && !url.search &&
            headers.get('x-upsert') === 'false' && init?.body instanceof FormData,
          'T10_DIRECT_UPLOAD_PROBE_SCOPE',
        )
        const files = [...init.body.values()].filter((v): v is File => v instanceof Blob)
        check(
          files.length === 1 &&
            sha256(new Uint8Array(await files[0].arrayBuffer())) === scope.directUploadProbe.hash,
          'T10_DIRECT_UPLOAD_PROBE_BYTES',
        )
        scope.directUploadProbe = undefined
      } else if (url.pathname.startsWith('/storage/v1/object/upload/sign/')) {
        const permit = scope.upload
        check(
          config.mode === '--draft-write' && actor === 'A' && method === 'PUT' && permit &&
            url.pathname === `/storage/v1/object/upload/sign/post-media/${permit.path}` &&
            [...url.searchParams.keys()].join() === 'token' &&
            url.searchParams.get('token') === permit.token &&
            headers.get('x-upsert') !== 'true' && init?.body instanceof FormData,
          'T10_UPLOAD_CAPABILITY_SCOPE',
        )
        const files = [...init.body.values()].filter((v): v is File => v instanceof Blob)
        check(
          files.length === 1 && files[0].size === permit.size && files[0].type === permit.mime &&
            sha256(new Uint8Array(await files[0].arrayBuffer())) === permit.hash,
          'T10_UPLOAD_BYTES_SCOPE',
        )
        scope.upload = null
      } else {
        const rawRead = method === 'GET' && !url.search &&
          (url.pathname === '/storage/v1/object/public/post-media/t10-nonexistent-probe.png' ||
            scope.images.some((i) =>
              ['/storage/v1/object/public/post-media/', '/storage/v1/object/authenticated/post-media/'].some((
                p,
              ) => url.pathname === p + i.path)
            ))
        let listBody: unknown
        if (url.pathname === '/storage/v1/object/list/post-media') {
          try {
            listBody = JSON.parse(String(init?.body))
          } catch {
            check(false, 'T10_STORAGE_LIST_JSON')
          }
        }
        const list = method === 'POST' && url.pathname === '/storage/v1/object/list/post-media' && !!actor &&
          keys(listBody, ['prefix', 'limit', 'offset', 'sortBy']) && listBody.prefix === '' &&
          listBody.limit === 1 && listBody.offset === 0 &&
          keys(listBody.sortBy, ['column', 'order']) && listBody.sortBy.column === 'name' &&
          listBody.sortBy.order === 'asc'
        check(
          auth || verifying || signedRead || rawRead || list,
          'T10_NO_ADMIN_RAW_TABLE_DELETE_OR_OTHER_PATH',
        )
      }
    }
    try {
      return await request(input, {
        ...init,
        redirect: 'error',
        credentials: 'omit',
        signal: init?.signal
          ? AbortSignal.any([init.signal, AbortSignal.timeout(20_000)])
          : AbortSignal.timeout(20_000),
      })
    } catch {
      // Lọc trước SDK để URL/token/error gốc không vào log. Không coi timeout là rollback.
      return Response.json({ code: 'unexpected_failure', message: 'Request unavailable' }, { status: 503 })
    }
  }
}

export async function runT10Cloud(
  config: Config,
  env: NodeJS.ProcessEnv,
  askHidden: (prompt: string) => Promise<string>,
  store: MediaStore,
  snapshot: () => Promise<MediaSnapshot>,
  project: () => Promise<void>,
  report: (line: string) => void,
  fetchRequest: typeof fetch = fetch,
) {
  check(
    JSON.stringify(config) ===
      JSON.stringify(
        readT10Config(env, t04ProjectRef, config.runId ? [config.mode, config.runId] : [config.mode]),
      ),
    'T10_RUNTIME_CONFIG',
  )
  const scope: MediaNetworkScope = {
    tokens: new Map(),
    permits: [],
    upload: null,
    images: [],
    signedReads: new Set(),
  }
  const guard = guardT10Fetch(config, scope, fetchRequest, env.THEOU_TEST_SECRET_KEY)
  const actors: Actor[] = [], clients: SupabaseClient[] = []
  let journal: MediaJournal | undefined, failed = true, acquired = false
  const runId = config.runId ?? randomUUID().replaceAll('-', '')
  const persist = () => store.save(structuredClone(journal!))
  function event(stage: MediaStage, phase: MediaJournal['events'][number]['phase'], proof: unknown) {
    journal!.events.push({ stage, phase, at: new Date().toISOString(), proof: sha256(JSON.stringify(proof)) })
  }
  async function session(actor: Actor) {
    const current = await actor.client.auth.getSession()
    check(
      !current.error && current.data.session?.access_token === actor.identity.accessToken &&
        current.data.session.user.id === actor.identity.userId,
      'T10_SESSION_CHANGED',
    )
  }
  function privateData(value: unknown) {
    const text = JSON.stringify(value)
    check(
      !actors.some((a) =>
        [a.identity.email, a.identity.userId, a.identity.accessToken].some((s) => text.includes(s))
      ) &&
        !text.includes(env.THEOU_TEST_SECRET_KEY || 'impossible-empty-key'),
      'T10_PRIVATE_RESPONSE',
    )
  }
  async function invoke(actor: Actor, action: string, payload: unknown, status = 200, code?: string) {
    await session(actor)
    const result = await actor.client.functions.invoke('social-api', {
      body: { action, payload },
      headers: { Authorization: `Bearer ${actor.identity.accessToken}` },
      timeout: 15_000,
    })
    check(
      result.response && result.response.status === status &&
        result.response.headers.get('x-relay-error') !== 'true',
      'T10_HTTP_STATUS_OR_RELAY',
    )
    let value: unknown = result.data
    if (result.error) {
      try {
        value = await result.response.json()
      } catch {
        check(false, 'T10_HTTP_BODY')
      }
    }
    check(
      keys(value, ['data', 'error', 'meta']) && keys(value.meta, ['requestId']) &&
        typeof value.meta.requestId === 'string' && uuidPattern.test(value.meta.requestId),
      'T10_ENVELOPE',
    )
    privateData(value)
    check(
      status === 200
        ? !result.error && value.error === null
        : value.data === null && keys(value.error, ['code', 'message', 'details']) &&
          value.error.code === code && typeof value.error.message === 'string' &&
          value.error.details === null,
      'T10_HANDLER_RESULT',
    )
    await session(actor)
    return value.data
  }
  async function objectBytes(image: MediaImage) {
    check(config.mode !== '--smoke', 'T10_NO_PRIVILEGED_SMOKE')
    const client = createClient(config.url, env.THEOU_TEST_SECRET_KEY!, {
      global: { fetch: guard },
      auth: { persistSession: false, autoRefreshToken: false },
    })
    const bucket = client.storage.from('post-media'), info = await bucket.info(image.path)
    check(
      !info.error && info.data?.name === image.path && info.data.bucketId === 'post-media' &&
        info.data.size === image.size && info.data.contentType === image.mime,
      'T10_STORAGE_INFO_MISMATCH',
    )
    const download = await bucket.download(image.path)
    const asset = mediaAssets().find((a) => a.position === image.position)!
    check(
      !download.error && download.data?.size === asset.size && download.data.type === asset.mime &&
        sha256(new Uint8Array(await download.data.arrayBuffer())) === asset.hash,
      'T10_STORAGE_BYTES_MISMATCH',
    )
  }
  async function checkpoint(stage: MediaStage) {
    const current = await snapshot()
    assertMediaScope(journal!.inventory, current)
    scope.images = structuredClone(journal!.inventory.images)
    for (const image of scope.images.filter((i) => journal!.inventory.objectPaths.includes(i.path))) {
      await objectBytes(image)
    }
    event(stage, 'VERIFIED', current)
    journal!.uncertain = false
    await persist()
    report(`PASS: T10_${stage}_SQL_STORAGE_SCOPE.`)
    return current
  }
  async function mutation(
    stage: MediaStage,
    action: string,
    payload: unknown,
    accept: (value: unknown) => void,
    actor = actors[0],
    status = 200,
    code?: string,
  ) {
    await checkpoint('READ')
    journal!.status = 'RUNNING'
    journal!.uncertain = true
    const body = JSON.stringify({ action, payload })
    event(stage, 'INTENT', { actor: actor.label, bodyHash: sha256(body) })
    await persist()
    scope.permits.push({ actor: actor.label, bodyHash: sha256(body) })
    const value = await invoke(actor, action, payload, status, code)
    accept(value)
    event(stage, 'ACK', { http: status })
    await persist()
    await checkpoint(stage)
  }
  async function rawDenial(path: string, actor?: Actor) {
    const response = await guard(config.url + path, {
      headers: {
        apikey: config.publishableKey,
        ...(actor ? { Authorization: `Bearer ${actor.identity.accessToken}` } : {}),
      },
    })
    check(
      [400, 401, 403, 404].includes(response.status) && response.headers.get('x-relay-error') !== 'true',
      'T10_RAW_PRIVATE_ACCESS_NOT_DENIED',
    )
    if (actor) await session(actor)
  }
  async function reads(current: MediaSnapshot) {
    for (const actor of actors) {
      for (const row of current.business.posts) {
        if (row.status === 'DRAFT') {
          await invoke(actor, 'getPost', { postId: row.id }, 404, 'NOT_FOUND')
          continue
        }
        const post = publicPost(await invoke(actor, 'getPost', { postId: row.id }))
        check(
          post.id === row.id && post.isMine === (row.authorHash === identityHash(actor.identity.userId)) &&
            post.upvoteCount === row.upvoteCount && post.commentCount === row.commentCount &&
            !post.hasUpvoted,
          'T10_POST_CALLER_COUNTS',
        )
        const expected = journal!.inventory.images.filter((i) => i.postId === post.id)
        check(
          post.images.length === expected.length &&
            post.images.every((image, index) => image.id === expected[index].id),
          'T10_PUBLIC_IMAGES_ORDER_ALLOWLIST',
        )
        for (const image of post.images) {
          const url = new URL(image.signedUrl), entry = expected.find((i) => i.id === image.id)!
          check(
            url.origin === config.url &&
              url.pathname === `/storage/v1/object/sign/post-media/${entry.path}` &&
              Date.parse(image.expiresAt) > Date.now() && Date.parse(image.expiresAt) <= Date.now() + 301_000,
            'T10_SIGNED_READ_SCOPE_TTL',
          )
          scope.signedReads.add(url.href)
          const response = await guard(url.href)
          const asset = mediaAssets().find((a) => a.position === entry.position)!
          check(
            response.status === 200 && response.headers.get('content-type')?.split(';')[0] === asset.mime &&
              sha256(new Uint8Array(await response.arrayBuffer())) === asset.hash,
            'T10_SIGNED_READ_BYTES',
          )
          scope.signedReads.delete(url.href)
        }
      }
      const page = await invoke(actor, 'listPosts', { sort: 'NEW', tag: null, cursor: null, limit: 20 })
      const published = current.business.posts.filter((p) => p.status === 'PUBLISHED')
      check(
        keys(page, ['items', 'nextCursor']) && Array.isArray(page.items) && page.nextCursor === null &&
          page.items.length === published.length,
        'T10_FEED_SHAPE_NO_DRAFT',
      )
      const ids = page.items.map((item) => publicPost(item).id)
      check(
        new Set(ids).size === ids.length && published.every((p) => ids.includes(p.id)),
        'T10_FEED_EXACT_IDS_NO_DRAFT',
      )
      for (const item of page.items) {
        const post = publicPost(item), row = published.find((p) => p.id === post.id)!
        const expected = journal!.inventory.images.filter((image) => image.postId === post.id)
        check(
          post.isMine === (row.authorHash === identityHash(actor.identity.userId)) &&
            post.commentCount === row.commentCount && post.upvoteCount === row.upvoteCount &&
            !post.hasUpvoted &&
            post.images.length === expected.length && post.images.every((image, index) =>
              image.id === expected[index].id && new URL(image.signedUrl).origin === config.url &&
              new URL(image.signedUrl).pathname ===
                `/storage/v1/object/sign/post-media/${expected[index].path}`
            ),
          'T10_FEED_CALLER_IMAGES_COUNTS',
        )
      }
    }
  }
  try {
    await store.acquire(runId, config.mode === '--publish-write')
    acquired = true
    await project()
    const before = await snapshot()
    if (config.mode === '--publish-write') {
      journal = await store.load(runId)
      validateMediaJournal(journal)
      check(
        journal.inventory.runId === runId && journal.inventory.mode === '--draft-write' &&
          !journal.uncertain && journal.status === 'AWAITING_PUBLISH_REVIEW',
        'T10_PUBLISH_VERIFIED_DRAFT_ONLY',
      )
      assertMediaScope(journal.inventory, before)
      journal.status = 'RUNNING'
    } else mediaBaseline(before)
    for (const label of ['A', 'B'] as const) {
      let email = normalizeOuEmail(
        env[`THEOU_T06_EMAIL_${label}`] || await askHidden(`Email OU ${label} hiện có (ẩn): `),
      )
      let password = parsePassword(
        env[`THEOU_T06_PASSWORD_${label}`] || await askHidden(`Mật khẩu ${label} (ẩn): `),
        'login',
      )
      const client = createClient(config.url, config.publishableKey, {
        global: { fetch: guard },
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      })
      clients.push(client)
      const verified = await requireVerifiedSession(
        client.auth,
        await client.auth.signInWithPassword({ email, password }),
        email,
      )
      password = ''
      scope.tokens.set(verified.access_token, label)
      const hash = identityHash(verified.user.id)
      check(
        before.business.owners.some((o) => o.hash === hash && o.status === 'ACTIVE') &&
          !actors.some((a) => a.identity.userId === verified.user.id),
        'T10_CONFIRMED_ACTIVE_DISTINCT_ACTORS',
      )
      actors.push({
        client,
        label,
        identity: { email, userId: verified.user.id, accessToken: verified.access_token },
      })
      email = ''
    }
    const actorHashes = {
      A: identityHash(actors[0].identity.userId),
      B: identityHash(actors[1].identity.userId),
    }
    if (journal) {
      check(
        JSON.stringify(actorHashes) === JSON.stringify(journal.inventory.actors),
        'T10_RESUME_EXACT_ACTORS',
      )
    } else {
      const inventory: MediaInventory = {
        version: 1,
        projectRef: t04ProjectRef,
        runId,
        mode: config.mode as '--smoke' | '--draft-write',
        actors: actorHashes,
        baseline: before,
        key: randomUUID(),
        body: `T10-CLOUD-TEST-${runId}`,
        postId: null,
        postStatus: null,
        images: [],
        objectPaths: [],
        lastReservationAt: null,
      }
      journal = { inventory, status: 'RUNNING', uncertain: false, events: [] }
      await persist()
    }
    const i = journal.inventory
    check(JSON.stringify(await snapshot()) === JSON.stringify(before), 'T10_BASELINE_CHANGED_BEFORE_API')
    await checkpoint('BASELINE')
    for (const actor of actors) await runGetMeChecks(actor.client, config, actor.identity, report, guard)
    await reads(before)
    await rawDenial('/storage/v1/object/public/post-media/t10-nonexistent-probe.png')
    for (const actor of actors) {
      const result = await guard(`${config.url}/storage/v1/object/list/post-media`, {
        method: 'POST',
        headers: {
          apikey: config.publishableKey,
          Authorization: `Bearer ${actor.identity.accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ prefix: '', limit: 1, offset: 0, sortBy: { column: 'name', order: 'asc' } }),
      })
      check(
        result.headers.get('x-relay-error') !== 'true' && [200, 401, 403].includes(result.status),
        'T10_RAW_LIST_HTTP',
      )
      if (result.status === 200) {
        let body: unknown
        try {
          body = await result.json()
        } catch {
          check(false, 'T10_RAW_LIST_BODY')
        }
        check(Array.isArray(body) && body.length === 0, 'T10_RAW_LIST_NOT_EMPTY')
      }
      await session(actor)
    }
    report('PASS: T10_STORAGE_CATALOG_AND_LIST; known-object denial NOT_TESTED nếu chưa có object.')
    if (config.mode === '--draft-write') {
      const create = {
        body: i.body,
        tag: 'CONFESSION',
        displayMode: 'ANONYMOUS',
        contactUrl: null,
        idempotencyKey: i.key,
      }
      const acceptPost = (value: unknown) => {
        check(
          keys(value, ['postId', 'status']) && typeof value.postId === 'string' &&
            uuidPattern.test(value.postId) && value.status === 'DRAFT' &&
            (!i.postId || i.postId === value.postId),
          'T10_CREATE_ACK',
        )
        i.postId = value.postId
        i.postStatus = 'DRAFT'
      }
      await mutation('CREATE', 'createPost', create, acceptPost)
      await mutation('CREATE_RETRY', 'createPost', create, acceptPost)
      for (const asset of mediaAssets()) {
        const position = asset.position as 1 | 2
        const upload = { postId: i.postId, mimeType: asset.mime, sizeBytes: asset.size, position }
        let token = '', path = ''
        const acceptReservation = (value: unknown) => {
          check(
            keys(value, ['imageId', 'path', 'token']) && typeof value.imageId === 'string' &&
              uuidPattern.test(value.imageId) &&
              value.path === `posts/${i.postId}/${value.imageId}.${asset.extension}` &&
              typeof value.token === 'string' && value.token.length > 0,
            'T10_RESERVATION_SCOPE',
          )
          privateData(value.path)
          const prior = i.images.find((r) => r.position === position)
          check(
            !prior || prior.id === value.imageId && prior.path === value.path,
            'T10_RESERVATION_RETRY_CHANGED_ROW',
          )
          if (!prior) {
            i.images.push({
              id: value.imageId,
              postId: i.postId!,
              path: value.path as string,
              mime: asset.mime,
              size: asset.size,
              position,
              status: 'PENDING',
            })
          }
          token = value.token
          path = value.path as string
          i.lastReservationAt = new Date().toISOString()
        }
        await mutation(`RESERVE_${position}`, 'createImageUpload', upload, acceptReservation)
        await mutation(`RESERVE_RETRY_${position}`, 'createImageUpload', upload, acceptReservation)
        const image = i.images.find((r) => r.position === position)!
        await mutation('NEGATIVE', 'createImageUpload', upload, () => {}, actors[1], 404, 'NOT_FOUND')
        await mutation(
          'NEGATIVE',
          'finalizeImage',
          { postId: i.postId, imageId: image.id },
          () => {},
          actors[1],
          404,
          'NOT_FOUND',
        )
        // Probe cũng là write attempt: cần durable INTENT và chỉ đúng path fixture chưa upload.
        journal.uncertain = true
        event('NEGATIVE', 'INTENT', { pathHash: sha256(path), probe: 'RAW_UPLOAD_WITHOUT_CAPABILITY' })
        await persist()
        scope.directUploadProbe = { path, hash: asset.hash }
        const denied = await actors[0].client.storage.from('post-media').upload(
          path,
          new Blob([new Uint8Array(asset.bytes)], { type: asset.mime }),
          { contentType: asset.mime, upsert: false },
        )
        scope.directUploadProbe = undefined
        check(
          denied.error && ([401, 403].includes(Number(denied.error.status)) || denied.error.status === 400 &&
              'statusCode' in denied.error && denied.error.statusCode === '403'),
          'T10_RAW_UPLOAD_EXPECTED_DENIAL',
        )
        event('NEGATIVE', 'ACK', { probe: 'RAW_UPLOAD_DENIED' })
        await persist()
        await checkpoint('NEGATIVE')
        const stage = `UPLOAD_${position}` as MediaStage
        await checkpoint('READ')
        journal.uncertain = true
        event(stage, 'INTENT', { pathHash: sha256(path), assetHash: asset.hash })
        await persist()
        scope.upload = { path, token, size: asset.size, mime: asset.mime, hash: asset.hash }
        const uploaded = await actors[0].client.storage.from('post-media').uploadToSignedUrl(
          path,
          token,
          new Blob([new Uint8Array(asset.bytes)], { type: asset.mime }),
          { contentType: asset.mime, upsert: false },
        )
        token = ''
        scope.upload = null
        check(!uploaded.error && uploaded.data?.path === path, 'T10_UPLOAD_ACK_UNCERTAIN_NO_REPLAY')
        await session(actors[0])
        i.objectPaths.push(path)
        event(stage, 'ACK', { pathHash: sha256(path) })
        await persist()
        await checkpoint(stage)
        const finalize = { postId: i.postId, imageId: image.id }
        const acceptReady = (value: unknown) => {
          check(
            keys(value, ['imageId', 'status']) && value.imageId === image.id && value.status === 'READY',
            'T10_FINALIZE_ACK',
          )
          image.status = 'READY'
        }
        await mutation(`FINALIZE_${position}`, 'finalizeImage', finalize, acceptReady)
        await mutation(`FINALIZE_RETRY_${position}`, 'finalizeImage', finalize, acceptReady)
      }
      const valid = { postId: i.postId, mimeType: 'image/png', sizeBytes: mediaAssets()[0].size, position: 1 }
      for (
        const invalid of [
          { ...valid, position: 3 },
          { ...valid, mimeType: 'image/gif' },
          { ...valid, sizeBytes: 0 },
          { ...valid, sizeBytes: 2097153 },
          { ...valid, postId: 'bad' },
          { ...valid, authorId: actors[1].identity.userId },
        ]
      ) {
        await mutation('NEGATIVE', 'createImageUpload', invalid, () => {}, actors[0], 400, 'VALIDATION_ERROR')
      }
      const absent = randomUUID()
      check(
        !(await snapshot()).business.posts.some((post) => post.id === absent),
        'T10_MISSING_DRAFT_PRECONDITION',
      )
      await mutation(
        'NEGATIVE',
        'createImageUpload',
        { ...valid, postId: absent },
        () => {},
        actors[0],
        404,
        'NOT_FOUND',
      )
      await reads(await snapshot())
    }
    if (config.mode === '--publish-write') {
      check(
        i.images.length === 2 && i.images.every((r) => r.status === 'READY') && i.objectPaths.length === 2 &&
          i.postStatus === 'DRAFT',
        'T10_PUBLISH_READY_EXACT_SCOPE',
      )
      await checkpoint('READ')
      await mutation('PUBLISH', 'publishPost', { postId: i.postId }, (value) => {
        const post = publicPost(value)
        check(post.id === i.postId && post.images.length === 2, 'T10_PUBLISH_ACK')
        i.postStatus = 'PUBLISHED'
      })
      await reads(await snapshot())
    }
    for (const image of i.images.filter((r) => i.objectPaths.includes(r.path))) {
      await rawDenial(`/storage/v1/object/public/post-media/${image.path}`)
      for (const actor of actors) {
        await rawDenial(`/storage/v1/object/authenticated/post-media/${image.path}`, actor)
      }
    }
    const last = await checkpoint('READ')
    for (const actor of actors) {
      const logout = await actor.client.auth.signOut({ scope: 'local' }),
        current = await actor.client.auth.getSession()
      check(!logout.error && !current.error && current.data.session === null, 'T10_LOGOUT_LOCAL_NULL')
    }
    check(JSON.stringify(await snapshot()) === JSON.stringify(last), 'T10_POST_LOGOUT_BUSINESS_DRIFT')
    event('FINISH', 'VERIFIED', last)
    journal.uncertain = false
    journal.status = config.mode === '--smoke'
      ? 'COMPLETED'
      : config.mode === '--draft-write'
      ? 'AWAITING_PUBLISH_REVIEW'
      : 'AWAITING_RETENTION_OR_CLEANUP_REVIEW'
    await persist()
    failed = false
    report(`PASS: T10_${journal.status}; runId=${runId}; NO_AUTOMATIC_CLEANUP.`)
  } catch (error) {
    const code = error instanceof ManualAuthError
      ? /^FAIL: ([A-Z][A-Z0-9_]+)[.;]/.exec(error.message)?.[1] ?? 'CHECK_FAILED'
      : 'IO_OR_SDK'
    const stage = journal?.events.at(-1)?.stage ?? 'BASELINE'
    if (journal) {
      journal.status = 'UNCERTAIN'
      journal.uncertain = true
      event('FINISH', 'UNCERTAIN', { code: 'VERIFY_EXACT_SCOPE_BEFORE_RECOVERY' })
      try {
        await persist()
      } catch { /* Giữ journal/INTENT đã durable và lock. */ }
    }
    throw new ManualAuthError(
      `FAIL: T10_STOPPED_REVIEW; stage=${stage}; code=${code}; runId=${runId}; giữ journal/lock, không replay hoặc cleanup.`,
    )
  } finally {
    scope.permits = []
    scope.upload = null
    scope.directUploadProbe = undefined
    scope.signedReads.clear()
    const results = await Promise.allSettled(clients.map(async (client) => {
      if ((await client.auth.getSession()).data.session) {
        const result = await client.auth.signOut({ scope: 'local' })
        check(!result.error && (await client.auth.getSession()).data.session === null, 'T10_LOGOUT_FAILURE')
      }
    }))
    check(results.every((r) => r.status === 'fulfilled'), 'T10_LOGOUT_FAILURE_KEEP_LOCK')
    if (!failed && acquired) await store.release()
  }
}
