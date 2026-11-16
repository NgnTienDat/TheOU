import { randomBytes, randomUUID } from 'node:crypto'
import { createClient, type SupabaseClient, type User } from '@supabase/supabase-js'
import { ensure, fixtureEmail, fixtureRoles, t04ProjectRef, T04CloudError, uuidPattern, validateRecovery,
  type Baseline, type Recovery, type RecoveryStore } from './t04-cloud-recovery.ts'

type Report = (line: string) => void
export function readT04CloudConfig(env: NodeJS.ProcessEnv, linkedRef: string) {
  ensure(env.THEOU_ALLOW_T04_CLOUD_TESTS === 'theou-dev', 'THEOU_ALLOW_T04_CLOUD_TESTS chưa xác nhận theou-dev')
  ensure(env.THEOU_TEST_PROJECT_REF?.trim() === t04ProjectRef && linkedRef.trim() === t04ProjectRef &&
    env.THEOU_TEST_SUPABASE_URL?.trim() === `https://${t04ProjectRef}.supabase.co`, 'PROJECT_GUARD')
  const publishableKey = env.THEOU_TEST_PUBLISHABLE_KEY?.trim()
  const secretKey = env.THEOU_TEST_SECRET_KEY?.trim()
  ensure(publishableKey && /^sb_publishable_[A-Za-z0-9_-]+$/.test(publishableKey) &&
    secretKey && /^sb_secret_[A-Za-z0-9_-]+$/.test(secretKey), 'TEST_KEYS_INVALID')
  return { url: `https://${t04ProjectRef}.supabase.co`, publishableKey, secretKey }
}
type Config = ReturnType<typeof readT04CloudConfig>
type Actor = { client: SupabaseClient; id: string; email: string; token: string }
function checked(result: { error: unknown }, stage: string) { ensure(!result.error, stage) }
function makeClient(config: Config, key: string, fetchRequest: typeof fetch) {
  return createClient(config.url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: async (input, init) => {
      const target = new URL(input instanceof Request ? input.url : String(input))
      ensure(target.origin === config.url, 'REQUEST_TARGET')
      try {
        return await fetchRequest(input, { ...init, redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(20000) })
      } catch { throw new T04CloudError('FAIL: NETWORK_OR_TIMEOUT. Không in lỗi kết nối thô.') }
    } },
  })
}
async function listUsers(admin: SupabaseClient): Promise<User[]> {
  const users: User[] = []
  for (let page = 1; page <= 10000; page++) {
    const result = await admin.auth.admin.listUsers({ page, perPage: 200 })
    checked(result, 'BASELINE_AUTH_LIST')
    ensure(Array.isArray(result.data.users), 'AUTH_LIST_SHAPE')
    users.push(...result.data.users)
    if (result.data.users.length < 200) {
      ensure(new Set(users.map(u => u.id)).size === users.length, 'AUTH_PAGINATION_DRIFT')
      return users
    }
  }
  throw new T04CloudError('FAIL: AUTH_PAGINATION_LIMIT.')
}
async function countRows(admin: SupabaseClient, table: 'profiles' | 'user_roles', id?: string): Promise<number> {
  const column = table === 'profiles' ? 'id' : 'user_id'
  let query = admin.from(table).select(column, { count: 'exact', head: true })
  if (id) query = query.eq(column, id)
  const result = await query
  checked(result, 'DB_COUNT')
  ensure(typeof result.count === 'number' && Number.isSafeInteger(result.count) && result.count >= 0, 'DB_COUNT_MISSING')
  return result.count
}
async function baseline(admin: SupabaseClient, users: User[]): Promise<Baseline> {
  return { users: users.length, profiles: await countRows(admin, 'profiles'), roles: await countRows(admin, 'user_roles') }
}
async function sameSession(actor: Actor) {
  const result = await actor.client.auth.getSession()
  checked(result, 'SESSION_READ')
  ensure(result.data.session?.access_token === actor.token && result.data.session.user.id === actor.id, 'SESSION_CHANGED')
}
function exactKeys(value: unknown, keys: string[]): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k))
}
async function invoke(actor: Actor, expected: 'OK' | 'FORBIDDEN' | 'VALIDATION_ERROR', payload: Record<string, unknown> = {}) {
  await sameSession(actor)
  const result = await actor.client.functions.invoke<unknown>('social-api', {
    body: { action: 'getMe', payload }, headers: { Authorization: `Bearer ${actor.token}` }, timeout: 20000,
  })
  const response = result.response
  ensure(response && response.headers.get('x-relay-error') !== 'true', 'API_RESPONSE_MISSING_OR_RELAY')
  let body: unknown = result.data
  if (result.error) {
    try { body = await response.clone().json() } catch { throw new T04CloudError('FAIL: API_JSON.') }
  }
  ensure(exactKeys(body, ['data', 'error', 'meta']) && exactKeys(body.meta, ['requestId']) &&
    typeof body.meta.requestId === 'string' && uuidPattern.test(body.meta.requestId), 'API_ENVELOPE')
  const serialized = JSON.stringify(body).toLowerCase()
  ensure(![actor.id, actor.email, actor.token].some(v => serialized.includes(v.toLowerCase())), 'API_PRIVATE_IDENTITY')
  if (expected !== 'OK') {
    ensure(response.status === (expected === 'FORBIDDEN' ? 403 : 400) && body.data === null &&
      exactKeys(body.error, ['code', 'message', 'details']) && body.error.code === expected &&
      typeof body.error.message === 'string' && body.error.details === null, 'API_EXPECTED_DENIAL')
    await sameSession(actor)
    return null
  }
  ensure(!result.error && response.status === 200 && body.error === null &&
    exactKeys(body.data, ['nickname', 'emailMasked', 'isAdmin']) && typeof body.data.nickname === 'string' &&
    body.data.nickname.length >= 3 && body.data.nickname.length <= 30 &&
    body.data.emailMasked === '***@ou.edu.vn' && typeof body.data.isAdmin === 'boolean', 'API_GETME_DTO')
  await sameSession(actor)
  return body.data as { nickname: string; emailMasked: string; isAdmin: boolean }
}
async function profile(admin: SupabaseClient, id: string) {
  const result = await admin.from('profiles').select('id,nickname,status,created_at,updated_at').eq('id', id).single()
  checked(result, 'PROFILE_READ')
  ensure(result.data?.id === id, 'PROFILE_READ_ID')
  return result.data
}

