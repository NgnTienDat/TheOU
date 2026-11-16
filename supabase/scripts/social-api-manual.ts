import { FunctionsHttpError, type SupabaseClient } from '@supabase/supabase-js'
import { ManualAuthError, type readManualAuthConfig } from './auth-helpers.ts'

export interface SocialApiIdentity {
  userId: string
  email: string
  accessToken: string
}

type Report = (message: string) => void
type Config = ReturnType<typeof readManualAuthConfig>
type Source = 'handler' | 'gateway' | 'unknown'
const handlerCodes = ['UNAUTHENTICATED', 'FORBIDDEN', 'VALIDATION_ERROR', 'INTERNAL_ERROR']
const gatewayMessages = ['Missing authorization header', 'Invalid JWT', 'Invalid Token or Protected Header formatting']
const invalidJwtCodes = [
  'UNAUTHORIZED_INVALID_JWT_FORMAT',
  'UNAUTHORIZED_UNSUPPORTED_TOKEN_ALGORITHM',
  'UNAUTHORIZED_LEGACY_JWT',
  'UNAUTHORIZED_ASYMMETRIC_JWT',
]
const missingJwtCode = 'UNAUTHORIZED_NO_AUTH_HEADER'
const gatewayCodes = [...invalidJwtCodes, missingJwtCode]

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasKeys(value: unknown, keys: string[]): value is Record<string, unknown> {
  return isObject(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
}

function isEnvelope(body: unknown): body is Record<string, unknown> {
  return hasKeys(body, ['data', 'error', 'meta']) && hasKeys(body.meta, ['requestId']) &&
    typeof body.meta.requestId === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(body.meta.requestId)
}

function hasPrivateIdentity(body: unknown, identity: SocialApiIdentity): boolean {
  const text = JSON.stringify(body)?.toLowerCase() ?? ''
  return [identity.userId, identity.email, identity.accessToken].some(value => text.includes(value.toLowerCase()))
}

function classify(body: unknown, response: Response): { source: Source; code: string } {
  const unknown = { source: 'unknown', code: 'UNKNOWN_RESPONSE' } as const
  // Handler dùng error.code; quy tắc header/top-level code chỉ thuộc gateway.
  if (isEnvelope(body)) {
    if (body.data === null && hasKeys(body.error, ['code', 'message', 'details']) &&
      typeof body.error.code === 'string' && handlerCodes.includes(body.error.code) &&
      typeof body.error.message === 'string' && body.error.details === null) {
      return { source: 'handler', code: body.error.code }
    }
    return unknown
  }
  if (response.status !== 401) return unknown
  const headerCode = response.headers.get('sb-error-code')
  if (headerCode !== null && !gatewayCodes.includes(headerCode)) return unknown
  const codeMessage = hasKeys(body, ['code', 'message']) && typeof body.message === 'string'
  const messageOnly = hasKeys(body, ['message']) && typeof body.message === 'string'
  const msgOnly = hasKeys(body, ['msg']) && typeof body.msg === 'string'
  if (!codeMessage && !messageOnly && !msgOnly) return unknown
  const bodyCode = codeMessage ? body.code : undefined
  const legacyCode = bodyCode === 401 || bodyCode === '401'
  // Mã mới từ header hoặc body; nếu cả hai có mã cụ thể thì phải trùng nhau.
  if (headerCode !== null) {
    if (bodyCode !== undefined && !legacyCode && bodyCode !== headerCode) return unknown
    return { source: 'gateway', code: headerCode }
  }
  if (typeof bodyCode === 'string' && gatewayCodes.includes(bodyCode)) {
    return { source: 'gateway', code: bodyCode }
  }
  if ((codeMessage && legacyCode && gatewayMessages.includes(body.message as string)) ||
    (msgOnly && body.msg === 'Invalid JWT')) {
    return { source: 'gateway', code: 'GATEWAY_JWT_REJECTED' }
  }
  return unknown
}

function safeCode(value: unknown): string {
  if (value === null || value === undefined) return 'missing'
  if (value === 401 || value === '401') return '401'
  return typeof value === 'string' && [...handlerCodes, ...gatewayCodes].includes(value) ? value : 'unknown'
}

function fail(label: string, report: Report, status?: number, source: Source = 'unknown', code = 'NETWORK_OR_SDK_ERROR'): never {
  report(`FAIL: ${label}; source=${source}; code=${code}; http=${status ?? 'unknown'}.`)
  throw new ManualAuthError('FAIL: kiểm tra social-api chưa đạt. Dừng và kiểm tra cấu hình/deployment; không in response thô.')
}

async function readBody(response: Response): Promise<unknown> {
  try { return await response.clone().json() }
  catch { return null }
}

export async function runGetMeChecks(
  client: Pick<SupabaseClient, 'functions' | 'auth'>,
  config: Config,
  identity: SocialApiIdentity,
  report: Report,
  fetchRequest: typeof fetch = fetch,
): Promise<void> {
  const headers = { Authorization: `Bearer ${identity.accessToken}` }

  async function invoke(body: Record<string, unknown>, label: string) {
    const result = await client.functions.invoke<unknown>('social-api', { body, headers, timeout: 15000 })
    if (!result.response || (result.error && !(result.error instanceof FunctionsHttpError))) {
      fail(label, report, result.response?.status)
    }
    const responseBody = result.error ? await readBody(result.response) : result.data
    return { response: result.response, status: result.response.status, body: responseBody, error: result.error }
  }

  let nickname: string | undefined
  for (const label of ['getMe', 'getMe lặp lại']) {
    const result = await invoke({ action: 'getMe', payload: {} }, label)
    const body = result.body
    if (result.error || result.status !== 200 || !isEnvelope(body) || body.error !== null ||
      !hasKeys(body.data, ['nickname', 'emailMasked', 'isAdmin']) ||
      typeof body.data.nickname !== 'string' || body.data.nickname.length < 3 || body.data.nickname.length > 30 ||
      body.data.emailMasked !== '***@ou.edu.vn' || typeof body.data.isAdmin !== 'boolean' ||
      hasPrivateIdentity(body, identity) || (nickname !== undefined && nickname !== body.data.nickname)) {
      const diagnostic = classify(body, result.response)
      fail(label, report, result.status, diagnostic.source, diagnostic.code)
    }
    nickname = body.data.nickname
    report(`PASS: ${label}, DTO đúng allowlist và nickname ổn định; code=OK; http=200.`)
  }

  async function requireOriginalSession(label: string): Promise<void> {
    try {
      const current = await client.auth.getSession()
      if (!current.error && current.data.session?.access_token === identity.accessToken &&
        current.data.session.user.id === identity.userId) return
    } catch { /* Lỗi SDK được lọc, không log session/error. */ }
    fail(label, report, undefined, 'unknown', 'SESSION_CHANGED_OR_UNVERIFIED')
  }

  async function requireDenied(response: Response, body: unknown, expectation: 'missing-jwt' | 'invalid-jwt' | 'validation', label: string): Promise<void> {
    const diagnostic = classify(body, response)
    const status = expectation === 'validation' ? 400 : 401
    let expected = false
    if (diagnostic.source === 'handler') {
      expected = diagnostic.code === (expectation === 'validation' ? 'VALIDATION_ERROR' : 'UNAUTHENTICATED')
    } else if (diagnostic.source === 'gateway' && expectation !== 'validation') {
      const legacyMessage = isObject(body) ? body.message ?? body.msg : undefined
      const legacyMatches = diagnostic.code === 'GATEWAY_JWT_REJECTED' &&
        (expectation === 'missing-jwt' ? legacyMessage === 'Missing authorization header'
          : legacyMessage === 'Invalid JWT' || legacyMessage === 'Invalid Token or Protected Header formatting')
      expected = legacyMatches || (expectation === 'missing-jwt' ? diagnostic.code === missingJwtCode : invalidJwtCodes.includes(diagnostic.code))
    }
    const reason = response.status !== status ? 'HTTP_STATUS'
      : response.headers.get('x-relay-error') === 'true' ? 'RELAY_ERROR'
      : !expected ? 'RESPONSE_CLASSIFICATION'
      : hasPrivateIdentity(body, identity) ? 'PRIVATE_IDENTITY' : null
    if (reason) {
      const object = isObject(body) ? body : {}
      const error = isObject(object.error) ? object.error : {}
      const shape = isEnvelope(body) ? 'handler_envelope' : hasKeys(body, ['msg']) ? 'msg_only'
        : hasKeys(body, ['code', 'message']) ? 'code_message' : hasKeys(body, ['message']) ? 'message_only' : 'other'
      const codeType = typeof object.code === 'number' ? 'number' : typeof object.code === 'string' ? 'string' : 'other'
      // Chỉ enum/boolean và mã allowlist; không in raw header, keys hoặc message.
      report(`FAIL: chẩn đoán response; http=${response.status}; shape=${shape}; codeType=${codeType}; headerCode=${safeCode(response.headers.get('sb-error-code'))}; bodyCode=${safeCode(object.code)}; handlerEnvelope=${isEnvelope(body)}; relay=${response.headers.get('x-relay-error') === 'true'}; reason=${reason}; handlerCode=${safeCode(error.code)}; dataNull=${object.data === null}; errorShape=${hasKeys(object.error, ['code', 'message', 'details'])}; messageString=${typeof error.message === 'string'}; detailsNull=${error.details === null}; setCookie=${response.headers.has('set-cookie')}.`)
      fail(label, report, response.status, diagnostic.source, diagnostic.code)
    }
    // fetch riêng không nhập cookie vào SDK; Set-Cookie không chứng minh tạo session.
    await requireOriginalSession(label)
    report(`PASS: ${label}; source=${diagnostic.source}; code=${diagnostic.code}; http=${response.status}.`)
  }

  await requireOriginalSession('Chuẩn bị negative tests')
  // fetch riêng: không để SDK tự bổ sung JWT hợp lệ vào request thiếu/sai Authorization.
  for (const [label, bearer] of [['JWT thiếu', null], ['JWT sai', 'invalid.jwt.signature']] as const) {
    const requestHeaders = new Headers({ apikey: config.publishableKey, 'content-type': 'application/json' })
    if (bearer) requestHeaders.set('authorization', `Bearer ${bearer}`)
    let response: Response
    try {
      response = await fetchRequest(`${config.url}/functions/v1/social-api`, {
        method: 'POST', headers: requestHeaders, body: JSON.stringify({ action: 'getMe', payload: {} }),
        redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(15000),
      })
    } catch { fail(label, report) }
    await requireDenied(response, await readBody(response), bearer ? 'invalid-jwt' : 'missing-jwt', label)
  }

  for (const [label, body] of [
    ['Payload sai', { action: 'getMe', payload: null }],
    ['Action không hỗ trợ', { action: '__t04_unknown__', payload: {} }],
  ] as const) {
    const result = await invoke(body, label)
    if (!result.error) fail(label, report, result.status, 'unknown', 'UNEXPECTED_SUCCESS')
    // invoke đã giữ response HTTP thật; không coi lỗi mạng/relay là từ chối validation.
    await requireDenied(result.response, result.body, 'validation', label)
  }
}
