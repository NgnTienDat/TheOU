import type { SupabaseClient } from '@supabase/supabase-js'
import type { Me, SocialApiClient } from './SocialApiClient.ts'

export type ClientErrorCode = 'UNAUTHENTICATED' | 'FORBIDDEN' | 'VALIDATION_ERROR' | 'INTERNAL_ERROR'
const messages = {
  UNAUTHENTICATED: 'Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.',
  FORBIDDEN: 'Tài khoản không đủ điều kiện truy cập TheOU hoặc đã bị khóa.',
  VALIDATION_ERROR: 'Yêu cầu chưa hợp lệ. Vui lòng kiểm tra và thử lại.',
  INTERNAL_ERROR: 'Không thể kết nối hệ thống. Vui lòng thử lại.',
}
export class SocialApiError extends Error {
  readonly code: ClientErrorCode
  constructor(code: ClientErrorCode) { super(messages[code]); this.code = code }
}
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
function keys(value: Record<string, unknown>, names: string[]) {
  return Object.keys(value).sort().join(',') === names.sort().join(',')
}
export function parseSocialResponse(body: unknown, status: number, action: 'getMe' | 'updateNickname'): Me | { nickname: string } {
  if (status === 401) throw new SocialApiError('UNAUTHENTICATED')
  if (status === 403) throw new SocialApiError('FORBIDDEN')
  if (!object(body) || !keys(body, ['data', 'error', 'meta']) || !object(body.meta) ||
    !keys(body.meta, ['requestId']) || typeof body.meta.requestId !== 'string' ||
    !/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(body.meta.requestId)) throw new SocialApiError('INTERNAL_ERROR')
  if (body.error !== null) {
    if (status === 400 && object(body.error) && body.error.code === 'VALIDATION_ERROR') throw new SocialApiError('VALIDATION_ERROR')
    throw new SocialApiError('INTERNAL_ERROR')
  }
  const data = body.data
  if (status !== 200 || !object(data) || typeof data.nickname !== 'string' ||
    [...data.nickname].length < 3 || [...data.nickname].length > 30) throw new SocialApiError('INTERNAL_ERROR')
  if (action === 'updateNickname' && keys(data, ['nickname'])) return { nickname: data.nickname }
  if (action === 'getMe' && keys(data, ['nickname', 'emailMasked', 'isAdmin']) &&
    data.emailMasked === '***@ou.edu.vn' && typeof data.isAdmin === 'boolean') {
    return { nickname: data.nickname, emailMasked: data.emailMasked, isAdmin: data.isAdmin }
  }
  throw new SocialApiError('INTERNAL_ERROR')
}
export function createProfileApi(client: SupabaseClient): Pick<SocialApiClient, 'getMe' | 'updateNickname'> {
  async function invoke(action: 'getMe' | 'updateNickname', payload: object) {
    try {
      const { data, error, response } = await client.functions.invoke('social-api', { body: { action, payload } })
      if (error) {
        if (response?.status === 401) throw new SocialApiError('UNAUTHENTICATED')
        if (response?.status === 403) throw new SocialApiError('FORBIDDEN')
        if (response?.status === 400) throw new SocialApiError('VALIDATION_ERROR')
        throw new SocialApiError('INTERNAL_ERROR')
      }
      return parseSocialResponse(data, response?.status ?? 200, action)
    } catch (error) { throw error instanceof SocialApiError ? error : new SocialApiError('INTERNAL_ERROR') }
  }
  return {
    getMe: async () => await invoke('getMe', {}) as Me,
    updateNickname: async (nickname) => await invoke('updateNickname', { nickname }) as { nickname: string },
  }
}
