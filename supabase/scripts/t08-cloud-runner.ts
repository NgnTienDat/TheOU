import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { ManualAuthError, normalizeOuEmail, parsePassword } from './auth-helpers.ts'
import { requireVerifiedSession } from './auth-manual-flow.ts'
import { runGetMeChecks, type SocialApiIdentity } from './social-api-manual.ts'
import { publicPost, readT06Config } from './t06-cloud-runner.ts'
import { check } from './t06-cloud-inventory.ts'
import { t04ProjectRef, uuidPattern } from './t04-cloud-recovery.ts'
import {
  type CommentBaseline,
  type CommentFixture,
  type CommentInventory,
  type CommentInventoryStore,
  validateBaseline,
  validateCommentInventory,
} from './t08-cloud-inventory.ts'
import type { CommentPublic } from '../functions/social-api/modules/comments/comment-mapper.ts'
import type { CommentDeleteJournal, CommentDeleteStore, DeleteStage } from './t08-cloud-delete.ts'

export const digest = (value: string) => createHash('md5').update(value).digest('hex')
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
function keys(
  value: unknown,
  names: string[],
): value is Record<string, unknown> {
  return object(value) &&
    Object.keys(value).sort().join(',') === [...names].sort().join(',')
}
export function confirmT08Project(value: unknown) {
  const projects = object(value) ? value.projects : null
  check(
    Array.isArray(projects) &&
      projects.some((p) =>
        object(p) && p.id === t04ProjectRef && p.ref === t04ProjectRef &&
        p.name === 'TheOU-dev' && p.linked === true && p.status === 'ACTIVE_HEALTHY'
      ),
    'T08_LIVE_PROJECT_NAME_REF',
  )
}
export function readT08Config(
  env: NodeJS.ProcessEnv,
  linkedRef: string,
  args: string[],
) {
  check(
    args.length === 1 && ['--smoke', '--write'].includes(args[0]) ||
      args.length === 2 && ['--resume-read', '--resume-delete'].includes(args[0]) &&
        /^[a-f0-9]{32}$/.test(args[1]),
    'T08_ARGS_SMOKE_WRITE_OR_RESUME',
  )
  // T06 auth/ref/key validation, without inheriting the T06 write approval.
  const config = readT06Config(env, linkedRef, ['--smoke'])
  if (args[0] === '--write') {
    check(
      env.THEOU_ALLOW_T08_CLOUD_WRITES === 'theou-dev',
      'T08_WRITE_APPROVAL_REQUIRED',
    )
  }
  if (args[0] === '--resume-delete') {
    check(env.THEOU_ALLOW_T08_RESUME_DELETES === 'theou-dev', 'T08_RESUME_DELETE_APPROVAL_REQUIRED')
  }
  return {
    ...config,
    mode: args[0] as '--smoke' | '--write' | '--resume-read' | '--resume-delete',
    runId: args[0].startsWith('--resume-') ? args[1] : null,
  }
}
type Config = ReturnType<typeof readT08Config>
interface Actor {
  client: SupabaseClient
  identity: SocialApiIdentity
  hash: string
}
type Scope = {
  fixtures: CommentFixture[]
  dropKey: string | null
  dropped: boolean
}
export function guardT08Fetch(
  config: Config,
  scope: Scope,
  request: typeof fetch,
): typeof fetch {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input)),
      headers = new Headers(
        init?.headers ?? (input instanceof Request ? input.headers : undefined),
      )
    const method = init?.method ??
      (input instanceof Request ? input.method : 'GET')
    check(
      config.url === `https://${t04ProjectRef}.supabase.co` &&
        url.origin === config.url && !url.username && !url.password &&
        headers.get('apikey') === config.publishableKey &&
        config.publishableKey.startsWith('sb_publishable_'),
      'T08_REQUEST_TARGET_KEY',
    )
    const auth = url.pathname === '/auth/v1/user' && method === 'GET' ||
      url.pathname === '/auth/v1/token' && method === 'POST' &&
        url.searchParams.get('grant_type') === 'password' ||
      url.pathname === '/auth/v1/logout' && method === 'POST' &&
        url.searchParams.get('scope') === 'local'
    const api = url.pathname === '/functions/v1/social-api' &&
      method === 'POST'
    check(auth || api, 'T08_NO_ADMIN_RAW_TABLE_OR_OTHER_PATH')
    let body: Record<string, unknown> | undefined
    if (api) {
      try {
        body = JSON.parse(String(init?.body))
      } catch {
        check(false, 'T08_REQUEST_JSON')
      }
      check(
        object(body) && typeof body.action === 'string',
        'T08_REQUEST_ACTION',
      )
      const read = (config.mode.startsWith('--resume-')
        ? ['getMe', 'getPost', 'listComments']
        : ['getMe', 'getPost', 'listComments', '__t04_unknown__'])
        .includes(body.action)
      if (!read) {
        if (config.mode === '--resume-delete') {
          const payload = body.payload
          check(
            body.action === 'deleteComment' && keys(payload, ['commentId']) &&
              typeof payload.commentId === 'string' &&
              scope.fixtures.some((f) =>
                ['retry', 'parallel-b'].includes(f.label) &&
                f.ids.length === 1 && f.ids[0] === payload.commentId
              ),
            'T08_R2_DELETE_UUID_SCOPE',
          )
        } else {
          check(
            config.mode === '--write' && object(body.payload),
            'T08_SMOKE_NO_BUSINESS_WRITES',
          )
          const payload = body.payload
          check(
            body.action === 'createComment' &&
                scope.fixtures.some((f) =>
                  f.key === payload.idempotencyKey
                ) ||
              body.action === 'deleteComment' &&
                scope.fixtures.some((f) => f.ids.includes(String(payload.commentId))),
            'T08_WRITE_FIXTURE_SCOPE',
          )
        }
      }
    }
    let response: Response
    try {
      response = await request(input, {
        ...init,
        redirect: 'error',
        credentials: 'omit',
        signal: init?.signal
          ? AbortSignal.any([init.signal, AbortSignal.timeout(20_000)])
          : AbortSignal.timeout(20_000),
      })
    } catch {
      return Response.json({
        code: 'unexpected_failure',
        message: 'Network unavailable',
      }, { status: 503 })
    }
    if (
      api && body?.action === 'createComment' && object(body.payload) &&
      scope.dropKey === body.payload.idempotencyKey && response.status === 200
    ) {
      scope.dropKey = null
      scope.dropped = true
      // Mô phỏng mất ACK sau HTTP200, không đọc/ghi UUID từ response; retry phải tìm lại đúng row.
      await response.body?.cancel()
      return Response.json({
        code: 'unexpected_failure',
        message: 'Response deliberately discarded',
      }, { status: 503 })
    }
    return response
  }
}
export function publicComment(value: unknown): CommentPublic {
  check(
    keys(value, [
      'id',
      'postId',
      'body',
      'authorLabel',
      'isOriginalPoster',
      'isMine',
      'createdAt',
    ]) &&
      typeof value.id === 'string' && uuidPattern.test(value.id) &&
      typeof value.postId === 'string' && uuidPattern.test(value.postId) &&
      typeof value.body === 'string' && [...value.body].length >= 1 &&
      [...value.body].length <= 500 &&
      typeof value.isMine === 'boolean' &&
      typeof value.isOriginalPoster === 'boolean' &&
      value.authorLabel ===
        (value.isOriginalPoster ? 'Chủ bài' : 'OUer ẩn danh') &&
      typeof value.createdAt === 'string' &&
      /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?Z$/.test(value.createdAt) &&
      Number.isFinite(Date.parse(value.createdAt)),
    'COMMENT_PUBLIC_ALLOWLIST',
  )
  return value as unknown as CommentPublic
}
function micros(value: string) {
  return BigInt(Date.parse(value.slice(0, 19) + 'Z')) * 1000n +
    BigInt((value.split('.')[1]?.slice(0, -1) ?? '').padEnd(6, '0') || '0')
}
function ordered(a: CommentPublic, b: CommentPublic) {
  return micros(a.createdAt) < micros(b.createdAt) ||
    micros(a.createdAt) === micros(b.createdAt) && a.id < b.id
}
export function protectedComments(
  before: CommentBaseline,
  after: CommentBaseline,
) {
  validateBaseline(after)
  check(
    before.users === after.users && before.profiles === after.profiles &&
      before.roles === after.roles &&
      before.profileHash === after.profileHash &&
      before.roleHash === after.roleHash &&
      before.posts.length === after.posts.length,
    'PROTECTED_ACCOUNTS_PROFILES_ROLES_POSTS',
  )
  for (const post of before.posts) {
    check(
      after.posts.some((p) => p.id === post.id && p.immutableHash === post.immutableHash),
      'PROTECTED_POST_CHANGED',
    )
  }
  for (const comment of before.comments) {
    check(
      after.comments.some((c) => c.id === comment.id && c.rowHash === comment.rowHash),
      'PROTECTED_COMMENT_CHANGED',
    )
  }
}

