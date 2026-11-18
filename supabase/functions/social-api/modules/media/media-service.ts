import type { SupabaseClient } from '@supabase/supabase-js'
import { ApiError } from '../../shared/response.ts'
import { imageExtensions, type ImageMime, type UploadInput } from './media-validation.ts'
import { privateBucket, readImageSeconds, verifyObject } from './storage.ts'
import { uuidPattern } from '../posts/post-validation.ts'

interface Context {
  client: SupabaseClient
  userId: string
  signal: AbortSignal
}
export interface ImageRow {
  id: string
  post_id: string
  storage_path: string
  mime_type: ImageMime
  size_bytes: number
  position: number
  status: string
}
export const imageColumns = 'id,post_id,storage_path,mime_type,size_bytes,position,status'
export interface PublicImage {
  id: string
  signedUrl: string
  expiresAt: string
}
function dbError(code?: string): never {
  throw new ApiError(
    code === '42501' ? 'FORBIDDEN' : code === '23514' || code === '23505' ? 'CONFLICT' : 'INTERNAL_ERROR',
  )
}
async function ownDraft(ctx: Context, postId: string) {
  const r = await ctx.client.from('posts').select('id,author_id,status').eq('id', postId).eq(
    'author_id',
    ctx.userId,
  ).abortSignal(ctx.signal).maybeSingle()
  if (r.error) dbError(r.error.code)
  if (!r.data) throw new ApiError('NOT_FOUND')
  if (r.data.status !== 'DRAFT') throw new ApiError('CONFLICT')
}
async function image(ctx: Context, postId: string, imageId: string): Promise<ImageRow> {
  const r = await ctx.client.from('post_images').select(imageColumns).eq('post_id', postId).eq('id', imageId)
    .abortSignal(ctx.signal).maybeSingle()
  if (r.error) dbError(r.error.code)
  if (!r.data) throw new ApiError('NOT_FOUND')
  return r.data as ImageRow
}
async function transition(ctx: Context, row: ImageRow, from: string, to: string) {
  const r = await ctx.client.from('post_images').update({ status: to }).eq('id', row.id).eq(
    'post_id',
    row.post_id,
  ).eq('status', from).select('id').abortSignal(ctx.signal)
  if (r.error) dbError(r.error.code)
  if (!r.data?.length && (await image(ctx, row.post_id, row.id)).status !== to) throw new ApiError('CONFLICT')
}
export async function createImageUpload(ctx: Context, input: UploadInput) {
  await ownDraft(ctx, input.postId)
  const id = crypto.randomUUID()
  const path = `posts/${input.postId}/${id}.${imageExtensions[input.mimeType]}`
  const inserted = await ctx.client.from('post_images').insert({
    id,
    post_id: input.postId,
    storage_path: path,
    mime_type: input.mimeType,
    size_bytes: input.sizeBytes,
    position: input.position,
  }).abortSignal(ctx.signal)
  if (inserted.error && inserted.error.code !== '23505') dbError(inserted.error.code)
  const r = await ctx.client.from('post_images').select(imageColumns).eq('post_id', input.postId).eq(
    'position',
    input.position,
  ).neq('status', 'REMOVED').abortSignal(ctx.signal).maybeSingle()
  if (r.error) dbError(r.error.code)
  const row = r.data as ImageRow | null
  if (
    !row || !['PENDING', 'READY'].includes(row.status) || row.mime_type !== input.mimeType ||
    row.size_bytes !== input.sizeBytes
  ) throw new ApiError('CONFLICT')
  const bucket = await privateBucket(ctx.client)
  const signed = await bucket.createSignedUploadUrl(row.storage_path, { upsert: false })
  if (signed.error || !signed.data || signed.data.path !== row.storage_path || !signed.data.token) {
    throw new ApiError('UPLOAD_ERROR')
  }
  return { imageId: row.id, path: row.storage_path, token: signed.data.token }
}
export async function finalizeImage(ctx: Context, postId: string, imageId: string) {
  await ownDraft(ctx, postId)
  const row = await image(ctx, postId, imageId)
  if (!['PENDING', 'READY'].includes(row.status)) throw new ApiError('CONFLICT')
  await verifyObject(ctx.client, row.storage_path, row.mime_type, row.size_bytes, ctx.signal)
  await transition(ctx, row, row.status, 'READY')
  return { imageId: row.id, status: 'READY' as const }
}
export async function removeDraftImage(ctx: Context, postId: string, imageId: string) {
  await ownDraft(ctx, postId)
  const row = await image(ctx, postId, imageId)
  if (row.status === 'REMOVED') return { success: true as const }
  if (row.status !== 'REMOVING') await transition(ctx, row, row.status, 'REMOVING')
  const bucket = await privateBucket(ctx.client)
  const removed = await bucket.remove([row.storage_path])
  if (
    removed.error &&
    !(removed.error.status === 404 && 'code' in removed.error && removed.error.code === 'NoSuchKey')
  ) throw new ApiError('UPLOAD_ERROR')
  await transition(ctx, row, 'REMOVING', 'REMOVED')
  return { success: true as const }
}
export async function signedImages(
  client: SupabaseClient,
  row: { id: string; post_images: ImageRow[] },
  now: number,
): Promise<PublicImage[]> {
  const images = row.post_images.filter((image) => image.status !== 'REMOVED').sort((a, b) =>
    a.position - b.position
  )
  if (
    images.length > 2 ||
    images.some((image) =>
      !uuidPattern.test(image.id) || image.post_id !== row.id || image.status !== 'READY' ||
      !Object.hasOwn(imageExtensions, image.mime_type) || !Number.isSafeInteger(image.size_bytes) ||
      image.size_bytes < 1 || image.size_bytes > 2097152 ||
      ![1, 2].includes(image.position) ||
      image.storage_path !== `posts/${row.id}/${image.id}.${imageExtensions[image.mime_type]}`
    )
  ) throw new ApiError('INTERNAL_ERROR')
  if (
    new Set(images.map((image) => image.id)).size !== images.length ||
    new Set(images.map((image) => image.position)).size !== images.length
  ) throw new ApiError('INTERNAL_ERROR')
  if (!images.length) return []
  const bucket = await privateBucket(client)
  return await Promise.all(images.map(async (image) => {
    const r = await bucket.createSignedUrl(image.storage_path, readImageSeconds)
    if (r.error || !r.data?.signedUrl) throw new ApiError('UPLOAD_ERROR')
    return {
      id: image.id,
      signedUrl: r.data.signedUrl,
      expiresAt: new Date(now + readImageSeconds * 1000).toISOString(),
    }
  }))
}
