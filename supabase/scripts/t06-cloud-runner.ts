import { randomBytes, randomUUID } from 'node:crypto'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { ManualAuthError, normalizeOuEmail, parsePassword, readManualAuthConfig } from './auth-helpers.ts'
import { requireVerifiedSession } from './auth-manual-flow.ts'
import { runGetMeChecks, type SocialApiIdentity } from './social-api-manual.ts'
import { t04ProjectRef, uuidPattern } from './t04-cloud-recovery.ts'
import { check, type InventoryStore, type PostFixture, type PostInventory } from './t06-cloud-inventory.ts'
import type { PostPublic } from '../functions/social-api/modules/posts/post-mapper.ts'

export type PostTestMode = '--smoke' | '--write'
export function readT06Config(env: NodeJS.ProcessEnv, linkedRef: string, args: string[]) {
  check(args.length === 1 && ['--smoke', '--write'].includes(args[0]), 'ARGS_USE_SMOKE_OR_WRITE')
  const auth = readManualAuthConfig(env, linkedRef)
  if (args[0] === '--write') {
    check(env.THEOU_ALLOW_T06_CLOUD_WRITES === 'theou-dev', 'WRITE_APPROVAL_REQUIRED')
  }
  return { ...auth, mode: args[0] as PostTestMode }
}
type Config = ReturnType<typeof readT06Config>
type Report = (line: string) => void
interface Actor {
  client: SupabaseClient
  identity: SocialApiIdentity
}
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
function keys(value: unknown, names: string[]): value is Record<string, unknown> {
  return object(value) && Object.keys(value).sort().join(',') === [...names].sort().join(',')
}
const postKeys = [
  'id',
  'tag',
  'body',
  'displayMode',
  'authorLabel',
  'contactUrl',
  'publishedAt',
  'upvoteCount',
  'commentCount',
  'hasUpvoted',
  'isMine',
  'images',
]
const tags = ['CONFESSION', 'REVIEW_MON', 'TAI_LIEU', 'TIM_TRO', 'HOI_GAP']
function timestamp(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(value) &&
    Number.isFinite(Date.parse(value))
}
export function publicPost(value: unknown): PostPublic {
  check(
    keys(value, postKeys) && typeof value.id === 'string' && uuidPattern.test(value.id) &&
      typeof value.body === 'string' && [...value.body].length >= 1 && [...value.body].length <= 1000 &&
      typeof value.tag === 'string' && tags.includes(value.tag) && typeof value.displayMode === 'string' &&
      ['ANONYMOUS', 'NICKNAME'].includes(value.displayMode) &&
      typeof value.authorLabel === 'string' && timestamp(value.publishedAt) &&
      Number.isSafeInteger(value.upvoteCount) && Number(value.upvoteCount) >= 0 &&
      Number.isSafeInteger(value.commentCount) && Number(value.commentCount) >= 0 &&
      typeof value.isMine === 'boolean' && typeof value.hasUpvoted === 'boolean' &&
      Array.isArray(value.images) && !value.images.length,
    'POST_DTO_ALLOWLIST',
  )
  check(
    value.displayMode !== 'ANONYMOUS' || value.authorLabel === 'OUer ẩn danh' && value.contactUrl === null,
    'ANONYMOUS_DTO',
  )
  check(
    value.displayMode !== 'NICKNAME' ||
      [...value.authorLabel].length >= 3 && [...value.authorLabel].length <= 30,
    'NICKNAME_SNAPSHOT',
  )
  if (value.contactUrl !== null) {
    check(
      typeof value.contactUrl === 'string' && value.displayMode === 'NICKNAME' &&
        ['TAI_LIEU', 'TIM_TRO'].includes(value.tag) &&
        value.contactUrl.length <= 2048 && !/[\s\p{Cc}]/u.test(value.contactUrl),
      'CONTACT_DTO',
    )
    let url: URL
    try {
      url = new URL(value.contactUrl)
    } catch {
      throw new ManualAuthError('FAIL: CONTACT_DTO.')
    }
    check(
      url.protocol === 'https:' && !url.username && !url.password && !url.port &&
        ['zalo.me', 'facebook.com', 'www.facebook.com', 'm.facebook.com', 'm.me'].includes(url.hostname),
      'CONTACT_DTO',
    )
  }
  return value as unknown as PostPublic
}
export function guardT06Fetch(config: Config, fetchRequest: typeof fetch): typeof fetch {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
    check(
      config.url === `https://${t04ProjectRef}.supabase.co` && url.origin === config.url && !url.username &&
        !url.password &&
        headers.get('apikey') === config.publishableKey &&
        config.publishableKey.startsWith('sb_publishable_'),
      'REQUEST_TARGET_OR_KEY',
    )
    const auth = url.pathname === '/auth/v1/user' && method === 'GET' ||
      url.pathname === '/auth/v1/token' && method === 'POST' &&
        url.searchParams.get('grant_type') === 'password' ||
      url.pathname === '/auth/v1/logout' && method === 'POST' && url.searchParams.get('scope') === 'local'
    const api = url.pathname === '/functions/v1/social-api' && method === 'POST'
    check(auth || api, 'REQUEST_PATH_NO_ADMIN_OR_RAW_TABLE')
    if (api && config.mode === '--smoke') {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      check(
        ['getMe', 'listPosts', 'getPost', '__t04_unknown__'].includes(String(body.action)),
        'SMOKE_NO_POST_WRITES',
      )
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
      // Không để Auth SDK log nguyên lỗi fetch/URL/stack; lỗi mạng không bao giờ là negative PASS.
      return Response.json({ code: 'unexpected_failure', message: 'Network request unavailable' }, {
        status: 503,
      })
    }
  }
}
function micros(time: string) {
  return BigInt(Date.parse(time.slice(0, 19) + 'Z')) * 1000n +
    BigInt((time.split('.')[1]?.slice(0, -1) ?? '').padEnd(6, '0') || '0')
}
function comesBefore(left: PostPublic, right: PostPublic, sort: 'NEW' | 'HOT') {
  if (sort === 'HOT' && left.upvoteCount !== right.upvoteCount) return left.upvoteCount > right.upvoteCount
  const a = micros(left.publishedAt), b = micros(right.publishedAt)
  return a > b || a === b && left.id.toLowerCase() > right.id.toLowerCase()
}

