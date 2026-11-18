import type { CreatePostInput, ImageUpload, PostPublic, SocialApiClient } from '../../shared/api/SocialApiClient.ts'
import { SocialApiError } from '../../shared/api/social-api.ts'
import { draftPayload, validateDraft, type PostDraft } from './post-draft.ts'

interface SubmissionState {
  phase: 'editing' | 'creating' | 'uploading' | 'publishing' | 'failed' | 'success'
  locked: boolean
  postId: string | null
  error: string
  images: DraftImage[]
  attachmentsLocked: boolean
}
interface DraftImage { file:Blob; preview:string; position:number; status:'selected'|'uploading'|'finalizing'|'ready'|'removing'|'error'; upload?:ImageUpload; attempted?:boolean }
type SubmissionApi = Pick<SocialApiClient,'createPost'|'publishPost'> & Partial<Pick<SocialApiClient,'createImageUpload'|'uploadImage'|'finalizeImage'|'removeDraftImage'>>
export function createPostSubmission(api: SubmissionApi, isCurrent: () => boolean, reject: (error: unknown) => void, newKey: () => string = () => crypto.randomUUID()) {
  let state: SubmissionState = { phase: 'editing', locked: false, postId: null, error: '', images:[], attachmentsLocked:false }
  let payload: Readonly<CreatePostInput> | null = null
  let busy = false
  const listeners = new Set<() => void>()
  const emit = (patch: Partial<SubmissionState>) => { state = { ...state, ...patch }; listeners.forEach(listener => listener()) }
  const progress=(image:DraftImage,status:DraftImage['status'])=>emit({images:state.images.map(item=>item===image ? Object.assign(image,{status}) : item)})
  async function reserve(image:DraftImage) {
    image.attempted=true
    const upload=await api.createImageUpload!({postId:state.postId!,mimeType:image.file.type,sizeBytes:image.file.size,position:image.position})
    if(!isCurrent()) return false
    image.upload=upload; return true
  }
  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    addImage(file:Blob,preview:string) {
      if(busy || state.attachmentsLocked || state.phase==='success' || !isCurrent() || state.images.length>=2 || !['image/jpeg','image/png','image/webp'].includes(file.type) || file.size<1 || file.size>2097152) return false
      const position=state.images.some(image=>image.position===1)?2:1
      const image:DraftImage={file,preview,position,status:'selected'}
      emit({images:[...state.images,image].sort((a,b)=>a.position-b.position)}); return true
    },
    async removeImage(position:number) {
      if(busy || state.attachmentsLocked || state.phase==='success' || !isCurrent()) return
      const image=state.images.find(item=>item.position===position); if(!image) return
      busy=true; progress(image,'removing')
      try {
        if(state.postId && image.attempted) {
          if(!image.upload && !await reserve(image)) return
          await api.removeDraftImage!(state.postId,image.upload!.imageId)
          if(!isCurrent()) return
        }
        URL.revokeObjectURL(image.preview)
        emit({images:state.images.filter(item=>item!==image),error:''})
      } catch(error) { if(isCurrent()) { reject(error); progress(image,'error'); emit({error:'Chưa gỡ được ảnh. Hãy thử gỡ lại trước khi đăng.'}) } }
      finally {busy=false}
    },
    dispose() {state.images.forEach(image=>URL.revokeObjectURL(image.preview))},
    async submit(draft: PostDraft): Promise<PostPublic | undefined> {
      if (busy || state.phase === 'success' || !isCurrent() || state.images.some(image=>image.status==='removing')) return
      if (!payload && Object.keys(validateDraft(draft)).length) return
      // Chỉ giữ trong bộ nhớ: retry không được thay key hoặc nội dung sau khi đã gửi.
      payload ??= Object.freeze({ ...draftPayload(draft), idempotencyKey: newKey() })
      busy = true
      emit({ locked: true, error: '', phase: state.postId ? 'publishing' : 'creating' })
      try {
        if (!state.postId) {
          const ack = await api.createPost(payload)
          if (!isCurrent()) return
          emit({ postId: ack.postId })
        }
        for(const image of state.images) {
          if(image.status==='ready') continue
          emit({phase:'uploading'}); progress(image,'uploading')
          try {
            // Retry finalize trước: ACK upload/finalize mất không được ghi đè object đã có.
            if(image.upload) {
              try { await api.finalizeImage!(state.postId!,image.upload.imageId); if(!isCurrent()) return; progress(image,'ready'); continue }
              catch(error) { if(!(error instanceof SocialApiError) || error.code!=='UPLOAD_ERROR') throw error }
            }
            if(!await reserve(image)) return
            let uploadError:unknown
            try {await api.uploadImage!(image.upload!,image.file)} catch(error) {uploadError=error}
            if(!isCurrent()) return
            progress(image,'finalizing')
            try {await api.finalizeImage!(state.postId!,image.upload!.imageId)} catch(error) {throw uploadError ?? error}
            if(!isCurrent()) return
            progress(image,'ready')
          } catch(error) {if(isCurrent()) progress(image,'error'); throw error}
        }
        emit({phase:'publishing',attachmentsLocked:true})
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
