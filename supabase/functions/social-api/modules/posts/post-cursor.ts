import { ApiError } from '../../shared/response.ts'
import { type ListPostsInput, timestampPattern, uuidPattern } from './post-validation.ts'

interface Cursor {
  v: 1
  sort: ListPostsInput['sort']
  tag: ListPostsInput['tag']
  asOf: number
  publishedAt: string
  id: string
  upvoteCount: number
}
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
export async function encodeCursor(value: Omit<Cursor, 'v'>, secret: string) {
  const data = new TextEncoder().encode(JSON.stringify({ v: 1, ...value }))
  const signature = await crypto.subtle.sign('HMAC', await signingKey(secret), data)
  return `${encode(data)}.${encode(new Uint8Array(signature))}`
}
export async function decodeCursor(
  value: string,
  input: ListPostsInput,
  secret: string,
  now: number,
): Promise<Cursor> {
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
    const cursor = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data)) as Cursor
    if (
      !cursor || Object.keys(cursor).sort().join(',') !== 'asOf,id,publishedAt,sort,tag,upvoteCount,v' ||
      cursor.v !== 1 || cursor.sort !== input.sort || cursor.tag !== input.tag ||
      !Number.isSafeInteger(cursor.asOf) || cursor.asOf > now + 60_000 || now - cursor.asOf > 900_000 ||
      typeof cursor.id !== 'string' || !uuidPattern.test(cursor.id) ||
      typeof cursor.publishedAt !== 'string' || !timestampPattern.test(cursor.publishedAt) ||
      !Number.isFinite(Date.parse(cursor.publishedAt)) || Date.parse(cursor.publishedAt) > cursor.asOf ||
      !Number.isSafeInteger(cursor.upvoteCount) || cursor.upvoteCount < 0
    ) throw new Error('Value')
    return cursor
  } catch {
    throw new ApiError('VALIDATION_ERROR')
  }
}
