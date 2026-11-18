const mimes = ['image/jpeg', 'image/png', 'image/webp']
export const maxImageBytes = 2097152
export function imageDimensions(bytes: Uint8Array, mime: string): [number, number] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const text = (start: number, end: number) => new TextDecoder().decode(bytes.slice(start, end))
  if (
    mime === 'image/png' && bytes.length >= 24 &&
    [137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => bytes[i] === v) && text(12, 16) === 'IHDR'
  ) return [view.getUint32(16), view.getUint32(20)]
  if (mime === 'image/jpeg' && bytes[0] === 255 && bytes[1] === 216) {
    let offset = 2
    while (offset + 4 <= bytes.length) {
      if (bytes[offset] !== 255) break
      const marker = bytes[offset + 1]
      const length = view.getUint16(offset + 2)
      if (length < 2 || offset + 2 + length > bytes.length) break
      if ([192, 193, 194].includes(marker) && length >= 7) {
        return [view.getUint16(offset + 7), view.getUint16(offset + 5)]
      }
      offset += 2 + length
    }
  }
  if (
    mime === 'image/webp' && bytes.length >= 30 && text(0, 4) === 'RIFF' && text(8, 12) === 'WEBP' &&
    view.getUint32(4, true) + 8 === bytes.length
  ) {
    if (text(12, 16) === 'VP8X' && !(bytes[20] & 2)) {
      return [
        1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16),
        1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16),
      ]
    }
    if (text(12, 16) === 'VP8 ' && bytes[23] === 157 && bytes[24] === 1 && bytes[25] === 42) {
      return [view.getUint16(26, true) & 16383, view.getUint16(28, true) & 16383]
    }
    if (text(12, 16) === 'VP8L' && bytes[20] === 47) {
      const n = view.getUint32(21, true)
      return [(n & 16383) + 1, ((n >>> 14) & 16383) + 1]
    }
  }
  throw new Error('Ảnh không đúng định dạng JPG, PNG hoặc WebP tĩnh.')
}
export function validateImageFile(file: Blob) {
  if (!mimes.includes(file.type) || file.size < 1 || file.size > 16 * 1024 * 1024) {
    throw new Error('Chọn ảnh JPG, PNG hoặc WebP từ 1 byte đến 16 MiB.')
  }
}
export async function processImage(file: Blob): Promise<Blob> {
  validateImageFile(file)
  const [width, height] = imageDimensions(new Uint8Array(await file.arrayBuffer()), file.type)
  if (width < 1 || height < 1 || width > 16384 || height > 16384 || width * height > 40000000) {
    throw new Error('Ảnh quá lớn để xử lý an toàn (tối đa 40 triệu điểm ảnh).')
  }
  let bitmap: ImageBitmap | undefined
  try {
    bitmap = await createImageBitmap(file)
    let ratio = Math.min(1, 2048 / Math.max(bitmap.width, bitmap.height))
    // Vẽ lại pixels loại metadata gốc; không fallback upload file ban đầu.
    for (let attempt = 0; attempt < 4; attempt++) {
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(bitmap.width * ratio))
      canvas.height = Math.max(1, Math.round(bitmap.height * ratio))
      const context = canvas.getContext('2d')
      if (!context) break
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, file.type, 0.85))
      if (blob && mimes.includes(blob.type) && blob.size > 0 && blob.size <= maxImageBytes) return blob
      ratio *= 0.7
    }
  } catch {
    throw new Error('Không thể xử lý ảnh. Vui lòng chọn ảnh khác.')
  } finally {
    bitmap?.close()
  }
  throw new Error('Không thể tạo ảnh nhỏ hơn 2 MiB. Vui lòng chọn ảnh khác.')
}
