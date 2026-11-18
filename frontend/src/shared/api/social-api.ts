import type { SupabaseClient } from '@supabase/supabase-js'
import type { CommentPublic, ImageUpload, Me, Page, PostPublic, PublicImage, SocialApiClient, UpvoteState } from './SocialApiClient.ts'

export type ClientErrorCode = 'UNAUTHENTICATED' | 'FORBIDDEN' | 'VALIDATION_ERROR' | 'NOT_FOUND' | 'CONFLICT' | 'INTERNAL_ERROR' | 'UPLOAD_ERROR'
const messages = {
  UPLOAD_ERROR: 'Chưa thể xác nhận hoặc tải ảnh. Vui lòng thử lại hoặc gỡ ảnh khỏi bản nháp.',
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
type Action = Exclude<keyof SocialApiClient, 'setUpvote' | 'uploadImage'> | 'toggleUpvote'
type Data = Me | ImageUpload | {imageId:string;status:'READY'} | { nickname: string } | PostPublic | CommentPublic | Page<PostPublic> | Page<CommentPublic> | UpvoteState | { success: true } | { postId: string; status: 'DRAFT' }
const uuid = /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i
function parseImage(value: unknown, postId: string): PublicImage {
  if (!object(value) || !keys(value,['id','signedUrl','expiresAt']) || typeof value.id !== 'string' || !uuid.test(value.id) ||
    typeof value.signedUrl !== 'string' || typeof value.expiresAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(value.expiresAt) || !Number.isFinite(Date.parse(value.expiresAt))) throw new SocialApiError('INTERNAL_ERROR')
  try {
    const url = new URL(value.signedUrl)
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash ||
      url.pathname !== `/storage/v1/object/sign/post-media/posts/${postId}/${value.id}.${url.pathname.split('.').at(-1)}` ||
      !/\.(jpg|png|webp)$/.test(url.pathname) || !url.searchParams.get('token') || [...url.searchParams.keys()].join() !== 'token') throw new Error()
  } catch { throw new SocialApiError('INTERNAL_ERROR') }
  return {id:value.id,signedUrl:value.signedUrl,expiresAt:value.expiresAt}
}
function parseComment(value: unknown): CommentPublic {
  if (!object(value) || !keys(value, ['id','postId','body','authorLabel','isOriginalPoster','isMine','createdAt']) ||
    typeof value.id !== 'string' || !uuid.test(value.id) || typeof value.postId !== 'string' || !uuid.test(value.postId) ||
    typeof value.body !== 'string' || [...value.body].length < 1 || [...value.body].length > 500 ||
    typeof value.isOriginalPoster !== 'boolean' || typeof value.isMine !== 'boolean' || value.authorLabel !== (value.isOriginalPoster ? 'Chủ bài' : 'OUer ẩn danh') ||
    typeof value.createdAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(value.createdAt) || !Number.isFinite(Date.parse(value.createdAt))) throw new SocialApiError('INTERNAL_ERROR')
  return { id: value.id, postId: value.postId, body: value.body, authorLabel: value.authorLabel as string, isOriginalPoster: value.isOriginalPoster, isMine: value.isMine, createdAt: value.createdAt }
}
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
    typeof value.hasUpvoted !== 'boolean' || typeof value.isMine !== 'boolean' || !Array.isArray(value.images) || value.images.length > 2) throw new SocialApiError('INTERNAL_ERROR')
  if (value.contactUrl !== null) {
    try {
      if (typeof value.contactUrl !== 'string' || value.contactUrl.length > 2048 || /[\s\p{Cc}]/u.test(value.contactUrl) ||
        value.displayMode !== 'NICKNAME' || !['TAI_LIEU','TIM_TRO'].includes(value.tag as string)) throw new Error()
      const url = new URL(value.contactUrl)
      if (url.protocol !== 'https:' || url.username || url.password || url.port ||
        !['zalo.me','facebook.com','www.facebook.com','m.facebook.com','m.me'].includes(url.hostname)) throw new Error()
    } catch { throw new SocialApiError('INTERNAL_ERROR') }
  }
  if(new Set(value.images.map(image => object(image)?image.id:undefined)).size!==value.images.length)throw new SocialApiError('INTERNAL_ERROR')
  return { id: value.id, tag: value.tag as PostPublic['tag'], body: value.body, displayMode: value.displayMode as PostPublic['displayMode'],
    authorLabel: value.authorLabel, contactUrl: value.contactUrl as string | null, publishedAt: value.publishedAt,
    upvoteCount: value.upvoteCount as number, commentCount: value.commentCount as number, hasUpvoted: value.hasUpvoted, isMine: value.isMine, images: value.images.map(image => parseImage(image,value.id as string)) }
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
    if (status === 422 && object(body.error) && body.error.code === 'UPLOAD_ERROR') throw new SocialApiError('UPLOAD_ERROR')
    if (status === 400 && object(body.error) && body.error.code === 'VALIDATION_ERROR') throw new SocialApiError('VALIDATION_ERROR')
    throw new SocialApiError('INTERNAL_ERROR')
  }
  const data = body.data
  if (status !== 200) throw new SocialApiError('INTERNAL_ERROR')
  if (action === 'createImageUpload') {
    if (!object(data) || !keys(data,['imageId','path','token']) || typeof data.imageId !== 'string' || !uuid.test(data.imageId) ||
      typeof data.path !== 'string' || !new RegExp(`^posts/[\\da-f-]{36}/${data.imageId}\\.(jpg|png|webp)$`).test(data.path) || typeof data.token !== 'string' || !data.token || data.token.length > 8192) throw new SocialApiError('INTERNAL_ERROR')
    return {imageId:data.imageId,path:data.path,token:data.token}
  }
  if (action === 'finalizeImage') {
    if (!object(data) || !keys(data,['imageId','status']) || typeof data.imageId !== 'string' || !uuid.test(data.imageId) || data.status !== 'READY') throw new SocialApiError('INTERNAL_ERROR')
    return {imageId:data.imageId,status:'READY'}
  }
  if (action === 'toggleUpvote') {
    if (!object(data) || !keys(data, ['hasUpvoted','upvoteCount']) || typeof data.hasUpvoted !== 'boolean' ||
      !Number.isSafeInteger(data.upvoteCount) || Number(data.upvoteCount) < 0) throw new SocialApiError('INTERNAL_ERROR')
    return { hasUpvoted: data.hasUpvoted, upvoteCount: data.upvoteCount as number }
  }
  if (action === 'createComment') return parseComment(data)
  if (action === 'deleteComment' || action === 'removeDraftImage') {
    if (!object(data) || !keys(data,['success']) || data.success !== true) throw new SocialApiError('INTERNAL_ERROR')
    return { success: true }
  }
  if (action === 'getPost' || action === 'publishPost') return parsePost(data)
  if (action === 'createPost') {
    if (!object(data) || !keys(data,['postId','status']) || typeof data.postId !== 'string' || !uuid.test(data.postId) || data.status !== 'DRAFT') throw new SocialApiError('INTERNAL_ERROR')
    return { postId:data.postId,status:'DRAFT' }
  }
  if (action === 'listPosts' || action === 'listComments') {
    if (!object(data) || !keys(data,['items','nextCursor']) || !Array.isArray(data.items) || data.items.length > 20 ||
      (data.nextCursor !== null && (typeof data.nextCursor !== 'string' || data.nextCursor.length < 1 || data.nextCursor.length > 1024))) throw new SocialApiError('INTERNAL_ERROR')
    return action === 'listPosts' ? { items:data.items.map(parsePost),nextCursor:data.nextCursor as string|null }
      : { items:data.items.map(parseComment),nextCursor:data.nextCursor as string|null }
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
export function createSocialApi(client: SupabaseClient, accessToken?: string): SocialApiClient {
  async function invoke(action: Action, payload: object) {
    try {
      const { data, error, response } = await client.functions.invoke('social-api', {
        body: { action, payload }, timeout: 15_000,
        // Gắn request với phiên lúc bắt đầu, không lấy nhầm JWT của tài khoản mới khi retry.
        ...(accessToken ? { headers: { Authorization: `Bearer ${accessToken}` } } : {}),
      })
      if (error) {
        if (response?.status === 422) throw new SocialApiError('UPLOAD_ERROR')
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
    createImageUpload: async input => {
      const upload = await invoke('createImageUpload',input) as ImageUpload
      if (!upload.path.startsWith(`posts/${input.postId}/`) || !upload.path.endsWith(`.${({'image/jpeg':'jpg','image/png':'png','image/webp':'webp'} as Record<string,string>)[input.mimeType]}`)) throw new SocialApiError('INTERNAL_ERROR')
      return upload
    },
    uploadImage: async (upload,file) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const r = await Promise.race([
          client.storage.from('post-media').uploadToSignedUrl(upload.path,upload.token,file,{contentType:file.type,cacheControl:'300',upsert:false}),
          new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new SocialApiError('UPLOAD_ERROR')),30000)}),
        ])
        if (r.error) throw new SocialApiError('UPLOAD_ERROR')
      } catch { throw new SocialApiError('UPLOAD_ERROR') }
      finally {clearTimeout(timer)}
    },
    finalizeImage: async (postId,imageId) => {
      const r = await invoke('finalizeImage',{postId,imageId}) as {imageId:string;status:'READY'}
      if (r.imageId !== imageId) throw new SocialApiError('INTERNAL_ERROR')
      return r
    },
    removeDraftImage: async (postId,imageId) => await invoke('removeDraftImage',{postId,imageId}) as {success:true},
    setUpvote: async (postId, desiredState) => {
      if (!uuid.test(postId) || typeof desiredState !== 'boolean') throw new SocialApiError('VALIDATION_ERROR')
      return await invoke('toggleUpvote', { postId, desiredState }) as UpvoteState
    },
    getMe: async () => await invoke('getMe', {}) as Me,
    updateNickname: async (nickname) => await invoke('updateNickname', { nickname }) as { nickname: string },
    createPost: async (input) => await invoke('createPost', input) as { postId: string; status: 'DRAFT' },
    publishPost: async (postId) => await invoke('publishPost', { postId }) as PostPublic,
    listPosts: async (input) => await invoke('listPosts', input) as Page<PostPublic>,
    getPost: async (postId) => await invoke('getPost', { postId }) as PostPublic,
    listComments: async (input) => {
      const page = await invoke('listComments', input) as Page<CommentPublic>
      if (page.items.some(comment => comment.postId !== input.postId)) throw new SocialApiError('INTERNAL_ERROR')
      return page
    },
    createComment: async (input) => {
      const comment = await invoke('createComment', input) as CommentPublic
      if (comment.postId !== input.postId) throw new SocialApiError('INTERNAL_ERROR')
      return comment
    },
    deleteComment: async (commentId) => await invoke('deleteComment', { commentId }) as { success: true },
  }
}