export async function runT06Cloud(
  config: Config,
  env: NodeJS.ProcessEnv,
  askHidden: (prompt: string) => Promise<string>,
  store: InventoryStore,
  report: Report,
  fetchRequest: typeof fetch = fetch,
) {
  const runId = randomUUID().replaceAll('-', '')
  const record: PostInventory = {
    projectRef: t04ProjectRef,
    runId,
    marker: `T06-CLOUD-TEST-${runId}`,
    fixtures: [],
  }
  const fetchGuard = guardT06Fetch(config, fetchRequest)
  const actors: Actor[] = []
  const clients: SupabaseClient[] = []
  let queue = Promise.resolve(), failure: unknown, emptyPageObserved = false
  const persist = () => {
    const snapshot = structuredClone(record)
    queue = queue.then(() => store.save(snapshot))
    return queue
  }
  const pass = (stage: string, http = 200) => report(`PASS: ${stage}; http=${http}.`)
  async function originalSession(actor: Actor) {
    const session = await actor.client.auth.getSession()
    check(
      !session.error && session.data.session?.access_token === actor.identity.accessToken &&
        session.data.session.user.id === actor.identity.userId,
      'SESSION_CHANGED',
    )
  }
  function privateData(value: unknown) {
    const text = JSON.stringify(value)?.toLowerCase() ?? ''
    check(
      !actors.some((a) =>
        [a.identity.email, a.identity.userId, a.identity.accessToken].some((secret) =>
          text.includes(secret.toLowerCase())
        )
      ),
      'PRIVATE_IDENTITY_RESPONSE',
    )
  }
  async function call(
    actor: Actor,
    action: string,
    payload: unknown,
    capture?: (body: unknown) => Promise<void>,
  ) {
    await originalSession(actor)
    const result = await actor.client.functions.invoke<unknown>('social-api', {
      body: { action, payload },
      headers: { Authorization: `Bearer ${actor.identity.accessToken}` },
      timeout: 20_000,
    })
    check(result.response && result.response.headers.get('x-relay-error') !== 'true', 'API_NETWORK_OR_RELAY')
    let body: unknown
    try {
      body = result.error ? await result.response.clone().json() : result.data
    } catch {
      body = null
    }
    if (capture) await capture(body)
    privateData(body)
    const status = result.response.status
    const safeCodes = [
      'UNAUTHENTICATED',
      'FORBIDDEN',
      'VALIDATION_ERROR',
      'NOT_FOUND',
      'CONFLICT',
      'INTERNAL_ERROR',
    ]
    const safeCode = object(body) && object(body.error) && typeof body.error.code === 'string' &&
        safeCodes.includes(body.error.code)
      ? body.error.code
      : 'UNKNOWN_RESPONSE'
    check(
      keys(body, ['data', 'error', 'meta']) && keys(body.meta, ['requestId']) &&
        typeof body.meta.requestId === 'string' && uuidPattern.test(body.meta.requestId),
      `API_ENVELOPE_http=${status}_code=${safeCode}`,
    )
    if (body.error !== null) {
      check(
        body.data === null && keys(body.error, ['code', 'message', 'details']) &&
          safeCode !== 'UNKNOWN_RESPONSE' &&
          typeof body.error.message === 'string' && body.error.details === null &&
          !/SQLSTATE|PGRST\d|\bselect\b.+\bfrom\b|stacktrace|service_role/i.test(body.error.message),
        `API_ERROR_http=${status}_code=${safeCode}`,
      )
    }
    check(
      status < 500 && safeCode !== 'INTERNAL_ERROR',
      `API_SYSTEM_FAILURE_${action}_http=${status}_code=${safeCode}`,
    )
    await originalSession(actor)
    return { data: body.data, error: body.error, status, code: body.error === null ? 'OK' : safeCode }
  }
  async function ok(actor: Actor, action: string, payload: unknown) {
    const response = await call(actor, action, payload)
    check(response.status === 200 && response.error === null, `EXPECTED_OK_${action}`)
    return response.data
  }
  async function denied(actor: Actor, action: string, payload: unknown, status: number, code: string) {
    const result = await call(actor, action, payload)
    check(result.status === status && result.code === code, `EXPECTED_DENIAL_${action}`)
  }
  const listPayload = (
    sort: 'NEW' | 'HOT',
    tag: string | null = null,
    cursor: string | null = null,
    limit = 20,
  ) => ({ sort, tag, cursor, limit })
  async function page(actor: Actor, payload: ReturnType<typeof listPayload>) {
    const data = await ok(actor, 'listPosts', payload)
    check(
      keys(data, ['items', 'nextCursor']) && Array.isArray(data.items) &&
        data.items.length <= payload.limit && data.items.length <= 20 &&
        (data.nextCursor === null ||
          typeof data.nextCursor === 'string' && data.nextCursor.length > 0 &&
            data.nextCursor.length <= 1024),
      'PAGE_DTO',
    )
    if (data.nextCursor) {
      let claims: unknown
      try {
        claims = JSON.parse(
          Buffer.from((data.nextCursor as string).split('.')[0], 'base64url').toString('utf8'),
        )
      } catch {
        claims = null
      }
      check(
        keys(claims, ['v', 'sort', 'tag', 'asOf', 'publishedAt', 'id', 'upvoteCount']),
        'CURSOR_PRIVACY_SHAPE',
      )
      privateData(claims)
    }
    const items = data.items.map(publicPost)
    check(items.length > 0 || data.nextCursor === null, 'EMPTY_PAGE_CURSOR')
    if (!items.length) emptyPageObserved = true
    for (let i = 1; i < items.length; i++) {
      check(comesBefore(items[i - 1], items[i], payload.sort), 'PAGE_ORDER')
    }
    if (payload.tag) check(items.every((item) => item.tag === payload.tag), 'PAGE_TAG')
    if (payload.sort === 'HOT') {
      check(
        items.every((item) => Date.parse(item.publishedAt) >= Date.now() - 86_400_000 - 20_000),
        'HOT_24H_OBSERVED',
      )
    }
    return { items, nextCursor: data.nextCursor as string | null }
  }
  try {
    for (const label of ['A', 'B']) {
      let email = normalizeOuEmail(
        env[`THEOU_T06_EMAIL_${label}`] || await askHidden(`Email OU ${label} đã tồn tại (ẩn): `),
      )
      let password = parsePassword(
        env[`THEOU_T06_PASSWORD_${label}`] || await askHidden(`Mật khẩu ${label} (ẩn): `),
        'login',
      )
      check(!actors.some((a) => a.identity.email === email), 'ACCOUNTS_MUST_DIFFER')
      const client = createClient(config.url, config.publishableKey, {
        global: { fetch: fetchGuard },
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      })
      clients.push(client)
      const session = await requireVerifiedSession(
        client.auth,
        await client.auth.signInWithPassword({ email, password }),
        email,
      )
      password = ''
      check(!actors.some((a) => a.identity.userId === session.user.id), 'ACCOUNT_IDS_MUST_DIFFER')
      actors.push({ client, identity: { userId: session.user.id, email, accessToken: session.access_token } })
      email = ''
      pass(`LOGIN_${label}_OU_CONFIRMED`)
    }
    const [a, b] = actors
    for (const [index, actor] of actors.entries()) {
      await runGetMeChecks(actor.client, config, actor.identity, report, fetchGuard)
      const me = await ok(actor, 'getMe', {})
      check(
        keys(me, ['nickname', 'emailMasked', 'isAdmin']) && typeof me.nickname === 'string' &&
          me.emailMasked === '***@ou.edu.vn' && typeof me.isAdmin === 'boolean',
        'ME_DTO',
      )
      for (const sort of ['NEW', 'HOT'] as const) {
        const result = await page(actor, listPayload(sort))
        pass(
          `SMOKE_${index === 0 ? 'A' : 'B'}_${sort}_items=${result.items.length}_cursor=${
            result.nextCursor !== null
          }`,
        )
      }
      await denied(actor, 'getPost', { postId: randomUUID() }, 404, 'NOT_FOUND')
      await denied(actor, 'listPosts', listPayload('NEW', null, 'invalid'), 400, 'VALIDATION_ERROR')
      const claims = {
        v: 1,
        sort: 'NEW',
        tag: null,
        asOf: Date.now(),
        publishedAt: new Date(Date.now() - 1000).toISOString(),
        id: randomUUID(),
        upvoteCount: 0,
      }
      const forged = Buffer.from(JSON.stringify(claims)).toString('base64url') + '.' +
        randomBytes(32).toString('base64url')
      await denied(actor, 'listPosts', listPayload('NEW', null, forged), 400, 'VALIDATION_ERROR')
      pass(`SMOKE_${index === 0 ? 'A' : 'B'}_POST_READS_CURSOR_PRIVACY`)
    }
    pass('SMOKE_COMPLETE_NO_POST_WRITES')
    if (config.mode === '--write') {
      // Mode write chạy lại smoke, kiểm tra cờ riêng trước lần create đầu tiên.
      check(env.THEOU_ALLOW_T06_CLOUD_WRITES === 'theou-dev', 'WRITE_APPROVAL_REQUIRED')
      await persist()
      const fixture = (label: string): PostFixture => {
        const value: PostFixture = {
          label,
          key: randomUUID(),
          body: `${record.marker} ${label}`,
          postIds: [],
          outcome: 'pending',
        }
        record.fixtures.push(value)
        return value
      }
      const payload = (f: PostFixture, extra: Record<string, unknown> = {}) => ({
        body: f.body,
        tag: 'CONFESSION',
        displayMode: 'ANONYMOUS',
        contactUrl: null,
        idempotencyKey: f.key,
        ...extra,
      })
      const create = async (
        f: PostFixture,
        input = payload(f),
        expectedError?: 'VALIDATION_ERROR' | 'CONFLICT',
      ) => {
        await persist()
        const result = await call(a, 'createPost', input, async (body) => {
          if (
            object(body) && object(body.data) && typeof body.data.postId === 'string' &&
            uuidPattern.test(body.data.postId)
          ) {
            const postId = body.data.postId
            if (actors.some((a) => a.identity.userId === postId)) return
            if (!f.postIds.includes(body.data.postId)) f.postIds.push(body.data.postId)
            f.outcome = 'ack'
            await persist()
          }
        })
        if (expectedError) {
          check(
            result.status === (expectedError === 'CONFLICT' ? 409 : 400) && result.code === expectedError,
            'CREATE_EXPECTED_DENIAL',
          )
          if (!f.postIds.length) f.outcome = 'rejected'
          await persist()
          return ''
        }
        check(
          result.status === 200 && result.error === null && keys(result.data, ['postId', 'status']) &&
            result.data.status === 'DRAFT' && typeof result.data.postId === 'string' &&
            uuidPattern.test(result.data.postId),
          'CREATE_ACK',
        )
        return result.data.postId
      }
      const main = fixture('anonymous-main')
      const postId = await create(main)
      check(await create(main) === postId, 'CREATE_RETRY_ID')
      await create(main, payload(main, { body: main.body + ' changed' }), 'CONFLICT')
      pass('CREATE_RETRY_CONFLICT_API')
      const race = fixture('race')
      const concurrent = await Promise.allSettled([create(race), create(race)])
      check(
        concurrent.every((r) => r.status === 'fulfilled') && race.postIds.length === 1,
        'CREATE_CONCURRENT_API',
      )
      pass('CREATE_CONCURRENT_SAME_KEY_API')
      report('NOT TESTED: DB_ROW_COUNT_CONCURRENCY; chạy verify.sql read-only trước nghiệm thu.')
      for (
        const [label, extra] of [
          ['empty', { body: '' }],
          ['too-long', { body: `${record.marker} ${'x'.repeat(1001)}` }],
          ['tag', { tag: 'BAD' }],
          ['mode', { displayMode: 'BAD' }],
          ['contact', { contactUrl: 'https://zalo.me/offline' }],
          ['spoof-host', {
            tag: 'TAI_LIEU',
            displayMode: 'NICKNAME',
            contactUrl: 'https://zalo.me.evil.invalid/offline',
          }],
          ['author', { authorId: b.identity.userId }],
          ['status', { status: 'PUBLISHED' }],
          ['counts', { upvoteCount: 99 }],
          ['metadata', { user_metadata: { role: 'ADMIN' } }],
        ] as const
      ) {
        const f = fixture(`invalid-${label}`)
        const input = payload(f, extra)
        f.body = input.body.trim()
        await create(f, input, 'VALIDATION_ERROR')
      }
      pass('CREATE_VALIDATION_AND_SPOOFING', 400)
      await denied(b, 'publishPost', { postId }, 404, 'NOT_FOUND')
      for (const actor of actors) await denied(actor, 'getPost', { postId }, 404, 'NOT_FOUND')
      check(!(await page(b, listPayload('NEW'))).items.some((p) => p.id === postId), 'DRAFT_NOT_IN_FEED')
      pass('DRAFT_PRIVATE_OWNER_ONLY_PUBLISH', 404)
      const published = publicPost(await ok(a, 'publishPost', { postId }))
      const replay = publicPost(await ok(a, 'publishPost', { postId }))
      check(
        published.publishedAt === replay.publishedAt && published.authorLabel === 'OUer ẩn danh',
        'PUBLISH_REPLAY',
      )
      const raceId = race.postIds[0]
      const publishedRace = await Promise.allSettled([
        ok(a, 'publishPost', { postId: raceId }),
        ok(a, 'publishPost', { postId: raceId }),
      ])
      check(publishedRace.every((r) => r.status === 'fulfilled'), 'PUBLISH_CONCURRENT_API')
      const raceDtos = publishedRace.map((r) => publicPost((r as PromiseFulfilledResult<unknown>).value))
      check(raceDtos[0].publishedAt === raceDtos[1].publishedAt, 'PUBLISH_CONCURRENT_TIMESTAMP')
      pass('PUBLISH_REPLAY_CONCURRENT_API')
      const nickname = fixture('nickname')
      const before = await ok(a, 'getMe', {}) as { nickname: string }
      const nicknameId = await create(
        nickname,
        payload(nickname, {
          tag: 'TAI_LIEU',
          displayMode: 'NICKNAME',
          contactUrl: 'https://zalo.me/theou-t06-test',
        }),
      )
      const nicknamePost = publicPost(await ok(a, 'publishPost', { postId: nicknameId }))
      const after = await ok(a, 'getMe', {}) as { nickname: string }
      check(
        before.nickname === after.nickname && nicknamePost.authorLabel === before.nickname,
        'NICKNAME_SNAPSHOT_NO_PROFILE_CHANGE',
      )
      const second = fixture('anonymous-second')
      const secondId = await create(second, payload(second, { tag: 'HOI_GAP' }))
      publicPost(await ok(a, 'publishPost', { postId: secondId }))
      const draft = fixture('private-draft')
      const draftId = await create(draft, payload(draft, { tag: 'TIM_TRO' }))
      for (const actor of actors) await denied(actor, 'getPost', { postId: draftId }, 404, 'NOT_FOUND')
      for (const id of [postId, raceId, nicknameId, secondId]) {
        for (const actor of actors) {
          const post = publicPost(await ok(actor, 'getPost', { postId: id }))
          check(post.isMine === (actor === a), 'READ_IS_MINE')
          if (id !== nicknameId) {
            check(post.authorLabel === 'OUer ẩn danh' && post.contactUrl === null, 'READ_ANONYMOUS')
          } else check(post.authorLabel === before.nickname, 'READ_NICKNAME_SNAPSHOT')
        }
      }
      pass('READ_PRIVACY_DTO_IS_MINE_SNAPSHOT')
      for (const sort of ['NEW', 'HOT'] as const) {
        const seen: PostPublic[] = []
        let cursor: string | null = null
        let pages = 0
        do {
          check(++pages <= 100, 'PAGINATION_TOO_MANY_PAGES_NOT_COMPLETE')
          const result = await page(b, listPayload(sort, null, cursor, 2))
          for (const item of result.items) {
            check(!seen.some((p) => p.id === item.id), 'PAGINATION_DUPLICATE_OBSERVED')
            if (seen.length) {
              check(comesBefore(seen[seen.length - 1], item, sort), 'PAGINATION_BOUNDARY_ORDER')
            }
            seen.push(item)
          }
          if (result.nextCursor && cursor === null) {
            await denied(
              b,
              'listPosts',
              listPayload(sort === 'NEW' ? 'HOT' : 'NEW', null, result.nextCursor),
              400,
              'VALIDATION_ERROR',
            )
            await denied(
              b,
              'listPosts',
              listPayload(sort, 'HOI_GAP', result.nextCursor),
              400,
              'VALIDATION_ERROR',
            )
            const parts = result.nextCursor.split('.')
            const tampered = parts[0] + '.' + (parts[1][0] === 'A' ? 'B' : 'A') + parts[1].slice(1)
            await denied(b, 'listPosts', listPayload(sort, null, tampered), 400, 'VALIDATION_ERROR')
          }
          cursor = result.nextCursor
        } while (cursor)
        check(
          [postId, raceId, nicknameId, secondId].every((id) => seen.some((p) => p.id === id)) &&
            !seen.some((p) => p.id === draftId),
          'PAGINATION_FIXTURE_COVERAGE',
        )
        check(
          (await page(b, listPayload(sort, 'HOI_GAP'))).items.some((p) => p.id === secondId),
          'TAG_FIXTURE_HOI_GAP',
        )
        check(
          (await page(b, listPayload(sort, 'TAI_LIEU'))).items.some((p) => p.id === nicknameId),
          'TAG_FIXTURE_TAI_LIEU',
        )
        await page(b, listPayload(sort))
        await denied(b, 'listPosts', listPayload(sort, null, null, 21), 400, 'VALIDATION_ERROR')
        pass(`PAGINATION_${sort}_OBSERVED_STABLE_DATA`)
      }
      report(
        'NOT TESTED: HOT_NONZERO_VOTES_EXACT_24H_TIES_HIDDEN_DELETED_NICKNAME_CHANGE_CURSOR_EXPIRY; không sửa DB/profile để dựng ca.',
      )
      report(
        emptyPageObserved
          ? 'PASS: EMPTY_PAGE_OBSERVED; items=[], nextCursor=null.'
          : 'NOT TESTED: EMPTY_PAGE; chưa quan sát page rỗng, không tự ký cursor hoặc sửa dữ liệu.',
      )
      report('PASS: WRITE_API_CHECKS; cleanup chưa thực hiện, cần review inventory/verify.sql/cleanup.sql.')
    }
  } catch (error) {
    failure = error instanceof ManualAuthError
      ? error
      : new ManualAuthError('FAIL: T06_NETWORK_SDK_OR_LOCAL_IO. Không in lỗi thô.')
  } finally {
    // Đợi mọi request concurrency kết thúc trước logout/inventory; không DELETE bất kỳ dữ liệu nào.
    let cleanupFailed = false
    for (const client of clients) {
      try {
        const result = await client.auth.signOut({ scope: 'local' })
        const current = await client.auth.getSession()
        check(!result.error && !current.error && current.data.session === null, 'LOGOUT_SESSION')
      } catch {
        cleanupFailed = true
      }
    }
    if (config.mode === '--write' && record.fixtures.length) {
      try {
        await queue.catch(() => {})
        await store.save(structuredClone(record))
      } catch {
        cleanupFailed = true
        report('FAIL: INVENTORY_IO; giữ file write-ahead, không chạy lại write tests.')
      }
      report(
        `Inventory local: .temp/t06-cloud/${runId}.json; verification/cleanup SQL cùng runId, chỉ review.`,
      )
    }
    if (cleanupFailed) {
      report('FAIL: LOGOUT_OR_INVENTORY; không nghiệm thu, không tự xóa dữ liệu.')
      failure ??= new ManualAuthError('FAIL: LOGOUT_OR_INVENTORY; không nghiệm thu, không tự xóa dữ liệu.')
    }
    if (!cleanupFailed) {
      report(
        `PASS: logout các client đã khởi tạo (${clients.length}), session local null; không xóa Auth users/profiles/posts.`,
      )
    }
  }
  if (!failure) {
    report(
      `PASS: T06 ${config.mode}; runId=${runId}; ${
        config.mode === '--smoke' ? 'không tạo post fixture' : 'chưa cleanup, chưa nghiệm thu T06'
      }.`,
    )
  }
  if (failure) throw failure
  return record
}
