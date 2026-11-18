import { createHash } from 'node:crypto'
import { deflateSync } from 'node:zlib'

export const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')
function chunk(kind: string, data: Buffer) {
  const content = Buffer.concat([Buffer.from(kind), data])
  let crc = 0xffffffff
  for (const byte of content) {
    crc ^= byte
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  const length = Buffer.alloc(4), checksum = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0)
  return Buffer.concat([length, content, checksum])
}
// Hai màu tổng hợp; PNG tự tạo CRC/zlib, WebP là bitmap 2×2, không EXIF/ICC/GPS.
export function mediaAssets() {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(2, 0)
  header.writeUInt32BE(2, 4)
  header[8] = 8
  header[9] = 2
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.from([0, 43, 140, 130, 43, 140, 130, 0, 43, 140, 130, 43, 140, 130]))),
    chunk('IEND', Buffer.alloc(0)),
  ])
  const webp = Buffer.from('UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoCAAIAAUAmJaQAA3AA/v02aAA=', 'base64')
  return [
    { position: 1, mime: 'image/png' as const, extension: 'png', bytes: png },
    { position: 2, mime: 'image/webp' as const, extension: 'webp', bytes: webp },
  ].map((asset) => ({ ...asset, size: asset.bytes.length, hash: sha256(asset.bytes) }))
}
