import type { SupabaseClient } from '@supabase/supabase-js'
import { ApiError } from '../../shared/response.ts'
import { imageExtensions, type ImageMime, maxImageBytes, mediaBucket } from './media-validation.ts'

export const readImageSeconds = 300
export async function privateBucket(client: SupabaseClient) {
  const { data, error } = await client.storage.getBucket(mediaBucket)
  if (
    error || !data || data.id !== mediaBucket || data.public !== false ||
    data.file_size_limit !== maxImageBytes ||
    !Array.isArray(data.allowed_mime_types) ||
    data.allowed_mime_types.slice().sort().join() !== Object.keys(imageExtensions).sort().join()
  ) throw new ApiError('UPLOAD_ERROR')
  return client.storage.from(mediaBucket)
}
// Nhận diện container; không coi magic bytes là antivirus hoặc full image decoder.
export function matchesImage(bytes: Uint8Array, mime: ImageMime): boolean {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const dimensions = (w: number, h: number) => w > 0 && h > 0 && w <= 16384 && h <= 16384 && w * h <= 40000000
  if (mime === 'image/jpeg') {
    if (
      bytes.length < 32 || bytes[0] !== 255 || bytes[1] !== 216 || bytes.at(-2) !== 255 ||
      bytes.at(-1) !== 217
    ) return false
    let offset = 2, frame = false
    while (offset + 4 <= bytes.length) {
      if (bytes[offset] !== 255) return false
      const marker = bytes[offset + 1], length = view.getUint16(offset + 2)
      if (length < 2 || offset + 2 + length > bytes.length) return false
      if ([192, 193, 194].includes(marker)) {
        if (length < 8 || !dimensions(view.getUint16(offset + 7), view.getUint16(offset + 5))) return false
        frame = true
      }
      if (marker === 218) return frame
      offset += 2 + length
    }
    return false
  }
  if (mime === 'image/png') {
    if (
      bytes.length < 45 || ![137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => bytes[i] === v) ||
      view.getUint32(8) !== 13 ||
      new TextDecoder().decode(bytes.slice(12, 16)) !== 'IHDR' ||
      !dimensions(view.getUint32(16), view.getUint32(20))
    ) return false
    let offset = 8, data = false
    while (offset + 12 <= bytes.length) {
      const length = view.getUint32(offset),
        kind = new TextDecoder().decode(bytes.slice(offset + 4, offset + 8))
      if (offset + 12 + length > bytes.length) return false
      if (kind === 'IDAT') data = true
      if (kind === 'IEND') return data && length === 0 && offset + 12 === bytes.length
      offset += length + 12
    }
    return false
  }
  return bytes.length >= 30 && new TextDecoder().decode(bytes.slice(0, 4)) === 'RIFF' &&
    new TextDecoder().decode(bytes.slice(8, 12)) === 'WEBP' &&
    ['VP8 ', 'VP8L', 'VP8X'].includes(new TextDecoder().decode(bytes.slice(12, 16))) &&
    view.getUint32(4, true) + 8 === bytes.length
}
export async function verifyObject(
  client: SupabaseClient,
  path: string,
  mime: ImageMime,
  size: number,
  signal: AbortSignal,
) {
  const bucket = await privateBucket(client)
  const info = await bucket.info(path)
  if (
    info.error || !info.data || info.data.name !== path || info.data.bucketId !== mediaBucket ||
    info.data.size !== size || info.data.contentType !== mime || size < 1 || size > maxImageBytes
  ) throw new ApiError('UPLOAD_ERROR')
  const object = await bucket.download(path, {}, { signal })
  if (
    object.error || !object.data || object.data.size !== size || object.data.type !== mime ||
    !matchesImage(new Uint8Array(await object.data.arrayBuffer()), mime)
  ) throw new ApiError('UPLOAD_ERROR')
}
