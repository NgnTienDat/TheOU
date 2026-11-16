import type { CreatePostInput, DisplayMode, PostTag } from '../../shared/api/SocialApiClient.ts'
import { postTags } from '../../shared/constants/posts.ts'

export interface PostDraft { body: string; tag: PostTag; displayMode: DisplayMode; contactUrl: string }
export const emptyDraft: PostDraft = { body: '', tag: 'CONFESSION', displayMode: 'ANONYMOUS', contactUrl: '' }
export const bodyLength = (body: string) => [...body.trim()].length
export const allowsContact = (draft: Pick<PostDraft, 'tag' | 'displayMode'>) => draft.displayMode === 'NICKNAME' && ['TAI_LIEU', 'TIM_TRO'].includes(draft.tag)
export function changeDraft(draft: PostDraft, patch: Partial<PostDraft>): PostDraft {
  const next = { ...draft, ...patch }
  if (!allowsContact(next)) next.contactUrl = ''
  return next
}
export function validateDraft(draft: PostDraft) {
  const errors: Partial<Record<keyof PostDraft, string>> = {}
  if (bodyLength(draft.body) < 1 || bodyLength(draft.body) > 1000) errors.body = 'Nội dung cần từ 1 đến 1.000 ký tự.'
  else if (draft.body.includes(String.fromCharCode(0)) || /[\uD800-\uDFFF]/u.test(draft.body)) errors.body = 'Nội dung có ký tự không hợp lệ. Vui lòng kiểm tra lại.'
  if (!Object.hasOwn(postTags, draft.tag)) errors.tag = 'Hãy chọn một chủ đề hợp lệ.'
  if (!['ANONYMOUS', 'NICKNAME'].includes(draft.displayMode)) errors.displayMode = 'Hãy chọn cách hiển thị tên.'
  if (allowsContact(draft) && draft.contactUrl) {
    try {
      const url = new URL(draft.contactUrl)
      if (draft.contactUrl.length > 2048 || /[\s\p{Cc}]/u.test(draft.contactUrl) || url.protocol !== 'https:' ||
        url.username || url.password || url.port || !['zalo.me', 'facebook.com', 'www.facebook.com', 'm.facebook.com', 'm.me'].includes(url.hostname)) throw new Error()
    } catch { errors.contactUrl = 'Dùng liên kết HTTPS từ Zalo, Facebook hoặc Messenger, không chứa thông tin đăng nhập.' }
  }
  return errors
}
export function draftPayload(draft: PostDraft): Omit<CreatePostInput, 'idempotencyKey'> {
  return { body: draft.body.trim(), tag: draft.tag, displayMode: draft.displayMode,
    ...(allowsContact(draft) && draft.contactUrl ? { contactUrl: new URL(draft.contactUrl).href } : {}) }
}