export function verifyCommentFixtures(record: CommentInventory, now: CommentBaseline) {
  const baseline = record.baseline
  protectedComments(baseline, now)
  const expected = record.fixtures.filter((f) => f.state !== 'pending')
  const extra = now.comments.filter((c) => !baseline.comments.some((old) => old.id === c.id))
  check(extra.length === expected.length, 'DB_UNEXPECTED_COMMENT_ROWS')
  for (const f of record.fixtures) {
    const rows = extra.filter((c) => c.keyHash === digest(f.key))
    check(rows.length === (f.state === 'pending' ? 0 : 1), 'DB_IDEMPOTENCY_ROW_COUNT')
    for (const row of rows) {
      check(
        f.ids.length === 1 && f.ids[0] === row.id &&
          row.postId === f.postId && row.bodyHash === digest(f.body) &&
          row.authorHash === f.authorHash && row.status === f.state,
        'DB_FIXTURE_CONTENT_SCOPE_STATE',
      )
    }
  }
  for (const post of baseline.posts) {
    const current = now.posts.find((p) => p.id === post.id)!
    check(
      current.commentCount === post.commentCount +
          expected.filter((f) => f.postId === post.id && f.state === 'VISIBLE').length,
      'DB_ATOMIC_COUNT_BASELINE_DELTA',
    )
  }
}

