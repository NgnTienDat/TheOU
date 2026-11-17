import type { SupabaseClient } from '@supabase/supabase-js'
import { ApiError } from '../../shared/response.ts'
import type { UpvoteInput } from './vote-validation.ts'

interface Context {
  client: SupabaseClient
  userId: string
  signal: AbortSignal
}
async function readState(ctx: Context, postId: string) {
  // Embed lọc caller: count và vote lấy cùng snapshot SELECT, không serialize row/identity.
  const { data, error } = await ctx.client.from('posts').select('upvote_count,post_votes(user_id)')
    .eq('id', postId).eq('status', 'PUBLISHED').eq('post_votes.user_id', ctx.userId)
    .abortSignal(ctx.signal).maybeSingle()
  if (error) throw new ApiError('INTERNAL_ERROR')
  if (!data) throw new ApiError('NOT_FOUND')
  if (
    !Number.isSafeInteger(data.upvote_count) || data.upvote_count < 0 ||
    !Array.isArray(data.post_votes) || data.post_votes.length > 1 ||
    data.post_votes.some((row: { user_id: string }) => row.user_id !== ctx.userId)
  ) throw new ApiError('INTERNAL_ERROR')
  return { hasUpvoted: data.post_votes.length === 1, upvoteCount: data.upvote_count as number }
}
export async function toggleUpvote(ctx: Context, input: UpvoteInput) {
  await readState(ctx, input.postId)
  const result = input.desiredState
    ? await ctx.client.from('post_votes').upsert({ post_id: input.postId, user_id: ctx.userId }, {
      onConflict: 'post_id,user_id',
      ignoreDuplicates: true,
    }).abortSignal(ctx.signal)
    : await ctx.client.from('post_votes').delete().eq('post_id', input.postId).eq('user_id', ctx.userId)
      .abortSignal(ctx.signal)
  if (result.error) {
    throw new ApiError(
      ['P0002', '23503'].includes(result.error.code) ? 'NOT_FOUND' : 'INTERNAL_ERROR',
    )
  }
  return await readState(ctx, input.postId)
}
