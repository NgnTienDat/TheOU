import type { CreatePostInput, PostPublic, SocialApiClient } from '../../shared/api/SocialApiClient.ts'
import { SocialApiError } from '../../shared/api/social-api.ts'
import { draftPayload, validateDraft, type PostDraft } from './post-draft.ts'

interface SubmissionState {
  phase: 'editing' | 'creating' | 'publishing' | 'failed' | 'success'
  locked: boolean
  postId: string | null
  error: string
}
export function createPostSubmission(api: Pick<SocialApiClient, 'createPost' | 'publishPost'>, isCurrent: () => boolean, reject: (error: unknown) => void, newKey: () => string = () => crypto.randomUUID()) {
  let state: SubmissionState = { phase: 'editing', locked: false, postId: null, error: '' }
  let payload: Readonly<CreatePostInput> | null = null
  let busy = false
  const listeners = new Set<() => void>()
  const emit = (patch: Partial<SubmissionState>) => { state = { ...state, ...patch }; listeners.forEach(listener => listener()) }
  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    async submit(draft: PostDraft): Promise<PostPublic | undefined> {
      if (busy || state.phase === 'success' || !isCurrent()) return
      if (!payload && Object.keys(validateDraft(draft)).length) return
      // Chỉ giữ trong bộ nhớ: retry không được thay key hoặc nội dung sau khi đã gửi.
      payload ??= Object.freeze({ ...draftPayload(draft), idempotencyKey: newKey() })
      busy = true
      emit({ locked: true, error: '', phase: state.postId ? 'publishing' : 'creating' })
      try {
        if (!state.postId) {
          const ack = await api.createPost(payload)
          if (!isCurrent()) return
          emit({ postId: ack.postId, phase: 'publishing' })
        }
        const post = await api.publishPost(state.postId!)
        if (!isCurrent()) return
        emit({ phase: 'success' }); return post
      } catch (error) {
        if (!isCurrent()) return
        reject(error)
        emit({ phase: 'failed', error: error instanceof SocialApiError ? error.message : 'Chưa xác nhận được kết quả đăng bài. Vui lòng thử lại cùng yêu cầu.' })
      } finally { busy = false }
    },
  }
}