export async function cleanupT04Cloud(config: Config, record: Recovery, store: RecoveryStore, report: Report, fetchRequest: typeof fetch = fetch) {
  validateRecovery(record)
  const admin = makeClient(config, config.secretKey, fetchRequest)
  const users = await listUsers(admin)
  // Xác minh toàn bộ scope trước bất kỳ DELETE nào, kể cả recovery sau mất response createUser.
  for (const fixture of record.fixtures) {
    const matches = users.filter(u => u.email === fixture.email || fixture.id !== null && u.id === fixture.id)
    ensure(matches.length <= 1, 'CLEANUP_AMBIGUOUS_USER')
    if (matches.length) {
      const user = matches[0]
      ensure(user.email === fixture.email && user.app_metadata?.theou_t04_run_id === record.runId &&
        uuidPattern.test(user.id) && (!fixture.id || fixture.id === user.id), 'CLEANUP_OWNERSHIP')
      fixture.id = user.id
    }
  }
  await store.save(record)
  const failures: string[] = []
  for (const fixture of record.fixtures) {
    if (!fixture.id) continue
    try {
      const exists = users.some(u => u.id === fixture.id)
      if (exists) {
        checked(await admin.from('user_roles').delete().eq('user_id', fixture.id).eq('role', 'ADMIN'), 'CLEANUP_ROLE')
        checked(await admin.from('profiles').delete().eq('id', fixture.id), 'CLEANUP_PROFILE')
        checked(await admin.auth.admin.deleteUser(fixture.id), 'CLEANUP_AUTH')
      }
      ensure(await countRows(admin, 'profiles', fixture.id) === 0 && await countRows(admin, 'user_roles', fixture.id) === 0, 'CLEANUP_ROWS_REMAIN')
    } catch (error) {
      failures.push(fixture.role)
      report(error instanceof T04CloudError ? error.message : 'FAIL: CLEANUP_REQUEST. Không in lỗi SDK.')
    }
  }
  const remaining = await listUsers(admin)
  ensure(failures.length === 0 && !remaining.some(u => record.fixtures.some(f => f.email === u.email || f.id === u.id)), 'CLEANUP_FIXTURES_REMAIN')
  const after = await baseline(admin, remaining)
  ensure(after.users === record.baseline.users && after.profiles === record.baseline.profiles &&
    after.roles === record.baseline.roles, 'BASELINE_DRIFT_NO_EXTERNAL_DATA_DELETED')
  await store.remove(record.runId)
  report(`PASS: cleanup; users=${after.users}; profiles=${after.profiles}; roles=${after.roles}; baseline khớp.`)
}

