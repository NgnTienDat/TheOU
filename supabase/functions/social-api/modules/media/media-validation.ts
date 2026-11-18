import { ApiError } from '../../shared/response.ts'
import { uuidPattern } from '../posts/post-validation.ts'

export const mediaBucket = 'post-media'
export const maxImageBytes = 2097152
export const imageExtensions = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' } as const
export type ImageMime = keyof typeof imageExtensions
export interface UploadInput {
  postId: string
  mimeType: ImageMime
  sizeBytes: number
  position: number
}
export type MediaRequest =
  | { action: 'createImageUpload'; payload: UploadInput }
  | { action: 'finalizeImage' | 'removeDraftImage'; payload: { postId: string; imageId: string } }
export function validateMedia(action: string, p: Record<string, unknown>): MediaRequest {
  if (typeof p.postId !== 'string' || !uuidPattern.test(p.postId)) throw new ApiError('VALIDATION_ERROR')
  if (
    action === 'createImageUpload' && Object.keys(p).sort().join() === 'mimeType,position,postId,sizeBytes' &&
    typeof p.mimeType === 'string' && Object.hasOwn(imageExtensions, p.mimeType) &&
    Number.isSafeInteger(p.sizeBytes) && Number(p.sizeBytes) > 0 && Number(p.sizeBytes) <= maxImageBytes &&
    (p.position === 1 || p.position === 2)
  ) return { action, payload: { ...p, postId: p.postId.toLowerCase() } as unknown as UploadInput }
  if (
    (action === 'finalizeImage' || action === 'removeDraftImage') &&
    Object.keys(p).sort().join() === 'imageId,postId' &&
    typeof p.imageId === 'string' && uuidPattern.test(p.imageId)
  ) return { action, payload: { postId: p.postId.toLowerCase(), imageId: p.imageId.toLowerCase() } }
  throw new ApiError('VALIDATION_ERROR')
}
