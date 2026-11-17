import type { CreateCommentInput, SocialApiClient } from '../../shared/api/SocialApiClient.ts'
import { SocialApiError } from '../../shared/api/social-api.ts'

export function commentBodyError(body: string) {
  const text = body.trim()
  if ([...text].length < 1 || [...text].length > 500) return 'Bình luận cần từ 1 đến 500 ký tự.'
  if (text.includes(String.fromCharCode(0)) || /[\uD800-\uDFFF]/u.test(text)) return 'Bình luận có ký tự không hợp lệ.'
  return ''
}
export function createCommentSubmission(api: Pick<SocialApiClient,'createComment'>, postId: string, isCurrent: () => boolean, reject: (error: unknown) => void, newKey: () => string = () => crypto.randomUUID()) {
  let state = { busy:false, locked:false, error:'' }
  let payload: Readonly<CreateCommentInput>|null = null
  const listeners = new Set<() => void>()
  const emit = (patch: Partial<typeof state>) => { state={...state,...patch}; listeners.forEach(listener=>listener()) }
  return { getSnapshot:()=>state, subscribe:(listener:()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener)}},
    async submit(body: string) {
      if (state.busy || !isCurrent() || (!payload && commentBodyError(body))) return
      payload ??= Object.freeze({postId,body:body.trim(),idempotencyKey:newKey()})
      emit({busy:true,locked:true,error:''})
      try {
        const comment=await api.createComment(payload)
        if (!isCurrent()) return
        payload=null; emit({busy:false,locked:false}); return comment
      } catch (error) {
        if (!isCurrent()) return
        reject(error); emit({busy:false,error:error instanceof SocialApiError?error.message:'Chưa xác nhận được kết quả. Hãy thử lại cùng bình luận.'})
      }
    },
  }
}
