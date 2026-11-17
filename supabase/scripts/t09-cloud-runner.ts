import { randomUUID } from 'node:crypto'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { ManualAuthError, normalizeOuEmail, parsePassword, readManualAuthConfig } from './auth-helpers.ts'
import { requireVerifiedSession } from './auth-manual-flow.ts'
import { runGetMeChecks, type SocialApiIdentity } from './social-api-manual.ts'
import { publicPost } from './t06-cloud-runner.ts'
import { check } from './t06-cloud-inventory.ts'
import { t04ProjectRef, uuidPattern } from './t04-cloud-recovery.ts'
import {
  approvedVotePost,
  assertVoteBaseline,
  assertVoteProtected,
  identityHash,
  keys,
  type VoteEvent,
  type VoteInventory,
  type VoteJournal,
  type VoteSnapshot,
  type VoteStore,
} from './t09-cloud-inventory.ts'

export function readT09Config(env: NodeJS.ProcessEnv, linkedRef: string, args: string[]) {
  check(
    args.length === 0 || args.length === 1 && ['--smoke', '--write'].includes(args[0]),
    'T09_ARGS_SMOKE_OR_WRITE',
  )
  const auth = readManualAuthConfig(env, linkedRef)
  const mode = args[0] === '--write' ? '--write' as const : '--smoke' as const
  check(
    env.THEOU_T09_POST_ID === undefined || env.THEOU_T09_POST_ID === '' ||
      env.THEOU_T09_POST_ID === approvedVotePost,
    'T09_APPROVED_POST',
  )
  if (mode === '--write') {
    check(
      env.THEOU_ALLOW_T09_CLOUD_WRITES === 'theou-dev' && env.THEOU_T09_POST_ID === approvedVotePost,
      'T09_WRITE_APPROVAL_AND_POST_REQUIRED',
    )
  }
  return {
    ...auth,
    mode,
    postId: approvedVotePost,
    writeApproved: mode === '--write' && env.THEOU_ALLOW_T09_CLOUD_WRITES === 'theou-dev',
  }
}
type Config = ReturnType<typeof readT09Config>
type Label = 'A' | 'B'
interface Actor {
  client: SupabaseClient
  identity: SocialApiIdentity
  hash: string
  label: Label
}
interface Permit {
  seq: number
  actor: Label
  desiredState: boolean
}
export interface VoteNetworkScope {
  tokens: Map<string, Label>
  permits: Permit[]
  dropSeq: number | null
  dropped: boolean
}
function upvoteData(value: unknown) {
  check(
    keys(value, ['hasUpvoted', 'upvoteCount']) && typeof value.hasUpvoted === 'boolean' &&
      Number.isSafeInteger(value.upvoteCount) && Number(value.upvoteCount) >= 0 &&
      Number(value.upvoteCount) <= 2,
    'T09_UPVOTE_DTO',
  )
  return value as { hasUpvoted: boolean; upvoteCount: number }
}
function envelope(body: unknown) {
  check(
    keys(body, ['data', 'error', 'meta']) && keys(body.meta, ['requestId']) &&
      typeof body.meta.requestId === 'string' && uuidPattern.test(body.meta.requestId),
    'T09_ENVELOPE',
  )
  return body
}
export function guardT09Fetch(config: Config, scope: VoteNetworkScope, request: typeof fetch): typeof fetch {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
    check(
      config.url === `https://${t04ProjectRef}.supabase.co` && url.origin === config.url && !url.username &&
        !url.password &&
        headers.get('apikey') === config.publishableKey &&
        /^sb_publishable_[A-Za-z0-9_-]+$/.test(config.publishableKey),
      'T09_NETWORK_TARGET_KEY',
    )
    const auth = url.pathname === '/auth/v1/user' && method === 'GET' ||
      url.pathname === '/auth/v1/token' && method === 'POST' &&
        url.searchParams.get('grant_type') === 'password' ||
      url.pathname === '/auth/v1/logout' && method === 'POST' && url.searchParams.get('scope') === 'local'
    check(
      auth || url.pathname === '/functions/v1/social-api' && method === 'POST',
      'T09_NO_ADMIN_RAW_TABLE_OR_OTHER_PATH',
    )
    let permit: Permit | undefined
    if (!auth) {
      let body: unknown
      try {
        body = JSON.parse(String(init?.body))
      } catch {
        check(false, 'T09_NETWORK_JSON')
      }
      check(keys(body, ['action', 'payload']), 'T09_NETWORK_ACTION')
      if (body.action === 'toggleUpvote') {
        check(
          config.mode === '--write' && config.writeApproved && config.postId === approvedVotePost &&
            keys(body.payload, ['postId', 'desiredState']) &&
            body.payload.postId === approvedVotePost && typeof body.payload.desiredState === 'boolean',
          'T09_NO_UNAPPROVED_MUTATION',
        )
        const caller = scope.tokens.get(headers.get('authorization')?.replace(/^Bearer /, '') ?? '')
        const index = scope.permits.findIndex((p) =>
          p.actor === caller && p.desiredState === (body.payload as Record<string, unknown>).desiredState
        )
        check(index >= 0, 'T09_MUTATION_REQUIRES_DURABLE_INTENT')
        permit = scope.permits.splice(index, 1)[0]
      } else {check(
          ['getMe', 'getPost', 'listPosts', '__t04_unknown__'].includes(String(body.action)),
          'T09_READ_ACTION_ALLOWLIST',
        )}
    }
    try {
      const response = await request(input, {
        ...init,
        redirect: 'error',
        credentials: 'omit',
        signal: init?.signal
          ? AbortSignal.any([init.signal, AbortSignal.timeout(20_000)])
          : AbortSignal.timeout(20_000),
      })
      if (permit?.seq === scope.dropSeq && response.status === 200) {
        const body = envelope(await response.clone().json())
        check(
          body.error === null && response.headers.get('x-relay-error') !== 'true',
          'T09_DROP_REQUIRES_HTTP_SUCCESS',
        )
        const data = upvoteData(body.data)
        check(data.hasUpvoted === true && data.upvoteCount === 1, 'T09_DROP_EXPECTED_SINGLE_VOTE')
        scope.dropped = true
        return Response.json({ code: 'unexpected_failure', message: 'Controlled response discard' }, {
          status: 503,
        })
      }
      return response
    } catch {
      // Không để SDK log URL/error gốc. Timeout vẫn là commit chưa rõ, không phải rollback.
      return Response.json({ code: 'unexpected_failure', message: 'Network request unavailable' }, {
        status: 503,
      })
    }
  }
}

