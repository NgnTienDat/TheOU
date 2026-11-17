import { ApiError } from './response.ts'

function encode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
function decode(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[\w-]+$/.test(value)) throw new Error('Invalid base64url')
  const bytes = Uint8Array.from(
    atob(value.replace(/-/g, '+').replace(/_/g, '/')),
    (char) => char.charCodeAt(0),
  )
  if (encode(bytes) !== value) throw new Error('Noncanonical base64url')
  return bytes
}
export function assertCursorSecret(secret: string) {
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(secret)) throw new ApiError('INTERNAL_ERROR')
}
async function signingKey(secret: string) {
  assertCursorSecret(secret)
  return await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  )
}
export async function signCursor(value: object, secret: string) {
  const data = new TextEncoder().encode(JSON.stringify(value))
  const signature = await crypto.subtle.sign('HMAC', await signingKey(secret), data)
  return `${encode(data)}.${encode(new Uint8Array(signature))}`
}
export async function verifyCursor(value: string, secret: string): Promise<unknown> {
  const key = await signingKey(secret)
  try {
    if (value.length > 1024) throw new Error('Length')
    const parts = value.split('.')
    if (parts.length !== 2) throw new Error('Shape')
    const data = decode(parts[0])
    const signature = decode(parts[1])
    if (signature.length !== 32 || !await crypto.subtle.verify('HMAC', key, signature, data)) {
      throw new Error('Signature')
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data))
  } catch {
    throw new ApiError('VALIDATION_ERROR')
  }
}