function validateResume(record: CommentInventory, runId: string | null) {
  validateCommentInventory(record)
  check(record.runId === runId && record.mode === '--write', 'T08_RESUME_INVENTORY_RUN_ID')
  const op = record.baseline.comments.find((c) => c.status === 'VISIBLE')
  const post = record.baseline.posts.find((p) => p.id === op?.postId && p.authorHash === op.authorHash)
  const other = record.baseline.posts.find((p) => p.authorHash !== post?.authorHash)
  const labels = ['retry', 'same-key-race', 'parallel-a', 'parallel-b', 'lost', 'last-b']
  check(
    post && other && record.fixtures.length === labels.length &&
      labels.every((label) => record.fixtures.filter((f) => f.label === label).length === 1) &&
      record.fixtures.every((f) =>
        f.state === 'VISIBLE' && f.ids.length === 1 && f.postId === post.id &&
        f.authorHash === (['parallel-b', 'last-b'].includes(f.label) ? other.authorHash : post.authorHash)
      ),
    'T08_RESUME_SIX_VISIBLE_FIXTURES',
  )
}

export async function runT08Cloud(
  config: Config,
  env: NodeJS.ProcessEnv,
  askHidden: (prompt: string) => Promise<string>,
  store: CommentInventoryStore,
  readSnapshot: (expected?: CommentInventory | null) => Promise<CommentBaseline>,
  report: (line: string) => void,
  fetchRequest: typeof fetch = fetch,
  resume?: CommentInventory,
  deleteStore?: CommentDeleteStore,
) {
  const isDelete = config.mode === '--resume-delete'
  const isResume = config.mode.startsWith('--resume-')
  check(
    !isDelete || deleteStore && env.THEOU_ALLOW_T08_RESUME_DELETES === 'theou-dev',
    'T08_R2_STORE_AND_APPROVAL_REQUIRED',
  )
  check(isResume === !!resume, 'T08_RESUME_INVENTORY_REQUIRED')
  if (resume) validateResume(resume, config.runId)
  const initial = await readSnapshot()
  const baseline = resume?.baseline ?? initial
  validateBaseline(baseline)
  check(
    baseline.posts.length === 2 && baseline.comments.length === 2 &&
      baseline.comments.filter((c) => c.status === 'VISIBLE').length === 1 &&
      baseline.comments.filter((c) => c.status === 'DELETED').length === 1,
    'EXPECTED_TWO_POSTS_TWO_PROTECTED_COMMENTS',
  )
  const runId = resume?.runId ?? randomUUID().replaceAll('-', ''),
    record: CommentInventory = resume ? structuredClone(resume) : {
      projectRef: t04ProjectRef,
      runId,
      marker: `T08-CLOUD-TEST-${runId}`,
      mode: config.mode as '--smoke' | '--write',
      baseline,
      fixtures: [],
    }
  if (isResume) verifyCommentFixtures(record, initial)
  const scope: Scope = {
      fixtures: record.fixtures,
      dropKey: null,
      dropped: false,
    },
    guard = guardT08Fetch(config, scope, fetchRequest)
  const actors: Actor[] = [], clients: SupabaseClient[] = []
  let queue = Promise.resolve(), failure: unknown
  let deleteJournal: CommentDeleteJournal | undefined
  let deleteQueue = Promise.resolve()
  const saveDelete = () => {
    const copy = structuredClone(deleteJournal!)
    deleteQueue = deleteQueue.then(() => deleteStore!.save(copy))
    return deleteQueue
  }
  const deleteEvent = (event: CommentDeleteJournal['events'][number]) => {
    deleteJournal!.events.push(event)
    return saveDelete()
  }
  async function observeDeletes(stage: DeleteStage, expected?: CommentInventory) {
    const actual = await readSnapshot(null)
    const observed = structuredClone(resume!)
    for (const f of observed.fixtures) {
      if (['retry', 'parallel-b'].includes(f.label)) {
        const row = actual.comments.find((c) => c.id === f.ids[0])
        check(row && ['VISIBLE', 'DELETED'].includes(row.status), 'T08_R2_UNKNOWN_FIXTURE_STATE')
        f.state = row.status as 'VISIBLE' | 'DELETED'
      }
    }
    verifyCommentFixtures(observed, actual)
    const exact = await readSnapshot(observed)
    check(JSON.stringify(actual) === JSON.stringify(exact), 'T08_R2_OBSERVATION_CHANGED')
    verifyCommentFixtures(observed, exact)
    if (expected) check(JSON.stringify(observed) === JSON.stringify(expected), 'T08_R2_UNEXPECTED_STATE')
    // Ngoài hai target, toàn bộ row phải giữ nguyên từ snapshot R2 đầu tiên.
    const targets = observed.fixtures.filter((f) => ['retry', 'parallel-b'].includes(f.label)).flatMap((f) =>
      f.ids
    )
    check(
      initial.comments.filter((c) => !targets.includes(c.id)).every((c) =>
        exact.comments.some((now) => now.id === c.id && now.rowHash === c.rowHash)
      ),
      'T08_R2_OTHER_COMMENT_CHANGED',
    )
    await deleteEvent({ stage, phase: 'VERIFIED', observation: { inventory: observed, snapshot: exact } })
    return exact
  }
  const persist = () => {
    if (isResume) return Promise.resolve()
    const copy = structuredClone(record)
    queue = queue.then(() => store.save(copy))
    return queue
  }
  const pass = (stage: string) => report(`PASS: ${stage}.`)
  async function session(actor: Actor) {
    const r = await actor.client.auth.getSession()
    check(
      !r.error && r.data.session?.access_token === actor.identity.accessToken &&
        r.data.session.user.id === actor.identity.userId,
      'T08_SESSION_CHANGED',
    )
  }
  function privacy(value: unknown) {
    const text = JSON.stringify(value)?.toLowerCase() ?? ''
    check(
      !actors.some((a) =>
        [a.identity.email, a.identity.userId, a.identity.accessToken].some(
          (s) => text.includes(s.toLowerCase()),
        )
      ),
      'T08_PRIVATE_IDENTITY_RESPONSE',
    )
  }
  async function call(
    actor: Actor,
    action: string,
    payload: unknown,
    allowDropped = false,
  ) {
    await session(actor)
    const result = await actor.client.functions.invoke<unknown>('social-api', {
      body: { action, payload },
      headers: { Authorization: `Bearer ${actor.identity.accessToken}` },
      timeout: 20_000,
    })
    check(
      result.response &&
        result.response.headers.get('x-relay-error') !== 'true',
      'T08_API_NETWORK_RELAY',
    )
    let body: unknown
    try {
      body = result.error ? await result.response.clone().json() : result.data
    } catch {
      body = null
    }
    await session(actor)
    if (allowDropped && scope.dropped) {
      check(result.response.status === 503, 'T08_LOST_ACK_SIMULATION')
      return { status: 503, data: null, code: 'SIMULATED_LOSS' }
    }
    privacy(body)
    check(
      keys(body, ['data', 'error', 'meta']) && keys(body.meta, ['requestId']) &&
        typeof body.meta.requestId === 'string' &&
        uuidPattern.test(body.meta.requestId),
      'T08_API_ENVELOPE',
    )
    const codes = [
      'UNAUTHENTICATED',
      'FORBIDDEN',
      'VALIDATION_ERROR',
      'NOT_FOUND',
      'CONFLICT',
      'INTERNAL_ERROR',
    ]
    let code = 'OK'
    if (body.error !== null) {
      check(
        body.data === null &&
          keys(body.error, ['code', 'message', 'details']) &&
          typeof body.error.code === 'string' &&
          codes.includes(body.error.code) &&
          typeof body.error.message === 'string' &&
          body.error.details === null &&
          !/SQLSTATE|PGRST\d|stacktrace|service_role|\bselect\b.+\bfrom\b/i
            .test(body.error.message),
        'T08_API_SAFE_ERROR',
      )
      code = body.error.code
    }
    check(
      result.response.status < 500 && code !== 'INTERNAL_ERROR',
      `T08_API_SYSTEM_http=${result.response.status}_code=${code}`,
    )
    return { status: result.response.status, data: body.data, code }
  }
  async function ok(actor: Actor, action: string, payload: unknown) {
    const r = await call(actor, action, payload)
    check(r.status === 200 && r.code === 'OK', `T08_EXPECTED_OK_${action}`)
    return r.data
  }
  async function denied(
    actor: Actor,
    action: string,
    payload: unknown,
    status: number,
    code: string,
  ) {
    const r = await call(actor, action, payload)
    check(
      r.status === status && r.code === code,
      `T08_EXPECTED_DENIAL_${action}`,
    )
  }
  async function page(
    actor: Actor,
    postId: string,
    cursor: string | null = null,
    limit = 2,
  ) {
    const data = await ok(actor, 'listComments', { postId, cursor, limit })
    check(
      keys(data, ['items', 'nextCursor']) && Array.isArray(data.items) &&
        data.items.length <= limit &&
        (data.nextCursor === null ||
          typeof data.nextCursor === 'string' && data.nextCursor.length > 0 &&
            data.nextCursor.length <= 1024),
      'T08_PAGE_SHAPE',
    )
    const items = data.items.map(publicComment)
    check(items.every((c) => c.postId === postId), 'T08_COMMENT_PARENT')
    for (let i = 1; i < items.length; i++) {
      check(ordered(items[i - 1], items[i]), 'T08_ASC_ORDER')
    }
    check(
      items.length > 0 || data.nextCursor === null,
      'T08_EMPTY_PAGE_CURSOR',
    )
    if (data.nextCursor) {
      let claims: unknown
      try {
        claims = JSON.parse(
          Buffer.from(String(data.nextCursor).split('.')[0], 'base64url')
            .toString('utf8'),
        )
      } catch {
        claims = null
      }
      check(
        keys(claims, ['v', 'kind', 'postId', 'asOf', 'createdAt', 'id']) &&
          claims.v === 1 && claims.kind === 'comments' &&
          claims.postId === postId &&
          Number.isSafeInteger(claims.asOf) && typeof claims.id === 'string' &&
          claims.id === items.at(-1)?.id &&
          typeof claims.createdAt === 'string' &&
          // Mapper chuẩn hóa UTC; giữ nguyên microseconds khi đối chiếu tuple cursor.
          claims.createdAt.replace('+00:00', 'Z') === items.at(-1)?.createdAt,
        'T08_CURSOR_PRIVACY_SHAPE',
      )
      privacy(claims)
    }
    return { items, nextCursor: data.nextCursor as string | null }
  }
  async function all(actor: Actor, postId: string) {
    const items: CommentPublic[] = []
    let cursor: string | null = null
    let firstCursor: string | null = null
    for (let n = 0; n < 100; n++) {
      const p = await page(actor, postId, cursor, 1)
      for (const c of p.items) {
        check(
          !items.some((i) => i.id === c.id) &&
            (!items.length || ordered(items.at(-1)!, c)),
          'T08_KEYSET_DUPLICATE_OR_ORDER',
        )
        items.push(c)
      }
      firstCursor ??= p.nextCursor
      if (!p.nextCursor) return { items, firstCursor }
      check(p.nextCursor !== cursor, 'T08_CURSOR_NO_PROGRESS')
      cursor = p.nextCursor
    }
    throw new ManualAuthError('FAIL: T08_PAGINATION_LIMIT.')
  }
  async function verifyWrites() {
    const now = await readSnapshot()
    verifyCommentFixtures(record, now)
    pass('DB_KEYS_COUNTS_STATES_AND_PROTECTED_DATA')
  }
  try {
    if (isDelete) {
      deleteJournal = await deleteStore!.begin(record)
      await observeDeletes('PREPARE', record)
    }
    await persist()
    report(
      `Baseline: users=${baseline.users}; profiles=${baseline.profiles}; roles=${baseline.roles}; posts=${baseline.posts.length}; comments=${baseline.comments.length}; visible=1; deleted=1.`,
    )
    for (const label of ['A', 'B']) {
      let email = normalizeOuEmail(
        env[`THEOU_T06_EMAIL_${label}`] ||
          await askHidden(`Email OU ${label} đã tồn tại (ẩn): `),
      )
      let password = parsePassword(
        env[`THEOU_T06_PASSWORD_${label}`] ||
          await askHidden(`Mật khẩu ${label} (ẩn): `),
        'login',
      )
      check(
        !actors.some((a) => a.identity.email === email),
        'T08_ACCOUNTS_DIFFER',
      )
      const client = createClient(config.url, config.publishableKey, {
        global: { fetch: guard },
        auth: {
          persistSession: false,
          autoRefreshToken: false,
          detectSessionInUrl: false,
        },
      })
      clients.push(client)
      const authenticated = await requireVerifiedSession(
        client.auth,
        await client.auth.signInWithPassword({ email, password }),
        email,
      )
      password = ''
      const authorHash = digest(authenticated.user.id)
      check(
        !actors.some((a) => a.hash === authorHash) &&
          baseline.profileOwners.some((p) => p.authorHash === authorHash && p.status === 'ACTIVE'),
        'T08_EXISTING_ACTIVE_PROFILE_REQUIRED',
      )
      actors.push({
        client,
        hash: authorHash,
        identity: {
          email,
          userId: authenticated.user.id,
          accessToken: authenticated.access_token,
        },
      })
      email = ''
      pass(`LOGIN_CREDENTIAL_${label}_OU_CONFIRMED`)
    }
    // A là chủ bài có comment OP; suffix credentials T06 không quyết định nhãn scenario T08.
    const visible = baseline.comments.find((c) => c.status === 'VISIBLE')!
    const postA = baseline.posts.find((p) => p.id === visible.postId && p.authorHash === visible.authorHash)
    const a = actors.find((actor) => actor.hash === postA?.authorHash)
    const b = actors.find((actor) => actor !== a)
    const postB = baseline.posts.find((p) => p.authorHash === b?.hash)
    check(
      a && b && postA && postB && postA.id !== postB.id,
      'T08_EXISTING_POST_OWNERS_A_B',
    )
    check(
      baseline.comments.every((c) => c.postId === postA.id) &&
        baseline.comments.some((c) => c.status === 'VISIBLE' && c.authorHash === a.hash) &&
        postA.commentCount === 1 && postB.commentCount === 0,
      'T08_EXISTING_COMMENT_BASELINE',
    )
    let signedCursorObserved = false
    pass('TEST_ACTORS_A_OP_AND_B_RESOLVED_FROM_OWNERSHIP')
    if (isResume) {
      pass('RESUME_SQL_SIX_VISIBLE_KEYS_UUIDS_SCOPE_COUNTS_PROTECTED_DATA')
      report(
        `Resume snapshot: users=${initial.users}; profiles=${initial.profiles}; roles=${initial.roles}; posts=${initial.posts.length}; comments=${initial.comments.length}; visible=${
          initial.comments.filter((c) => c.status === 'VISIBLE').length
        }; deleted=${
          initial.comments.filter((c) => c.status === 'DELETED').length
        }; fixtures=6 VISIBLE; count_mismatches=0.`,
      )
      for (const [index, actor] of [a, b].entries()) {
        const me = await ok(actor, 'getMe', {})
        check(
          keys(me, ['nickname', 'emailMasked', 'isAdmin']) && typeof me.nickname === 'string' &&
            me.nickname.length >= 3 && me.nickname.length <= 30 &&
            me.emailMasked === '***@ou.edu.vn' && typeof me.isAdmin === 'boolean',
          'T08_RESUME_GETME',
        )
        for (const post of initial.posts) {
          const data = publicPost(await ok(actor, 'getPost', { postId: post.id }))
          check(
            data.id === post.id && data.isMine === (post.authorHash === actor.hash) &&
              data.commentCount === post.commentCount,
            'T08_GET_POST_REGRESSION',
          )
          const listed = await all(actor, post.id)
          const expected = initial.comments.filter((c) => c.postId === post.id && c.status === 'VISIBLE')
          check(
            listed.items.length === expected.length &&
              expected.every((c) => listed.items.some((i) => i.id === c.id)),
            'T08_LIST_VISIBLE_ONLY',
          )
          for (const item of listed.items) {
            const row = expected.find((c) => c.id === item.id)!
            check(
              item.isMine === (row.authorHash === actor.hash) &&
                item.isOriginalPoster === (row.authorHash === post.authorHash) &&
                digest(item.body) === row.bodyHash,
              'T08_CALLER_OP_ISMINE',
            )
          }
          if (listed.firstCursor) {
            await denied(
              actor,
              'listComments',
              {
                postId: post.id === postA.id ? postB.id : postA.id,
                cursor: listed.firstCursor,
                limit: 1,
              },
              400,
              'VALIDATION_ERROR',
            )
            signedCursorObserved = true
          }
        }
        pass(`RESUME_${index === 0 ? 'A' : 'B'}_LIMIT1_PAGINATION_CURSOR_PRIVACY_OP_ISMINE`)
      }
      check(signedCursorObserved, 'T08_RESUME_REAL_SIGNED_CURSOR_REQUIRED')
      pass('RESUME_REAL_SIGNED_CURSOR_CROSS_POST_DENIED_400')
      const after = await readSnapshot()
      verifyCommentFixtures(record, after)
      check(JSON.stringify(initial) === JSON.stringify(after), 'T08_RESUME_BUSINESS_SNAPSHOT_CHANGED')
      pass('RESUME_SQL_BEFORE_AFTER_IDENTICAL_NO_BUSINESS_WRITES')
      if (isDelete) {
        deleteJournal!.status = 'RUNNING'
        const expected = structuredClone(record)
        const retry = expected.fixtures.find((f) => f.label === 'retry')!
        const pb = expected.fixtures.find((f) => f.label === 'parallel-b')!
        async function group(
          stage: DeleteStage,
          actor: Actor,
          fixture: CommentFixture,
          count: number,
          denial = false,
        ) {
          const before = await observeDeletes('PREPARE', expected)
          await deleteEvent({ stage, phase: 'INTENT' })
          deleteJournal!.uncertain = true
          await saveDelete()
          const results = await Promise.allSettled(Array.from({ length: count }, async () => {
            const r = await call(actor, 'deleteComment', { commentId: fixture.ids[0] })
            check(
              denial
                ? r.status === 404 && r.code === 'NOT_FOUND'
                : r.status === 200 && r.code === 'OK' && keys(r.data, ['success']) && r.data.success === true,
              'T08_R2_DELETE_RESPONSE',
            )
            await deleteEvent({ stage, phase: 'ACK', http: r.status, code: denial ? 'NOT_FOUND' : 'OK' })
          }))
          check(results.every((r) => r.status === 'fulfilled'), 'T08_R2_REQUEST_UNRESOLVED_NO_REPLAY')
          if (!denial) fixture.state = 'DELETED'
          const after = await observeDeletes(stage, expected)
          check(
            denial
              ? JSON.stringify(before) === JSON.stringify(after)
              : before.comments.filter((c) => c.id !== fixture.ids[0]).every((c) =>
                after.comments.some((now) => now.id === c.id && now.rowHash === c.rowHash)
              ),
            'T08_R2_GROUP_OTHER_ROWS_CHANGED',
          )
          deleteJournal!.uncertain = false
          await saveDelete()
          pass(`R2_${stage}_API_AND_SQL`)
        }
        await group('CROSS_B_RETRY', b, retry, 1, true)
        await group('CROSS_A_PARALLEL_B', a, pb, 1, true)
        await group('RACE_RETRY', a, retry, 3)
        await group('OWN_PARALLEL_B', b, pb, 1)
        const beforeReplay = await readSnapshot(expected)
        await group('REPLAY_PARALLEL_B', b, pb, 1)
        const afterReplay = await readSnapshot(expected)
        check(JSON.stringify(beforeReplay) === JSON.stringify(afterReplay), 'T08_R2_REPLAY_CHANGED_ROWS')
        for (const actor of [a, b]) {
          const listed = await all(actor, postA.id)
          check(
            listed.items.length === 5 && !listed.items.some((c) =>
              [
                retry.ids[0],
                pb.ids[0],
                ...baseline.comments.filter((c) => c.status === 'DELETED').map((c) => c.id),
              ].includes(c.id)
            ),
            'T08_R2_DELETED_VISIBLE',
          )
        }
        await observeDeletes('FINISH', expected)
        pass('R2_FINAL_SQL_POSTS2_COMMENTS8_VISIBLE5_DELETED3_COUNTS5_0')
      }
    } else {
      for (const [index, actor] of [a, b].entries()) {
        await runGetMeChecks(actor.client, config, actor.identity, report, guard)
        for (const post of baseline.posts) {
          const data = publicPost(
            await ok(actor, 'getPost', { postId: post.id }),
          )
          check(
            data.id === post.id &&
              data.isMine === (post.authorHash === actor.hash) &&
              data.commentCount === post.commentCount,
            'T08_GET_POST_REGRESSION',
          )
          const listed = await all(actor, post.id),
            expected = baseline.comments.filter((c) => c.postId === post.id && c.status === 'VISIBLE')
          check(
            listed.items.length === expected.length &&
              expected.every((c) => listed.items.some((i) => i.id === c.id)),
            'T08_LIST_VISIBLE_ONLY',
          )
          for (const item of listed.items) {
            const row = expected.find((c) => c.id === item.id)!
            check(
              item.isMine === (row.authorHash === actor.hash) &&
                item.isOriginalPoster === (row.authorHash === post.authorHash) &&
                digest(item.body) === row.bodyHash,
              'T08_CALLER_OP_ISMINE',
            )
          }
          if (listed.firstCursor) {
            await denied(
              actor,
              'listComments',
              {
                postId: post.id === postA.id ? postB.id : postA.id,
                cursor: listed.firstCursor,
                limit: 1,
              },
              400,
              'VALIDATION_ERROR',
            )
            signedCursorObserved = true
          }
        }
        await denied(
          actor,
          'listComments',
          { postId: postA.id, cursor: 'invalid', limit: 1 },
          400,
          'VALIDATION_ERROR',
        )
        const forged = Buffer.from(
          JSON.stringify({
            v: 1,
            kind: 'comments',
            postId: postB.id,
            asOf: Date.now(),
            createdAt: new Date().toISOString(),
            id: randomUUID(),
          }),
        ).toString('base64url') + '.' + randomBytes(32).toString('base64url')
        await denied(
          actor,
          'listComments',
          { postId: postA.id, cursor: forged, limit: 1 },
          400,
          'VALIDATION_ERROR',
        )
        for (
          const payload of [null, { postId: postA.id, cursor: null, limit: 21 }, {
            postId: 'bad',
            cursor: null,
            limit: 1,
          }, {
            postId: postA.id,
            cursor: null,
            limit: 1,
            authorId: actor.identity.userId,
          }]
        ) await denied(actor, 'listComments', payload, 400, 'VALIDATION_ERROR')
        await denied(
          actor,
          'listComments',
          { postId: randomUUID(), cursor: null, limit: 1 },
          404,
          'NOT_FOUND',
        )
        pass(
          `SMOKE_${index === 0 ? 'A' : 'B'}_GETME_GETPOST_COMMENTS_PRIVACY_OP_ISMINE_JWT_VALIDATION`,
        )
      }
      const afterSmoke = await readSnapshot()
      protectedComments(baseline, afterSmoke)
      check(
        JSON.stringify(baseline) === JSON.stringify(afterSmoke),
        'T08_SMOKE_BUSINESS_BASELINE_CHANGED',
      )
      pass('SMOKE_POSTS_COMMENTS_PROFILES_ROLES_UNCHANGED_SQL')
      if (!signedCursorObserved) {
        report(
          'NOT TESTED: SIGNED_CURSOR_WRONG_POST; một VISIBLE chưa phát hành cursor; forged/cross-post claims đã bị từ chối, chưa chứng minh binding bằng cursor thật.',
        )
      }
      if (config.mode === '--write') {
        check(
          env.THEOU_ALLOW_T08_CLOUD_WRITES === 'theou-dev',
          'T08_WRITE_APPROVAL_REQUIRED',
        )
        for (
          const [label, actor] of [
            ['retry', a],
            ['same-key-race', a],
            ['parallel-a', a],
            ['parallel-b', b],
            ['lost', a],
            ['last-b', b],
          ] as const
        ) {
          record.fixtures.push({
            label,
            key: randomUUID(),
            body: `${record.marker} ${label}`,
            postId: postA.id,
            authorHash: actor.hash,
            ids: [],
            state: 'pending',
          })
        }
        await persist()
        const [retry, race, pa, pb, lost, last] = record.fixtures
        const payload = (f: CommentFixture) => ({
          postId: f.postId,
          body: f.body,
          idempotencyKey: f.key,
        })
        async function create(actor: Actor, f: CommentFixture) {
          await persist()
          const data = await ok(actor, 'createComment', payload(f))
          // Ghi UUID ACK trước các assertions nghiệp vụ; không bao giờ nhận UUID comment cũ.
          if (
            object(data) && typeof data.id === 'string' &&
            uuidPattern.test(data.id) && !baseline.comments.some((c) => c.id === data.id)
          ) {
            if (!f.ids.includes(data.id)) f.ids.push(data.id)
            f.state = 'VISIBLE'
            await persist()
          }
          const c = publicComment(data)
          check(
            c.postId === f.postId && c.body === f.body && c.isMine &&
              c.isOriginalPoster === (actor === a) && f.ids.length === 1,
            'T08_CREATE_ACK_SCOPE',
          )
          return c
        }
        async function together(tasks: Promise<unknown>[]) {
          const results = await Promise.allSettled(tasks)
          check(
            results.every((r) => r.status === 'fulfilled'),
            'T08_CONCURRENT_REQUEST_FAILED',
          )
          return results
        }
        await create(a, retry)
        await create(a, retry)
        await verifyWrites()
        await denied(
          a,
          'createComment',
          { ...payload(retry), body: retry.body + ' changed' },
          409,
          'CONFLICT',
        )
        await denied(
          a,
          'createComment',
          { ...payload(retry), postId: postB.id },
          409,
          'CONFLICT',
        )
        await together([create(a, race), create(a, race), create(a, race)])
        await verifyWrites()
        pass('IDEMPOTENT_CREATE_AND_SAME_KEY_CONCURRENCY_API_DB')
        await denied(
          b,
          'createComment',
          { ...payload(last), postId: randomUUID() },
          404,
          'NOT_FOUND',
        )
        for (
          const fake of [{ authorId: b.identity.userId }, { role: 'ADMIN' }, {
            status: 'VISIBLE',
          }]
        ) {
          await denied(
            a,
            'createComment',
            { ...payload(retry), ...fake },
            400,
            'VALIDATION_ERROR',
          )
        }
        await together([create(a, pa), create(b, pb), create(b, last)])
        await verifyWrites()
        pass('DISTINCT_KEYS_CONCURRENT_CREATE_API_DB')
        await persist()
        scope.dropKey = lost.key
        const dropped = await call(a, 'createComment', payload(lost), true)
        check(
          scope.dropped && dropped.code === 'SIMULATED_LOSS',
          'T08_ACK_WAS_NOT_DISCARDED',
        )
        await create(a, lost)
        await verifyWrites()
        pass('SIMULATED_LOST_ACK_RETRY_ONE_ROW_API_DB')
        for (const actor of actors) {
          const listed = await all(actor, postA.id)
          check(listed.firstCursor, 'T08_REAL_CURSOR_REQUIRED')
          await denied(
            actor,
            'listComments',
            { postId: postB.id, cursor: listed.firstCursor, limit: 1 },
            400,
            'VALIDATION_ERROR',
          )
          for (const f of record.fixtures) {
            const c = listed.items.find((c) => c.id === f.ids[0])
            check(
              c && c.isMine === (f.authorHash === actor.hash) &&
                c.isOriginalPoster === (f.authorHash === a.hash),
              'T08_WRITE_PRIVACY_CALLER_LABEL',
            )
          }
        }
        pass('REAL_KEYSET_ASC_CURSOR_BINDING_AND_A_B_PRIVACY')
        await denied(
          b,
          'deleteComment',
          { commentId: retry.ids[0] },
          404,
          'NOT_FOUND',
        )
        await denied(
          a,
          'deleteComment',
          { commentId: pb.ids[0] },
          404,
          'NOT_FOUND',
        )
        const remove = async (actor: Actor, f: CommentFixture) => {
          const data = await ok(actor, 'deleteComment', { commentId: f.ids[0] })
          check(
            keys(data, ['success']) && data.success === true,
            'T08_DELETE_ACK',
          )
        }
        await together([remove(a, retry), remove(a, retry), remove(a, retry)])
        retry.state = 'DELETED'
        await persist()
        await verifyWrites()
        await remove(b, pb)
        pb.state = 'DELETED'
        await persist()
        await verifyWrites()
        await denied(a, 'createComment', payload(retry), 409, 'CONFLICT')
        for (const actor of actors) {
          const listed = await all(actor, postA.id)
          check(
            !listed.items.some((c) =>
              [
                retry.ids[0],
                pb.ids[0],
                ...baseline.comments.filter((c) => c.status === 'DELETED').map(
                  (c) => c.id,
                ),
              ].includes(c.id)
            ),
            'T08_DELETED_NOT_IN_PAGES',
          )
        }
        pass('OWNER_CROSS_USER_CONCURRENT_DELETE_SINGLE_DELTA_DB')
        report(
          'NOT TESTED: HIDDEN_DRAFT_PARENT, REAL_NETWORK_LOSS, TRUE_TIMESTAMP_TIES, CURSOR_EXPIRY, LOAD; không sửa post/accounts để dựng ca.',
        )
        pass('WRITE_API_AND_DB_CHECKS_CLEANUP_REQUIRES_SEPARATE_REVIEW')
      }
    }
  } catch (error) {
    failure = error instanceof ManualAuthError
      ? error
      : new ManualAuthError('FAIL: T08_NETWORK_SDK_OR_IO. Không in lỗi thô.')
  } finally {
    if (isDelete && deleteJournal && failure) {
      deleteJournal.status = 'FAILED'
      await deleteQueue.catch(() => {})
      deleteQueue = Promise.resolve()
      // Snapshot sau lỗi chỉ là quan sát tại thời điểm đọc, không chứng minh request timeout đã kết thúc server-side.
      try {
        await observeDeletes('RECOVERY')
      } catch {
        deleteJournal.events.push({ stage: 'RECOVERY', phase: 'FAILED' })
      }
    }
    let logoutFailed = false
    for (const client of clients) {
      try {
        const out = await client.auth.signOut({ scope: 'local' }),
          s = await client.auth.getSession()
        check(
          !out.error && !s.error && s.data.session === null,
          'T08_LOGOUT_LOCAL_NULL',
        )
      } catch {
        logoutFailed = true
        failure ??= new ManualAuthError('FAIL: T08_LOGOUT.')
      }
    }
    try {
      await queue
      await persist()
    } catch {
      failure ??= new ManualAuthError(
        'FAIL: T08_INVENTORY_IO. Giữ write-ahead; không chạy lại write.',
      )
    }
    if (deleteJournal) {
      try {
        deleteJournal.status = failure ? 'FAILED' : 'COMPLETED'
        await saveDelete()
      } catch {
        failure ??= new ManualAuthError(
          'FAIL: T08_R2_CHECKPOINT_IO. Không chạy lại delete; review journal và SQL.',
        )
      }
      report(`R2 journal: .temp/t08-comments/${runId}.r2.json; không tự phát lại batch hoặc cleanup.`)
    }
    report(
      `Inventory local: .temp/t08-comments/${runId}.json; verify.sql/cleanup.sql cùng runId. Không tự cleanup.`,
    )
    report(
      `Logout local: ${
        logoutFailed ? 'FAIL' : 'PASS'
      }; Auth có side effects phiên/last_sign_in, không coi login/logout là read-only tuyệt đối.`,
    )
  }
  if (failure) throw failure
  pass(
    `T08 ${config.mode}; runId=${runId}; ${
      config.mode === '--write' || isDelete ? 'NO_AUTO_CLEANUP' : 'NO_BUSINESS_WRITES'
    }`,
  )
  return record
}
