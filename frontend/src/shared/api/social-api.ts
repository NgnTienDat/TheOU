import type { SupabaseClient } from '@supabase/supabase-js'
import type { Me, Page, PostPublic, SocialApiClient } from './SocialApiClient.ts'

export type ClientErrorCode = 'UNAUTHENTICATED' | 'FORBIDDEN' | 'VALIDATION_ERROR' | 'NOT_FOUND' | 'CONFLICT' | 'INTERNAL_ERROR'
const messages = {
  UNAUTHENTICATED: 'Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.',
  FORBIDDEN: 'Tài khoản không đủ điều kiện truy cập TheOU hoặc đã bị khóa.',
  VALIDATION_ERROR: 'Yêu cầu chưa hợp lệ. Vui lòng kiểm tra và thử lại.',
  NOT_FOUND: 'Không tìm thấy nội dung hoặc bạn không được phép truy cập.',
  CONFLICT: 'Yêu cầu trùng với nội dung khác hoặc trạng thái bài đã thay đổi. Vui lòng tải lại.',
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
type ImplementedApi = Pick<SocialApiClient, 'getMe' | 'updateNickname' | 'createPost' | 'publishPost' | 'listPosts' | 'getPost'>
type Action = keyof ImplementedApi
type Data = Me | { nickname: string } | PostPublic | Page<PostPublic> | { postId: string; status: 'DRAFT' }
const uuid = /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i
function parsePost(value: unknown): PostPublic {
  if (!object(value) || !keys(value, ['id','tag','body','displayMode','authorLabel','contactUrl','publishedAt','upvoteCount','commentCount','hasUpvoted','isMine','images']) ||
    typeof value.id !== 'string' || !uuid.test(value.id) || typeof value.tag !== 'string' || !['CONFESSION','REVIEW_MON','TAI_LIEU','TIM_TRO','HOI_GAP'].includes(value.tag) ||
    typeof value.body !== 'string' || [...value.body].length < 1 || [...value.body].length > 1000 ||
    typeof value.displayMode !== 'string' || !['ANONYMOUS','NICKNAME'].includes(value.displayMode) || typeof value.authorLabel !== 'string' ||
    (value.displayMode === 'ANONYMOUS' && (value.authorLabel !== 'OUer ẩn danh' || value.contactUrl !== null)) ||
    (value.displayMode === 'NICKNAME' && ([...value.authorLabel].length < 3 || [...value.authorLabel].length > 30)) ||
    typeof value.publishedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(value.publishedAt) ||
    !Number.isFinite(Date.parse(value.publishedAt)) || !Number.isSafeInteger(value.upvoteCount) || Number(value.upvoteCount) < 0 ||
    !Number.isSafeInteger(value.commentCount) || Number(value.commentCount) < 0 ||
    typeof value.hasUpvoted !== 'boolean' || typeof value.isMine !== 'boolean' || !Array.isArray(value.images) || value.images.length !== 0) throw new SocialApiError('INTERNAL_ERROR')
  if (value.contactUrl !== null) {
    try {
      if (typeof value.contactUrl !== 'string' || value.contactUrl.length > 2048 || /[\s\p{Cc}]/u.test(value.contactUrl) ||
        value.displayMode !== 'NICKNAME' || !['TAI_LIEU','TIM_TRO'].includes(value.tag as string)) throw new Error()
      const url = new URL(value.contactUrl)
      if (url.protocol !== 'https:' || url.username || url.password || url.port ||
        !['zalo.me','facebook.com','www.facebook.com','m.facebook.com','m.me'].includes(url.hostname)) throw new Error()
    } catch { throw new SocialApiError('INTERNAL_ERROR') }
  }
  return { id: value.id, tag: value.tag as PostPublic['tag'], body: value.body, displayMode: value.displayMode as PostPublic['displayMode'],
    authorLabel: value.authorLabel, contactUrl: value.contactUrl as string | null, publishedAt: value.publishedAt,
    upvoteCount: value.upvoteCount as number, commentCount: value.commentCount as number, hasUpvoted: value.hasUpvoted, isMine: value.isMine, images: [] }
}
export function parseSocialResponse(body: unknown, status: number, action: Action): Data {
  if (status === 401) throw new SocialApiError('UNAUTHENTICATED')
  if (status === 403) throw new SocialApiError('FORBIDDEN')
  if (status === 404) throw new SocialApiError('NOT_FOUND')
  if (status === 409) throw new SocialApiError('CONFLICT')
  if (!object(body) || !keys(body, ['data', 'error', 'meta']) || !object(body.meta) ||
    !keys(body.meta, ['requestId']) || typeof body.meta.requestId !== 'string' ||
    !/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(body.meta.requestId)) throw new SocialApiError('INTERNAL_ERROR')
  if (body.error !== null) {
    if (status === 400 && object(body.error) && body.error.code === 'VALIDATION_ERROR') throw new SocialApiError('VALIDATION_ERROR')
    throw new SocialApiError('INTERNAL_ERROR')
  }
  const data = body.data
  if (status !== 200) throw new SocialApiError('INTERNAL_ERROR')
  if (action === 'getPost' || action === 'publishPost') return parsePost(data)
  if (action === 'createPost') {
    if (!object(data) || !keys(data,['postId','status']) || typeof data.postId !== 'string' || !uuid.test(data.postId) || data.status !== 'DRAFT') throw new SocialApiError('INTERNAL_ERROR')
    return { postId:data.postId,status:'DRAFT' }
  }
  if (action === 'listPosts') {
    if (!object(data) || !keys(data,['items','nextCursor']) || !Array.isArray(data.items) || data.items.length > 20 ||
      (data.nextCursor !== null && (typeof data.nextCursor !== 'string' || data.nextCursor.length < 1 || data.nextCursor.length > 1024))) throw new SocialApiError('INTERNAL_ERROR')
    return { items:data.items.map(parsePost),nextCursor:data.nextCursor as string|null }
  }
  if (status !== 200 || !object(data) || typeof data.nickname !== 'string' ||
    [...data.nickname].length < 3 || [...data.nickname].length > 30) throw new SocialApiError('INTERNAL_ERROR')
  if (action === 'updateNickname' && keys(data, ['nickname'])) return { nickname: data.nickname }
  if (action === 'getMe' && keys(data, ['nickname', 'emailMasked', 'isAdmin']) &&
    data.emailMasked === '***@ou.edu.vn' && typeof data.isAdmin === 'boolean') {
    return { nickname: data.nickname, emailMasked: data.emailMasked, isAdmin: data.isAdmin }
  }
  throw new SocialApiError('INTERNAL_ERROR')
}
export function createSocialApi(client: SupabaseClient): ImplementedApi {
  async function invoke(action: Action, payload: object) {
    try {
      const { data, error, response } = await client.functions.invoke('social-api', { body: { action, payload } })
      if (error) {
        if (response?.status === 401) throw new SocialApiError('UNAUTHENTICATED')
        if (response?.status === 403) throw new SocialApiError('FORBIDDEN')
        if (response?.status === 400) throw new SocialApiError('VALIDATION_ERROR')
        if (response?.status === 404) throw new SocialApiError('NOT_FOUND')
        if (response?.status === 409) throw new SocialApiError('CONFLICT')
        throw new SocialApiError('INTERNAL_ERROR')
      }
      return parseSocialResponse(data, response?.status ?? 200, action)
    } catch (error) { throw error instanceof SocialApiError ? error : new SocialApiError('INTERNAL_ERROR') }
  }
  return {
    getMe: async () => await invoke('getMe', {}) as Me,
    updateNickname: async (nickname) => await invoke('updateNickname', { nickname }) as { nickname: string },
    createPost: async (input) => await invoke('createPost', input) as { postId: string; status: 'DRAFT' },
    publishPost: async (postId) => await invoke('publishPost', { postId }) as PostPublic,
    listPosts: async (input) => await invoke('listPosts', input) as Page<PostPublic>,
    getPost: async (postId) => await invoke('getPost', { postId }) as PostPublic,
  }
}
