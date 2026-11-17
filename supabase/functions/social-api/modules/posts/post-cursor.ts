import { ApiError } from '../../shared/response.ts'
import { type ListPostsInput, timestampPattern, uuidPattern } from './post-validation.ts'
import { signCursor, verifyCursor } from '../../shared/cursor.ts'
export { assertCursorSecret } from '../../shared/cursor.ts'

interface Cursor {
  v: 1
  sort: ListPostsInput['sort']
  tag: ListPostsInput['tag']
  asOf: number
  publishedAt: string
  id: string
  upvoteCount: number
}
export async function encodeCursor(value: Omit<Cursor, 'v'>, secret: string) {
  return await signCursor({ v: 1, ...value }, secret)
}
export async function decodeCursor(
  value: string,
  input: ListPostsInput,
  secret: string,
  now: number,
): Promise<Cursor> {
  const decoded = await verifyCursor(value, secret)
  try {
    const cursor = decoded as Cursor
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
