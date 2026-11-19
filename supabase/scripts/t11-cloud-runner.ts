import { createHash, randomUUID } from 'node:crypto'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { ManualAuthError, normalizeOuEmail, parsePassword, readManualAuthConfig } from './auth-helpers.ts'
import { requireVerifiedSession } from './auth-manual-flow.ts'
import { runGetMeChecks, type SocialApiIdentity } from './social-api-manual.ts'
import { check } from './t06-cloud-inventory.ts'
import { publicPost } from './t06-cloud-runner.ts'
import { verifyT11Feed } from './t11-cloud-feed.ts'
import { identityHash, keys, object } from './t09-cloud-inventory.ts'
import { t04ProjectRef, uuidPattern } from './t04-cloud-recovery.ts'
import {
  assertModerationBaseline,
  assertModerationScope,
  type Label,
  makeModerationInventory,
  type ModerationFixture,
  type ModerationInventory,
  type ModerationJournal,
  type ModerationSnapshot,
  type ModerationStore,
  reasonFor,
  validateModerationJournal,
} from './t11-cloud-inventory.ts'

export const requestHash = (text: string) => createHash('sha256').update(text).digest('hex')
export function readT11Config(env: NodeJS.ProcessEnv, linkedRef: string, args: string[]) {
  const auth = readManualAuthConfig(env, linkedRef), mode = args[0] ?? '--smoke'
  check(
    ['--smoke', '--fixture-write', '--moderate-write', '--review-failed-smoke'].includes(mode) &&
      (mode === '--moderate-write' || mode === '--review-failed-smoke'
        ? args.length === 2 && /^[a-f0-9]{32}$/.test(args[1])
        : args.length <= 1),
    'T11_ARGS_NO_ARBITRARY_TARGET',
  )
  if (mode === '--fixture-write') {
    check(env.THEOU_ALLOW_T11_FIXTURE_WRITES === 'theou-dev', 'T11_FIXTURE_APPROVAL_REQUIRED')
  }
  if (mode === '--moderate-write') {
    check(env.THEOU_ALLOW_T11_MODERATION_WRITES === 'theou-dev', 'T11_MODERATION_APPROVAL_REQUIRED')
  }
  const recoveryRunId = env.THEOU_T11_SMOKE_RECOVERY_RUN_ID || null
  if (mode === '--review-failed-smoke' || recoveryRunId) {
    check(
      (mode === '--smoke' || mode === '--review-failed-smoke') &&
        /^[a-f0-9]{32}$/.test(recoveryRunId ?? '') &&
        (mode !== '--review-failed-smoke' || recoveryRunId === args[1]) &&
        !env.THEOU_ALLOW_T11_FIXTURE_WRITES && !env.THEOU_ALLOW_T11_MODERATION_WRITES,
      'T11_RECOVERY_APPROVAL_OR_WRITE_FLAGS',
    )
  }
  if (mode === '--fixture-write' || mode === '--moderate-write') {
    check(env.THEOU_T11_RETAIN_FIXTURES === 'approved', 'T11_RETENTION_APPROVAL_REQUIRED')
  }
  const adminActor = env.THEOU_T11_ADMIN_ACTOR || 'B'
  check(['A', 'B'].includes(adminActor), 'T11_ADMIN_ACTOR')
  if (mode === '--moderate-write') {
    check(/^[a-f0-9]{32}$/.test(env.THEOU_T11_APPROVED_ADMIN_HASH ?? ''), 'T11_APPROVED_ADMIN_HASH_REQUIRED')
  }
  return {
    ...auth,
    mode: mode as '--smoke' | '--fixture-write' | '--moderate-write' | '--review-failed-smoke',
    runId: mode === '--moderate-write' || mode === '--review-failed-smoke' ? args[1] : null,
    recoveryRunId,
    adminActor: adminActor as 'A' | 'B',
    adminHash: mode === '--moderate-write' ? env.THEOU_T11_APPROVED_ADMIN_HASH! : null,
  }
}
type Config = ReturnType<typeof readT11Config>
interface Actor {
  label: 'A' | 'B'
  client: SupabaseClient
  identity: SocialApiIdentity
}
export interface ModerationNetworkScope {
  tokens: Map<string, 'A' | 'B'>
  permits: { actor: 'A' | 'B'; hash: string }[]
  inventory: ModerationInventory | null
  probeId: string
}
export function guardT11Fetch(
  config: Config,
  scope: ModerationNetworkScope,
  fetchRequest: typeof fetch,
): typeof fetch {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input)),
      headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET'),
      bearer = headers.get('authorization')?.replace(/^Bearer /, ''),
      actor = scope.tokens.get(bearer ?? '')
    check(
      url.origin === config.url && config.url === `https://${t04ProjectRef}.supabase.co` && !url.username &&
        !url.password && !url.hash && headers.get('apikey') === config.publishableKey,
      'T11_NETWORK_TARGET_OR_KEY',
    )
    const auth =
      url.pathname === '/auth/v1/token' && method === 'POST' && url.search === '?grant_type=password' ||
      url.pathname === '/auth/v1/user' && method === 'GET' && !url.search && !!bearer ||
      url.pathname === '/auth/v1/logout' && method === 'POST' && url.search === '?scope=local' && !!actor
    if (!auth) {
      check(
        method === 'POST' && !url.search &&
          ['/functions/v1/social-api', '/rest/v1/rpc/t11_admin_hide_content'].includes(url.pathname),
        'T11_NO_ADMIN_STORAGE_RAW_TABLE',
      )
      let body: unknown
      try {
        body = JSON.parse(String(init?.body))
      } catch {
        check(false, 'T11_REQUEST_JSON')
      }
      const raw = url.pathname.startsWith('/rest/')
      if (
        !raw && keys(body, ['action', 'payload']) &&
        ['getMe', 'getPost', 'listPosts', 'listComments', '__t04_unknown__'].includes(String(body.action))
      ) {
        // Chỉ read actions; JWT thiếu/sai do helper T04 gửi bằng fetch riêng.
      } else {
        check(actor && scope.inventory, 'T11_WRITE_ACTOR_OR_INVENTORY')
        const index = scope.permits.findIndex((p) =>
          p.actor === actor && p.hash === requestHash(String(init?.body))
        )
        check(index >= 0, 'T11_DURABLE_INTENT_REQUIRED')
        if (raw) {
          check(
            keys(body, ['p_admin_id', 'p_target_type', 'p_target_id', 'p_reason']) &&
              body.p_target_id === scope.probeId && body.p_target_type === 'POST',
            'T11_RAW_RPC_NONEXISTENT_PROBE_ONLY',
          )
        } else {
          check(keys(body, ['action', 'payload']) && object(body.payload), 'T11_WRITE_SHAPE')
          const p = body.payload, fixtures = scope.inventory.fixtures, action = body.action
          if (config.mode === '--fixture-write') {
            check(
              action === 'createPost' &&
                  fixtures.some((f) =>
                    f.kind === 'POST' && f.id === null && f.owner === actor && p.idempotencyKey === f.key &&
                    p.body === f.body && p.tag === 'CONFESSION' && p.displayMode === 'ANONYMOUS' &&
                    p.contactUrl === null &&
                    keys(p, ['idempotencyKey', 'body', 'tag', 'displayMode', 'contactUrl'])
                  ) ||
                action === 'publishPost' && keys(p, ['postId']) &&
                  fixtures.some((f) =>
                    f.kind === 'POST' && f.label !== 'draft' && f.owner === actor && f.id === p.postId &&
                    f.status === 'DRAFT'
                  ) ||
                action === 'createComment' && keys(p, ['postId', 'body', 'idempotencyKey']) &&
                  fixtures.some((f) =>
                    f.kind === 'COMMENT' && !f.id && f.owner === actor && f.key === p.idempotencyKey &&
                    f.body === p.body && fixtures.find((x) => x.label === f.parent)?.id === p.postId
                  ),
              'T11_FIXTURE_ACTION_SCOPE',
            )
          } else if (config.mode === '--moderate-write') {
            const target = fixtures.find((f) => f.id && f.id === (p.targetId ?? p.postId ?? p.commentId))
            check(
              target &&
                  (action === 'deletePost' && target.kind === 'POST' ||
                    action === 'adminHideContent' &&
                      (target.kind === p.targetType || p.targetType === 'USER') ||
                    action === 'deleteComment' && target.label === 'comment-delete' ||
                    ['createComment', 'toggleUpvote'].includes(String(action)) && target.kind === 'POST' &&
                      ['HIDDEN', 'DELETED'].includes(String(target.status))) ||
                action === 'adminHideContent' && p.targetId === 'invalid' && p.targetType === 'POST',
              'T11_MODERATION_EXACT_FIXTURE_ONLY',
            )
          } else {check(
              action === 'adminHideContent' && p.targetId === scope.probeId,
              'T11_SMOKE_NO_BUSINESS_WRITES',
            )}
        }
        scope.permits.splice(index, 1)
      }
    }
    try {
      return await fetchRequest(input, {
        ...init,
        redirect: 'error',
        credentials: 'omit',
        signal: init?.signal
          ? AbortSignal.any([init.signal, AbortSignal.timeout(20_000)])
          : AbortSignal.timeout(20_000),
      })
    } catch {
      return Response.json({ code: 'T11_NETWORK_UNCERTAIN' }, { status: 503 })
    }
  }
}
export function analyzeHideResults(results: { status: number; code: string | null }[]) {
  check(
    results.length === 2 && results.filter((r) => r.status === 200 && r.code === null).length === 1 &&
      results.filter((r) => r.status === 409 && r.code === 'CONFLICT').length === 1,
    'T11_CONCURRENT_SINGLE_WINNER',
  )
}
export async function runT11Cloud(
  config: Config,
  env: NodeJS.ProcessEnv,
  askHidden: (prompt: string) => Promise<string>,
  store: ModerationStore,
  snapshot: () => Promise<ModerationSnapshot>,
  project: () => Promise<void>,
  report: (line: string) => void,
  fetchRequest: typeof fetch = fetch,
) {
  check(config.mode !== '--review-failed-smoke', 'T11_REVIEW_REQUIRES_READ_ONLY_DISPATCH')
  check(
    JSON.stringify(config) ===
      JSON.stringify(
        readT11Config(env, t04ProjectRef, config.runId ? [config.mode, config.runId] : [config.mode]),
      ),
    'T11_RUNTIME_CONFIG',
  )
  const runId = config.runId ?? randomUUID().replaceAll('-', ''),
    scope: ModerationNetworkScope = {
      tokens: new Map(),
      permits: [],
      inventory: null,
      probeId: randomUUID(),
    },
    guard = guardT11Fetch(config, scope, fetchRequest)
  const actors: Actor[] = [], clients: SupabaseClient[] = []
  let j: ModerationJournal | undefined, acquired = false, failed = true
  const persist = () => store.save(structuredClone(j!), config.adminActor)
  const event = (stage: string, phase: ModerationJournal['events'][number]['phase'], value: unknown) =>
    j!.events.push({ stage, phase, proof: requestHash(JSON.stringify(value)) })
  const fixture = (label: Label) => {
    const f = j!.inventory.fixtures.find((f) => f.label === label)
    check(f, 'T11_FIXTURE_LABEL')
    return f
  }
  async function session(a: Actor) {
    const s = await a.client.auth.getSession()
    check(
      !s.error && s.data.session?.access_token === a.identity.accessToken &&
        s.data.session.user.id === a.identity.userId,
      'T11_SESSION_CHANGED',
    )
  }
  function privacy(v: unknown) {
    const text = JSON.stringify(v)
    check(
      !actors.some((a) =>
        [a.identity.userId, a.identity.email, a.identity.accessToken].some((s) => text.includes(s))
      ) && !text.includes('sb_secret_') && !text.includes('storage_path'),
      'T11_PRIVATE_RESPONSE',
    )
  }
  async function invoke(a: Actor, action: string, payload: unknown) {
    await session(a)
    const result = await a.client.functions.invoke('social-api', {
      body: { action, payload },
      headers: { Authorization: `Bearer ${a.identity.accessToken}` },
      timeout: 15000,
    })
    check(result.response && result.response.headers.get('x-relay-error') !== 'true', 'T11_HTTP_OR_RELAY')
    let body: unknown = result.data
    if (result.error) {
      try {
        body = await result.response.json()
      } catch {
        check(false, 'T11_HTTP_BODY')
      }
    }
    check(
      keys(body, ['data', 'error', 'meta']) && keys(body.meta, ['requestId']) &&
        typeof body.meta.requestId === 'string' && uuidPattern.test(body.meta.requestId),
      'T11_ENVELOPE',
    )
    privacy(body)
    const status = result.response.status
    check(
      status === 200
        ? body.error === null && !result.error
        : body.data === null && keys(body.error, ['code', 'message', 'details']) &&
          [
            'VALIDATION_ERROR',
            'FORBIDDEN',
            'NOT_FOUND',
            'CONFLICT',
            'UNAUTHENTICATED',
            'INTERNAL_ERROR',
            'UPLOAD_ERROR',
          ]
            .includes(
              String(body.error.code),
            ) &&
          typeof body.error.message === 'string' && body.error.details === null,
      'T11_SAFE_HANDLER_RESULT',
    )
    if (status === 200 && ['deletePost', 'deleteComment', 'adminHideContent'].includes(action)) {
      check(keys(body.data, ['success']) && body.data.success === true, 'T11_ACK_ALLOWLIST')
    }
    await session(a)
    const date = Date.parse(result.response.headers.get('date') ?? '')
    return {
      data: body.data,
      status,
      code: object(body.error) ? String(body.error.code) : null,
      serverTime: Number.isFinite(date) ? date : null,
    }
  }
  const expect = (r: Awaited<ReturnType<typeof invoke>>, status = 200, code: string | null = null) => {
    check(r.status === status && r.code === code, 'T11_EXPECTED_HTTP_CODE')
    return r.data
  }
  async function checkpoint(stage: string) {
    const current = await snapshot()
    assertModerationScope(j!, current)
    for (const f of j!.inventory.fixtures.filter((f) => f.id)) {
      const proof = f.kind === 'POST'
        ? current.postProofs.find((p) => p.id === f.id)
        : current.commentProofs.find((p) => p.id === f.id)
      f.immutableHash ??= proof!.immutableHash
      if (f.kind === 'POST' && f.status !== 'DRAFT') {
        f.publishedHash ??= (proof as { publishedHash: string }).publishedHash
      }
    }
    j!.audits = structuredClone(current.audits)
    j!.last = current
    j!.uncertain = false
    event(stage, 'VERIFIED', current)
    await persist()
    report(`PASS: T11_${stage}_SQL_PROTECTED_COUNTS_AUDIT.`)
    return current
  }
  async function batch(
    stage: string,
    requests: { actor: Actor; action: string; payload: Record<string, unknown> }[],
    accept: (results: Awaited<ReturnType<typeof invoke>>[]) => void,
  ) {
    await checkpoint('PRE_' + stage)
    j!.uncertain = true
    j!.status = 'RUNNING'
    for (const r of requests) {
      event(stage, 'INTENT', {
        actor: r.actor.label,
        bodyHash: requestHash(JSON.stringify({ action: r.action, payload: r.payload })),
      })
    }
    await persist()
    for (const r of requests) {
      scope.permits.push({
        actor: r.actor.label,
        hash: requestHash(JSON.stringify({ action: r.action, payload: r.payload })),
      })
    }
    // Luôn đợi tất cả request settle trước snapshot/logout; một timeout không phải rollback.
    const settled = await Promise.allSettled(requests.map((r) => invoke(r.actor, r.action, r.payload)))
    check(settled.every((r) => r.status === 'fulfilled'), 'T11_REQUEST_UNCERTAIN_STOP_NO_REPLAY_' + stage)
    const results = settled.map((r) =>
      (r as PromiseFulfilledResult<Awaited<ReturnType<typeof invoke>>>).value
    )
    accept(results)
    event(stage, 'ACK', results.map((r) => ({ http: r.status, code: r.code })))
    await persist()
    await checkpoint(stage)
  }
  const single = (
    stage: string,
    actor: Actor,
    action: string,
    payload: Record<string, unknown>,
    status = 200,
    code: string | null = null,
    accept?: (data: unknown) => void,
  ) =>
    batch(stage, [{ actor, action, payload }], (r) => {
      const data = expect(r[0], status, code)
      if (status === 200 && ['deletePost', 'deleteComment', 'adminHideContent'].includes(action)) {
        check(keys(data, ['success']) && data.success === true, 'T11_ACK_ALLOWLIST')
      }
      accept?.(data)
    })
  async function reads(s: ModerationSnapshot) {
    for (const a of actors) {
      await verifyT11Feed(
        s,
        { label: a.label, hash: identityHash(a.identity.userId) },
        (payload) => invoke(a, 'listPosts', payload),
        report,
      )
      for (const f of j!.inventory.fixtures.filter((f) => f.kind === 'POST' && f.id)) {
        const r = await invoke(a, 'getPost', { postId: f.id })
        if (f.status === 'PUBLISHED') {
          const p = publicPost(expect(r))
          check(p.id === f.id && p.images.length === 0, 'T11_FIXTURE_PUBLIC_NO_MEDIA')
        } else expect(r, 404, 'NOT_FOUND')
      }
      const parent = j!.inventory.fixtures.find((f) => f.label === 'comments')
      if (parent?.id) {
        const seen: string[] = [],
          expected = s.business.comments.filter((c) => c.postId === parent.id && c.status === 'VISIBLE')
        let cursor: unknown = null
        do {
          const data = expect(await invoke(a, 'listComments', { postId: parent.id, limit: 1, cursor }))
          check(
            keys(data, ['items', 'nextCursor']) && Array.isArray(data.items) &&
              (data.nextCursor === null || typeof data.nextCursor === 'string'),
            'T11_COMMENT_PAGE',
          )
          for (const v of data.items) {
            const proof = s.commentProofs.find((p) => p.id === v.id)
            check(
              keys(v, ['id', 'postId', 'body', 'authorLabel', 'isOriginalPoster', 'isMine', 'createdAt']) &&
                typeof v.id === 'string' && v.postId === parent.id && typeof v.body === 'string' &&
                typeof v.createdAt === 'string' && Number.isFinite(Date.parse(v.createdAt)) &&
                expected.some((c) => c.id === v.id) && !seen.includes(v.id) && proof &&
                v.isOriginalPoster === (proof.authorHash === j!.inventory.actors.A) &&
                v.authorLabel === (v.isOriginalPoster ? 'Chủ bài' : 'OUer ẩn danh') &&
                v.isMine === (proof.authorHash === identityHash(a.identity.userId)),
              'T11_COMMENT_PUBLIC_PRIVACY',
            )
            seen.push(v.id)
          }
          check(seen.length <= expected.length, 'T11_CURSOR_LOOP')
          if (data.nextCursor) {
            let claims: unknown
            try {
              claims = JSON.parse(
                Buffer.from(String(data.nextCursor).split('.')[0], 'base64url').toString('utf8'),
              )
            } catch {
              claims = null
            }
            const last = data.items.at(-1)
            // Chỉ kiểm tra privacy/tuple; cursor nguyên bản được server xác minh HMAC ở trang tiếp theo.
            check(
              keys(claims, ['v', 'kind', 'postId', 'asOf', 'createdAt', 'id']) && claims.v === 1 &&
                claims.kind === 'comments' && claims.postId === parent.id &&
                Number.isSafeInteger(claims.asOf) && claims.id === last?.id &&
                typeof claims.createdAt === 'string' &&
                claims.createdAt.replace('+00:00', 'Z') === last?.createdAt && data.nextCursor !== cursor,
              'T11_CURSOR_PRIVACY_TUPLE',
            )
            privacy(claims)
          }
          cursor = data.nextCursor
        } while (cursor)
        check(seen.length === expected.length, 'T11_COMMENT_HIDDEN_FILTER')
      }
    }
  }
  try {
    // release cũng chạy nếu acquire đã lấy lock rồi thất bại ở kiểm tra journal.
    acquired = true
    await store.acquire(runId, config.mode === '--moderate-write', config.mode)
    await project()
    const before = await snapshot()
    if (config.recoveryRunId) {
      check(store.verifyRecoverySnapshot, 'T11_RECOVERY_STORE_REQUIRED')
    }
    await store.verifyRecoverySnapshot?.(before)
    check(
      !before.business.posts.some((p) => p.id === scope.probeId) &&
        !before.business.comments.some((c) => c.id === scope.probeId),
      'T11_PROBE_COLLISION',
    )
    if (config.mode === '--moderate-write') {
      j = await store.load(runId)
      validateModerationJournal(j)
      check(
        j.status === 'AWAITING_MODERATION_REVIEW' && !j.uncertain && j.inventory.fixtures.length === 8 &&
          j.inventory.fixtures.every((f) =>
            f.id && f.immutableHash &&
            f.status === (f.kind === 'COMMENT' ? 'VISIBLE' : f.label === 'draft' ? 'DRAFT' : 'PUBLISHED') &&
            (f.kind !== 'POST' || f.status === 'DRAFT' || f.publishedHash)
          ),
        'T11_RESUME_VERIFIED_FIXTURES_ONLY',
      )
      check(
        before.roles.length === 1 && before.roles[0].actorHash === config.adminHash &&
          config.adminHash === j.inventory.actors[config.adminActor],
        'T11_EXACT_APPROVED_ADMIN_ROLE',
      )
      j.roles = structuredClone(before.roles)
      assertModerationScope(j, before)
      j.last = before
    } else assertModerationBaseline(before)
    for (const label of ['A', 'B'] as const) {
      let email = normalizeOuEmail(
          env[`THEOU_T06_EMAIL_${label}`] || await askHidden(`Email OU ${label} hiện có (ẩn): `),
        ),
        password = parsePassword(
          env[`THEOU_T06_PASSWORD_${label}`] || await askHidden(`Mật khẩu ${label} (ẩn): `),
          'login',
        )
      const client = createClient(config.url, config.publishableKey, {
        global: { fetch: guard },
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      })
      clients.push(client)
      const session = await requireVerifiedSession(
        client.auth,
        await client.auth.signInWithPassword({ email, password }),
        email,
      )
      password = ''
      scope.tokens.set(session.access_token, label)
      const actorHash = identityHash(session.user.id)
      check(
        before.business.owners.some((o) => o.hash === actorHash && o.status === 'ACTIVE') &&
          !actors.some((a) => a.identity.userId === session.user.id),
        'T11_ACTORS_ACTIVE_DISTINCT',
      )
      actors.push({
        label,
        client,
        identity: { email, userId: session.user.id, accessToken: session.access_token },
      })
      email = ''
    }
    const hashes = { A: identityHash(actors[0].identity.userId), B: identityHash(actors[1].identity.userId) }
    if (j) {
      check(JSON.stringify(hashes) === JSON.stringify(j.inventory.actors), 'T11_ACTORS_INVENTORY_MISMATCH')
    } else {j = {
        inventory: makeModerationInventory(runId, before, hashes, config.mode === '--smoke'),
        status: 'RUNNING',
        uncertain: false,
        roles: before.roles,
        audits: before.audits,
        events: [],
        last: before,
      }}
    scope.inventory = j.inventory
    if (config.mode === '--moderate-write') {
      j.status = 'RUNNING'
      j.uncertain = true
    }
    await persist()
    for (const a of actors) {
      const me = expect(await invoke(a, 'getMe', {}))
      check(
        keys(me, ['nickname', 'emailMasked', 'isAdmin']) && typeof me.nickname === 'string' &&
          me.emailMasked === '***@ou.edu.vn' &&
          me.isAdmin === (config.mode === '--moderate-write' && a.label === config.adminActor),
        'T11_GETME_ROLE_SNAPSHOT',
      )
      await runGetMeChecks(a.client, config, a.identity, report, guard)
    }
    await checkpoint('AUTH')
    if (config.mode === '--smoke') {
      for (const a of actors) {
        await single(
          'NON_ADMIN_DENIED',
          a,
          'adminHideContent',
          { targetType: 'POST', targetId: scope.probeId, reason: 'T11 denial probe' },
          403,
          'FORBIDDEN',
        )
        const payload = {
          p_admin_id: a.identity.userId,
          p_target_type: 'POST',
          p_target_id: scope.probeId,
          p_reason: 'T11 denied raw RPC',
        }
        j.uncertain = true
        event('RAW_RPC_DENIAL', 'INTENT', { actor: a.label, hash: requestHash(JSON.stringify(payload)) })
        await persist()
        scope.permits.push({ actor: a.label, hash: requestHash(JSON.stringify(payload)) })
        const r = await guard(config.url + '/rest/v1/rpc/t11_admin_hide_content', {
          method: 'POST',
          headers: {
            apikey: config.publishableKey,
            authorization: `Bearer ${a.identity.accessToken}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(payload),
        })
        const v: unknown = await r.json()
        check(
          [401, 403].includes(r.status) && object(v) && v.code === '42501' &&
            r.headers.get('x-relay-error') !== 'true',
          'T11_RAW_RPC_EXECUTE_DENIED',
        )
        await session(a)
        event('RAW_RPC_DENIAL', 'ACK', { status: r.status, code: '42501' })
        await checkpoint('RAW_RPC_DENIAL')
      }
      await reads(j.last)
      check(JSON.stringify(await snapshot()) === JSON.stringify(before), 'T11_SMOKE_SNAPSHOT_CHANGED')
      j.status = 'COMPLETED_SMOKE'
      await persist()
    } else if (config.mode === '--fixture-write') {
      for (const f of j.inventory.fixtures) {
        const actor = actors.find((a) => a.label === f.owner)!
        if (f.kind === 'POST') {
          await single(
            'CREATE_' + f.label.toUpperCase().replaceAll('-', '_'),
            actor,
            'createPost',
            {
              body: f.body,
              idempotencyKey: f.key,
              tag: 'CONFESSION',
              displayMode: 'ANONYMOUS',
              contactUrl: null,
            },
            200,
            null,
            (data) => {
              check(
                keys(data, ['postId', 'status']) && typeof data.postId === 'string' &&
                  uuidPattern.test(data.postId) && data.status === 'DRAFT',
                'T11_CREATE_ACK',
              )
              f.id = data.postId
              f.status = 'DRAFT'
            },
          )
          if (f.label !== 'draft') {
            await single(
              'PUBLISH_' + f.label.toUpperCase().replaceAll('-', '_'),
              actor,
              'publishPost',
              { postId: f.id },
              200,
              null,
              (data) => {
                const p = publicPost(data)
                check(p.id === f.id && p.images.length === 0, 'T11_PUBLISH_ACK')
                f.status = 'PUBLISHED'
              },
            )
          }
        } else {await single(
            'CREATE_' + f.label.toUpperCase().replaceAll('-', '_'),
            actor,
            'createComment',
            { postId: fixture(f.parent!).id, body: f.body, idempotencyKey: f.key },
            200,
            null,
            (data) => {
              check(
                object(data) && typeof data.id === 'string' && uuidPattern.test(data.id),
                'T11_COMMENT_ACK',
              )
              f.id = data.id
              f.status = 'VISIBLE'
            },
          )}
      }
      await reads(j.last)
      await checkpoint('FIXTURES_READY')
      j.status = 'AWAITING_MODERATION_REVIEW'
      await persist()
    } else {
      const a = actors[0],
        b = actors[1],
        admin = actors.find((a) => a.label === config.adminActor)!,
        nonAdmin = actors.find((a) => a.label !== config.adminActor)!,
        owner = fixture('owner'),
        post = fixture('post-hide'),
        comment = fixture('comment-hide'),
        race = fixture('race')
      const hide = (f: ModerationFixture) => ({
        targetType: f.kind,
        targetId: f.id,
        reason: reasonFor(runId, f.label),
      })
      await reads(j.last)
      await single('NON_ADMIN_DENIED', nonAdmin, 'adminHideContent', hide(post), 403, 'FORBIDDEN')
      await single('CROSS_OWNER_DENIED', b, 'deletePost', { postId: owner.id }, 404, 'NOT_FOUND')
      for (
        const payload of [
          { ...hide(post), role: 'ADMIN' },
          { ...hide(post), reason: '' },
          { ...hide(post), targetType: 'USER' },
          { ...hide(post), targetId: 'invalid' },
          { ...hide(post), adminId: a.identity.userId },
        ]
      ) await single('VALIDATION_DENIED', admin, 'adminHideContent', payload, 400, 'VALIDATION_ERROR')
      await single('DRAFT_DELETE_DENIED', a, 'deletePost', { postId: fixture('draft').id }, 409, 'CONFLICT')
      await single('DRAFT_HIDE_DENIED', admin, 'adminHideContent', hide(fixture('draft')), 409, 'CONFLICT')
      await single('OWNER_DELETE', a, 'deletePost', { postId: owner.id }, 200, null, () => {
        owner.status = 'DELETED'
      })
      const ownerProof = structuredClone(j.last)
      await single('OWNER_REPLAY', a, 'deletePost', { postId: owner.id })
      check(JSON.stringify(ownerProof) === JSON.stringify(j.last), 'T11_DELETE_REPLAY_WROTE')
      for (const f of [post, comment]) {
        await batch(
          f.kind + '_HIDE_CONCURRENT',
          [0, 1].map(() => ({ actor: admin, action: 'adminHideContent', payload: hide(f) })),
          (r) => {
            analyzeHideResults(r)
            check(
              r.filter((x) => x.status === 200).every((x) =>
                keys(x.data, ['success']) && x.data.success === true
              ),
              'T11_HIDE_ACK',
            )
            f.status = 'HIDDEN'
          },
        )
        const proof = structuredClone(j.last)
        await single(f.kind + '_HIDE_REPLAY', admin, 'adminHideContent', hide(f), 409, 'CONFLICT')
        check(JSON.stringify(proof) === JSON.stringify(j.last), 'T11_HIDE_REPLAY_WROTE')
      }
      await single('HIDDEN_OWNER_DELETE_DENIED', a, 'deletePost', { postId: post.id }, 409, 'CONFLICT')
      await batch('OWNER_ADMIN_RACE', [{ actor: a, action: 'deletePost', payload: { postId: race.id } }, {
        actor: admin,
        action: 'adminHideContent',
        payload: hide(race),
      }], (r) => {
        analyzeHideResults(r)
        race.status = r[0].status === 200 ? 'DELETED' : 'HIDDEN'
      })
      await single(
        'T08_COMMENT_OWNER_DELETE',
        b,
        'deleteComment',
        { commentId: fixture('comment-delete').id },
        200,
        null,
        () => {
          fixture('comment-delete').status = 'DELETED'
        },
      )
      await single('T08_COMMENT_REPLAY', b, 'deleteComment', { commentId: fixture('comment-delete').id })
      await single(
        'HIDDEN_PARENT_COMMENT_DENIED',
        a,
        'createComment',
        { postId: post.id, body: `T11 denied ${runId}`, idempotencyKey: randomUUID() },
        404,
        'NOT_FOUND',
      )
      await single(
        'HIDDEN_PARENT_VOTE_DENIED',
        a,
        'toggleUpvote',
        { postId: post.id, desiredState: true },
        404,
        'NOT_FOUND',
      )
      await reads(j.last)
      await checkpoint('MODERATION_COMPLETE')
      j.status = 'AWAITING_RETENTION_AND_ROLE_REVIEW'
      await persist()
    }
    failed = false
  } catch (error) {
    if (j) {
      j.status = 'UNCERTAIN'
      j.uncertain = true
      try {
        await persist()
      } catch { /* Durable prior INTENT remains; never log raw I/O/SDK errors. */ }
    }
    throw error instanceof ManualAuthError
      ? error
      : new ManualAuthError('FAIL: T11_IO_OR_SDK_UNCERTAIN. Dừng; review journal, không replay batch.')
  } finally {
    let logoutFailed = false
    for (const client of clients) {
      try {
        const result = await client.auth.signOut({ scope: 'local' }), s = await client.auth.getSession()
        check(!result.error && !s.error && s.data.session === null, 'T11_LOGOUT_SESSION')
      } catch {
        logoutFailed = true
      }
    }
    scope.tokens.clear()
    scope.permits.length = 0
    if (acquired) await store.release()
    check(!logoutFailed, 'T11_LOGOUT_FAILED_NO_CLEANUP')
    report(
      clients.length
        ? 'Logout local: PASS. Không cleanup hoặc thay role.'
        : 'Không tạo phiên; không cleanup hoặc thay role.',
    )
  }
  check(!failed, 'T11_RUN_FAILED')
  report(`PASS: T11 ${config.mode}; runId=${runId}; ${j!.status}.`)
}