export async function runT04Cloud(config: Config, store: RecoveryStore, report: Report, fetchRequest: typeof fetch = fetch) {
  const admin = makeClient(config, config.secretKey, fetchRequest)
  const runId = randomUUID().replaceAll('-', '')
  const users = await listUsers(admin)
  const record: Recovery = { projectRef: t04ProjectRef, runId, baseline: await baseline(admin, users),
    fixtures: fixtureRoles.map(role => ({ role, email: fixtureEmail(runId, role), id: null })) }
  ensure(!users.some(u => record.fixtures.some(f => f.email === u.email)), 'FIXTURE_EMAIL_ALREADY_EXISTS')
  await store.save(record)
  report(`Baseline: users=${record.baseline.users}; profiles=${record.baseline.profiles}; roles=${record.baseline.roles}.`)
  const actors: Actor[] = []
  let failed = false
  try {
    for (const fixture of record.fixtures) {
      const password = `${randomBytes(24).toString('base64url')}-Aa1!`
      ensure(Buffer.byteLength(password, 'utf8') <= 72, 'PASSWORD_BYTES')
      const created = await admin.auth.admin.createUser({ email: fixture.email, password, email_confirm: true,
        app_metadata: { theou_t04_run_id: runId } })
      checked(created, 'AUTH_CREATE_FIXTURE')
      const user = created.data.user
      ensure(user && uuidPattern.test(user.id) && user.email === fixture.email &&
        user.app_metadata?.theou_t04_run_id === runId && !users.some(existing => existing.id === user.id), 'AUTH_FIXTURE_IDENTITY')
      fixture.id = user.id
      await store.save(record)
      const client = makeClient(config, config.publishableKey, fetchRequest)
      const signedIn = await client.auth.signInWithPassword({ email: fixture.email, password })
      checked(signedIn, 'AUTH_PASSWORD_LOGIN')
      const session = signedIn.data.session
      ensure(session?.access_token && session.user.id === fixture.id, 'AUTH_SESSION')
      const actor = { client, id: fixture.id, email: fixture.email, token: session.access_token }
      actors.push(actor)
      const verified = await client.auth.getUser()
      checked(verified, 'AUTH_GET_USER')
      ensure(verified.data.user?.id === actor.id && verified.data.user.email === fixture.email &&
        verified.data.user.email_confirmed_at, 'AUTH_CONFIRMED_OU')
      ensure(await countRows(admin, 'profiles', actor.id) === 0 && await countRows(admin, 'user_roles', actor.id) === 0, 'FIXTURE_MUST_START_EMPTY')
    }
    const [banned, adminActor, race] = actors
    ensure((await invoke(banned, 'OK'))?.isAdmin === false, 'BANNED_INITIAL_ACTIVE')
    const update = await admin.from('profiles').update({ status: 'BANNED' }).eq('id', banned.id).eq('status', 'ACTIVE').select('id,status')
    checked(update, 'BAN_FIXTURE')
    ensure(update.data?.length === 1 && update.data[0].id === banned.id && update.data[0].status === 'BANNED', 'BAN_UPDATED_ONE')
    await invoke(banned, 'FORBIDDEN')
    await invoke(banned, 'FORBIDDEN')
    ensure((await profile(admin, banned.id)).status === 'BANNED', 'BAN_MUST_PERSIST')
    report('PASS: BANNED bị FORBIDDEN/403 bằng JWT cũ; profile vẫn BANNED, phiên không đổi.')

    ensure((await invoke(adminActor, 'OK'))?.isAdmin === false, 'ADMIN_INITIAL_FALSE')
    checked(await admin.from('user_roles').insert({ user_id: adminActor.id, role: 'ADMIN', granted_by: null }), 'ADMIN_GRANT')
    ensure((await invoke(adminActor, 'OK'))?.isAdmin === true, 'ADMIN_GRANT_NOT_OBSERVED')
    checked(await admin.from('user_roles').delete().eq('user_id', adminActor.id).eq('role', 'ADMIN'), 'ADMIN_REVOKE')
    ensure((await invoke(adminActor, 'OK'))?.isAdmin === false, 'ADMIN_REVOKE_NOT_OBSERVED')
    await invoke(adminActor, 'VALIDATION_ERROR', { role: 'ADMIN', isAdmin: true, userId: race.id })
    checked(await adminActor.client.auth.updateUser({ data: { role: 'ADMIN', isAdmin: true, status: 'ACTIVE' } }), 'USER_METADATA_UPDATE')
    ensure((await invoke(adminActor, 'OK'))?.isAdmin === false && await countRows(admin, 'user_roles', adminActor.id) === 0, 'METADATA_MUST_NOT_GRANT_ADMIN')
    report('PASS: ADMIN false/true/false bằng cùng JWT; payload/metadata không nâng quyền.')

    ensure(await countRows(admin, 'profiles', race.id) === 0, 'RACE_PROFILE_ALREADY_EXISTS')
    // Đợi tất cả request kết thúc trước cleanup, kể cả khi một request bị lỗi.
    const concurrent = await Promise.allSettled(Array.from({ length: 10 }, () => invoke(race, 'OK')))
    ensure(concurrent.every(r => r.status === 'fulfilled' && r.value && r.value.isAdmin === false), 'RACE_REQUEST_FAILED')
    const nicknames = concurrent.map(r => r.status === 'fulfilled' ? r.value?.nickname : undefined)
    ensure(typeof nicknames[0] === 'string' && new Set(nicknames).size === 1 &&
      await countRows(admin, 'profiles', race.id) === 1 && await countRows(admin, 'user_roles', race.id) === 0, 'RACE_PROFILE_NOT_UNIQUE')
    const before = await profile(admin, race.id)
    ensure(before.nickname === nicknames[0] && before.status === 'ACTIVE', 'RACE_PROFILE_MISMATCH')
    ensure((await invoke(race, 'OK'))?.nickname === before.nickname, 'RACE_NICKNAME_CHANGED')
    ensure(JSON.stringify(await profile(admin, race.id)) === JSON.stringify(before) && await countRows(admin, 'user_roles', race.id) === 0, 'RACE_PROFILE_CHANGED')
    report('PASS: 10 getMe đồng thời cùng nickname; đúng một profile, không role; gọi lại không ghi đè.')
  } catch (error) {
    failed = true
    if (error instanceof T04CloudError) report(error.message)
    report('FAIL: T04 Cloud scenario. Dừng scenario, chuyển cleanup; không in dữ liệu hoặc lỗi SDK.')
  } finally {
    for (const actor of actors) {
      try {
        checked(await actor.client.auth.signOut({ scope: 'local' }), 'LOGOUT')
        const session = await actor.client.auth.getSession()
        checked(session, 'LOGOUT_SESSION_READ')
        ensure(session.data.session === null, 'LOGOUT_SESSION_REMAINS')
      } catch { failed = true; report('FAIL: logout fixture; vẫn tiếp tục cleanup.') }
    }
    try { await cleanupT04Cloud(config, record, store, report, fetchRequest) }
    catch (error) {
      if (error instanceof T04CloudError) report(error.message)
      // Manifest đã được ghi trước createUser, không chứa password/JWT/key.
      report(`FAIL: cleanup/baseline chưa đạt. Recovery local: .temp/t04-cloud/${runId}.json`)
      report(`Cleanup: npm.cmd run test:t04-cloud -- --cleanup ${runId}`)
      throw new T04CloudError('FAIL: CLEANUP_OR_BASELINE. Giữ manifest và kiểm tra trước khi chạy lại.')
    }
  }
  ensure(!failed, 'T04_SCENARIO_OR_LOGOUT')
  report('PASS: T04-B.7; cả ba scenario, logout, cleanup và baseline đạt.')
}
