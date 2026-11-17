import type { SupabaseClient } from '@supabase/supabase-js'
import { ApiError } from '../../shared/response.ts'
import { assertCursorSecret } from '../../shared/cursor.ts'
import { commentColumns, type CommentRow, mapComment } from './comment-mapper.ts'
import { decodeCommentCursor, encodeCommentCursor } from './comment-cursor.ts'
import type { CreateCommentInput, ListCommentsInput } from './comment-validation.ts'

interface Context {
  client: SupabaseClient
  userId: string
  signal: AbortSignal
}
async function requirePost(ctx: Context, postId: string) {
  const { data, error } = await ctx.client.from('posts').select('id,author_id').eq('id', postId).eq(
    'status',
    'PUBLISHED',
  ).abortSignal(ctx.signal).maybeSingle()
  if (error) throw new ApiError('INTERNAL_ERROR')
  if (!data) throw new ApiError('NOT_FOUND')
  return data as { id: string; author_id: string }
}
export async function listComments(ctx: Context, input: ListCommentsInput, secret: string, now: number) {
  await requirePost(ctx, input.postId)
  assertCursorSecret(secret)
  const cursor = input.cursor ? await decodeCommentCursor(input.cursor, input.postId, secret, now) : null
  const asOf = cursor?.asOf ?? now
  let query = ctx.client.from('comments').select(commentColumns).eq('post_id', input.postId).eq(
    'status',
    'VISIBLE',
  )
    .lte('created_at', new Date(asOf).toISOString())
  if (cursor) {
    query = query.or(
      `created_at.gt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.gt.${cursor.id})`,
    )
  }
  const { data, error } = await query.order('created_at', { ascending: true }).order('id', {
    ascending: true,
  }).limit(input.limit + 1).abortSignal(ctx.signal)
  if (error || !Array.isArray(data)) throw new ApiError('INTERNAL_ERROR')
  // Kiểm tra lại parent sau truy vấn để không trả nội dung khi post vừa bị ẩn.
  const parent = await requirePost(ctx, input.postId)
  const rows = data.slice(0, input.limit) as CommentRow[]
  const items = rows.map((row) => mapComment(row, parent.author_id, ctx.userId))
  const last = rows.at(-1)
  const nextCursor = data.length > input.limit && last
    ? await encodeCommentCursor(
      { postId: input.postId, asOf, createdAt: last.created_at, id: last.id },
      secret,
    )
    : null
  return { items, nextCursor }
}
export async function createComment(ctx: Context, input: CreateCommentInput) {
  const { error } = await ctx.client.from('comments').upsert({
    post_id: input.postId,
    author_id: ctx.userId,
    body: input.body,
    idempotency_key: input.idempotencyKey,
  }, { onConflict: 'author_id,idempotency_key', ignoreDuplicates: true }).abortSignal(ctx.signal)
  if (error) {
    throw new ApiError(
      error.code === 'P0002' || error.code === '23503'
        ? 'NOT_FOUND'
        : error.code === '23514' || error.code === '22001'
        ? 'VALIDATION_ERROR'
        : 'INTERNAL_ERROR',
    )
  }
  const result = await ctx.client.from('comments').select(commentColumns).eq('author_id', ctx.userId).eq(
    'idempotency_key',
    input.idempotencyKey,
  ).abortSignal(ctx.signal).maybeSingle()
  if (result.error || !result.data) throw new ApiError('INTERNAL_ERROR')
  const row = result.data as CommentRow
  if (row.post_id !== input.postId || row.body !== input.body || row.status !== 'VISIBLE') {
    throw new ApiError('CONFLICT')
  }
  const parent = await requirePost(ctx, input.postId)
  return mapComment(row, parent.author_id, ctx.userId)
}
export async function deleteComment(ctx: Context, commentId: string) {
  const result = await ctx.client.from('comments').select('id,post_id,status').eq('id', commentId).eq(
    'author_id',
    ctx.userId,
  ).abortSignal(ctx.signal).maybeSingle()
  if (result.error) throw new ApiError('INTERNAL_ERROR')
  if (!result.data || !['VISIBLE', 'DELETED'].includes(result.data.status)) throw new ApiError('NOT_FOUND')
  await requirePost(ctx, result.data.post_id)
  if (result.data.status === 'VISIBLE') {
    const updated = await ctx.client.from('comments').update({ status: 'DELETED' }).eq('id', commentId).eq(
      'author_id',
      ctx.userId,
    ).eq('status', 'VISIBLE').select('id').abortSignal(ctx.signal).maybeSingle()
    if (updated.error) throw new ApiError('INTERNAL_ERROR')
    if (!updated.data) {
      const replay = await ctx.client.from('comments').select('status').eq('id', commentId).eq(
        'author_id',
        ctx.userId,
      ).abortSignal(ctx.signal).maybeSingle()
      if (replay.error) throw new ApiError('INTERNAL_ERROR')
      if (replay.data?.status !== 'DELETED') throw new ApiError('NOT_FOUND')
    }
  }
  await requirePost(ctx, result.data.post_id)
  return { success: true as const }
}