export async function runT09Cloud(
  config: Config,
  env: NodeJS.ProcessEnv,
  askHidden: (prompt: string) => Promise<string>,
  store: VoteStore,
  snapshot: () => Promise<VoteSnapshot>,
  project: () => Promise<void>,
  report: (line: string) => void,
  fetchRequest: typeof fetch = fetch,
) {
  // Recheck config tại API entry; T08 flag không thể mở write và caller không được forge config.
  const expectedConfig = readT09Config(env, t04ProjectRef, [config.mode])
  check(JSON.stringify(expectedConfig) === JSON.stringify(config), 'T09_RUNTIME_CONFIG')
  const runId = randomUUID().replaceAll('-', '')
  const scope: VoteNetworkScope = { tokens: new Map(), permits: [], dropSeq: null, dropped: false }
  const guard = guardT09Fetch(config, scope, fetchRequest)
  const actors: Actor[] = [], clients: SupabaseClient[] = []
  let journal: VoteJournal | undefined,
    baseline: VoteSnapshot,
    failure: unknown,
    seq = 0,
    queue = Promise.resolve()
  const persist = () => {
    const copy = structuredClone(journal!)
    queue = queue.then(() => store.save(copy)).catch((error) => {
      if (journal?.inventory.mode === '--write') journal.uncertain = true
      throw error
    })
    return queue
  }
  function privateData(body: unknown) {
    const text = JSON.stringify(body)
    check(
      !actors.some((a) =>
        [a.identity.userId, a.identity.email, a.identity.accessToken].some((v) => text.includes(v))
      ),
      'T09_PRIVATE_RESPONSE',
    )
  }
  async function session(actor: Actor) {
    const result = await actor.client.auth.getSession()
    check(
      !result.error && result.data.session?.access_token === actor.identity.accessToken &&
        result.data.session.user.id === actor.identity.userId,
      'T09_SESSION_CHANGED',
    )
  }
  async function invoke(
    actor: Actor,
    action: string,
    payload: unknown,
    expectedStatus = 200,
    expectedCode?: string,
  ) {
    await session(actor)
    const result = await actor.client.functions.invoke<unknown>('social-api', {
      body: { action, payload },
      headers: { Authorization: `Bearer ${actor.identity.accessToken}` },
      timeout: 15_000,
    })
    check(result.response && result.response.headers.get('x-relay-error') !== 'true', 'T09_HTTP_OR_RELAY')
    check(result.response.status === expectedStatus, 'T09_HTTP_STATUS')
    let raw: unknown = result.data
    if (result.error) {
      try {
        raw = await result.response.json()
      } catch {
        check(false, 'T09_HTTP_BODY')
      }
    }
    const body = envelope(raw)
    privateData(body)
    if (expectedStatus === 200) check(!result.error && body.error === null, 'T09_HTTP_SUCCESS')
    else {check(
        body.data === null && keys(body.error, ['code', 'message', 'details']) &&
          body.error.code === expectedCode && typeof body.error.message === 'string' &&
          body.error.details === null,
        'T09_EXPECTED_HANDLER_ERROR',
      )}
    await session(actor)
    return body.data
  }
  async function observe(expected?: [boolean, boolean]) {
    const current = await snapshot()
    assertVoteProtected(baseline, current, actors.map((a) => a.hash))
    if (expected) {
      check(
        current.votes.length === expected.filter(Boolean).length &&
          actors.every((a, i) => current.votes.some((v) => v.userHash === a.hash) === expected[i]),
        'T09_EXPECTED_EXACT_TUPLES',
      )
    }
    return current
  }
  async function checkpoint(stage: VoteEvent['stage'], expected?: [boolean, boolean]) {
    const current = await observe(expected)
    for (const actor of actors) {
      for (const target of current.posts) {
        const post = publicPost(await invoke(actor, 'getPost', { postId: target.id }))
        check(
          post.id === target.id && post.upvoteCount === target.voteCount &&
            post.commentCount === target.visibleCount &&
            post.hasUpvoted ===
              current.votes.some((v) => v.postId === target.id && v.userHash === actor.hash) &&
            post.isMine === (target.authorHash === actor.hash),
          'T09_C7_DETAIL_CALLER_STATE',
        )
      }
      const page = await invoke(actor, 'listPosts', { sort: 'NEW', tag: null, cursor: null, limit: 20 })
      check(
        keys(page, ['items', 'nextCursor']) && Array.isArray(page.items) && page.items.length === 2 &&
          page.nextCursor === null,
        'T09_C7_FEED_SHAPE',
      )
      const seen = new Set<string>()
      for (const item of page.items) {
        const post = publicPost(item), db = current.posts.find((p) => p.id === post.id)
        check(
          db && !seen.has(post.id) && post.upvoteCount === db.voteCount &&
            post.commentCount === db.visibleCount && post.isMine === (db.authorHash === actor.hash) &&
            post.hasUpvoted === current.votes.some((v) => v.postId === post.id && v.userHash === actor.hash),
          'T09_C7_FEED_CALLER_STATE',
        )
        seen.add(post.id)
      }
    }
    check(
      JSON.stringify(await observe(expected)) === JSON.stringify(current),
      'T09_SNAPSHOT_CHANGED_DURING_READS',
    )
    journal!.events.push({ stage, phase: 'VERIFIED', snapshot: current })
    journal!.uncertain = false
    await persist()
    report(
      `PASS: T09_${stage}_SQL_AND_C7; votes=${current.votes.length}; count=${
        current.posts.find((p) => p.id === approvedVotePost)!.upvoteCount
      }.`,
    )
    return current
  }
  async function batch(
    stage: VoteEvent['stage'],
    inputs: [Label, boolean][],
    expected?: [boolean, boolean],
    drop = false,
  ) {
    const requests = inputs.map(([actor, desiredState]) => ({ seq: ++seq, actor, desiredState }))
    journal!.status = 'RUNNING'
    journal!.uncertain = true
    journal!.events.push({ stage, phase: 'INTENT', requests })
    await persist()
    scope.permits = structuredClone(requests)
    scope.dropSeq = drop ? requests[0].seq : null
    scope.dropped = false
    const settled = await Promise.allSettled(requests.map(async (request) => {
      const actor = actors.find((a) => a.label === request.actor)!
      if (drop) {
        // SDK nhận lỗi giả sau HTTP200 đã kiểm tra, không giả vờ đây là timeout mạng thật.
        const result = await actor.client.functions.invoke('social-api', {
          body: {
            action: 'toggleUpvote',
            payload: { postId: config.postId, desiredState: request.desiredState },
          },
          headers: { Authorization: `Bearer ${actor.identity.accessToken}` },
          timeout: 15_000,
        })
        check(
          scope.dropped && result.response?.status === 503 && !!result.error,
          'T09_CONTROLLED_ACK_NOT_DROPPED',
        )
        await session(actor)
        journal!.events.push({ stage, phase: 'DROPPED', seq: request.seq, http: 200 })
      } else {
        const data = upvoteData(
          await invoke(actor, 'toggleUpvote', { postId: config.postId, desiredState: request.desiredState }),
        )
        if (stage === 'C5') check(data.upvoteCount === Number(data.hasUpvoted), 'T09_C5_RESPONSE_SNAPSHOT')
        else {
          check(data.hasUpvoted === request.desiredState, 'T09_RESPONSE_CALLER_STATE')
          const range = stage === 'C3' ? [1, 2] : stage === 'C4' ? [0, 1] : [Number(request.desiredState)]
          check(range.includes(data.upvoteCount), 'T09_RESPONSE_COUNT_RANGE')
        }
        journal!.events.push({ stage, phase: 'ACK', seq: request.seq, http: 200, result: data })
      }
      await persist()
    }))
    scope.permits = []
    scope.dropSeq = null
    check(settled.every((r) => r.status === 'fulfilled'), 'T09_BATCH_FAILED_OR_UNCERTAIN_NO_REPLAY')
    await checkpoint(stage, expected)
  }
  try {
    await store.acquire(runId)
    await project()
    baseline = await snapshot()
    assertVoteBaseline(baseline)
    report(`Baseline: users=2; profiles=2; roles=0; posts=2; comments=3; visible=2; deleted=1; votes=0.`)
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
      const hash = identityHash(verified.user.id)
      check(
        !actors.some((a) => a.hash === hash) &&
          baseline.owners.some((p) => p.hash === hash && p.status === 'ACTIVE'),
        'T09_EXISTING_ACTIVE_DIFFERENT_ACCOUNTS',
      )
      actors.push({
        label,
        hash,
        client,
        identity: { email, userId: verified.user.id, accessToken: verified.access_token },
      })
      email = ''
      scope.tokens.set(verified.access_token, label)
    }
    check(JSON.stringify(await snapshot()) === JSON.stringify(baseline), 'T09_BASELINE_CHANGED_BEFORE_API')
    const record: VoteInventory = {
      version: 1,
      projectRef: t04ProjectRef,
      runId,
      postId: approvedVotePost,
      mode: config.mode,
      baseline,
      actors: { A: actors[0].hash, B: actors[1].hash },
    }
    journal = { inventory: record, status: 'PREPARED', uncertain: false, events: [] }
    await store.begin(record)
    await checkpoint('C7', [false, false])
    for (const actor of actors) await runGetMeChecks(actor.client, config, actor.identity, report, guard)
    await invoke(actors[0], 'getPost', { postId: 'not-a-uuid' }, 400, 'VALIDATION_ERROR')
    const missing = '00000000-0000-4000-8000-000000000000'
    check(!baseline.posts.some((p) => p.id === missing), 'T09_MISSING_POST_PRECONDITION')
    await invoke(actors[0], 'getPost', { postId: missing }, 404, 'NOT_FOUND')
    await checkpoint('C8', [false, false])
    if (config.mode === '--write') {
      // SQL/DTO checkpoints hoàn tất trước khi mở intent batch kế tiếp.
      await batch('C1', [['A', true], ['A', true], ['A', true]], [true, false])
      await batch('C2', [['A', false], ['A', false], ['A', false]], [false, false])
      await batch('C3', [['A', true], ['B', true]], [true, true])
      await batch('C4', [['A', false], ['B', false]], [false, false])
      await batch('C5', [['A', true], ['A', false]])
      // Setup C6 để chứng minh tăng 0→1, không phải cleanup cuối run.
      await batch('C6_PREPARE', [['A', false]], [false, false])
      await batch('C6_LOST', [['A', true]], [true, false], true)
      await batch('C6_RETRY', [['A', true]], [true, false])
    }
    await checkpoint('FINISH', config.mode === '--write' ? [true, false] : [false, false])
  } catch (error) {
    failure = error instanceof ManualAuthError
      ? error
      : new ManualAuthError('FAIL: T09_IO_OR_SDK. Không in lỗi/response thô.')
  } finally {
    scope.permits = []
    for (const client of clients) {
      try {
        const out = await client.auth.signOut({ scope: 'local' }), current = await client.auth.getSession()
        check(!out.error && !current.error && current.data.session === null, 'T09_LOGOUT_SESSION')
      } catch {
        failure ??= new ManualAuthError('FAIL: T09_LOGOUT_SESSION.')
      }
    }
    if (journal && !failure) {
      try {
        const afterLogout = await observe(config.mode === '--write' ? [true, false] : [false, false])
        check(
          JSON.stringify(afterLogout) === JSON.stringify(
            journal.events.findLast((e) => e.phase === 'VERIFIED')?.snapshot,
          ),
          'T09_POST_LOGOUT_SQL_DRIFT',
        )
        report('PASS: T09_POST_LOGOUT_SQL_UNCHANGED; session local null.')
      } catch {
        journal.uncertain = config.mode === '--write'
        failure = new ManualAuthError('FAIL: T09_POST_LOGOUT_SQL_DRIFT_OR_IO.')
      }
    }
    if (journal) {
      if (failure) {
        journal.status = 'FAILED'
        // Nếu checkpoint chưa rõ/IO lỗi, không xóa uncertain hoặc tự replay.
        journal.events.push({ stage: 'FINISH', phase: 'FAILED' })
      } else journal.status = config.mode === '--smoke' ? 'COMPLETED' : 'AWAITING_CLEANUP'
      try {
        await persist()
      } catch {
        failure ??= new ManualAuthError('FAIL: T09_JOURNAL_IO_REVIEW_REQUIRED.')
      }
    }
    try {
      await store.release()
    } catch {
      failure ??= new ManualAuthError('FAIL: T09_SCOPE_LOCK_REVIEW_REQUIRED.')
    }
  }
  if (journal) {
    report(
      `Artifacts: supabase/.temp/t09-votes/${runId}.{json,verify.sql,cleanup.sql,journal.json}; uncertain=${journal.uncertain}.`,
    )
  }
  if (failure) throw failure
  report(
    config.mode === '--smoke'
      ? 'PASS: T09 --smoke; NO_BUSINESS_WRITES; baseline trước/sau giống nhau; logout local null.'
      : 'PASS: T09 WRITE_API_SQL_CHECKS; còn một vote A; AWAITING_CLEANUP, cần review/phê duyệt riêng; không tự cleanup.',
  )
  return journal!
}
