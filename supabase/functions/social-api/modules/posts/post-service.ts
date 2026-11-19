import type { SupabaseClient } from '@supabase/supabase-js'
import { signedImages } from '../media/media-service.ts'
import type { Profile } from '../profile/get-me.ts'
import { ApiError } from '../../shared/response.ts'
import { assertCursorSecret, decodeCursor, encodeCursor } from './post-cursor.ts'
import { mapPost, postColumns, type PostPublic, type PostRow } from './post-mapper.ts'
import { type CreatePostInput, type ListPostsInput, uuidPattern } from './post-validation.ts'

interface Context {
  client: SupabaseClient
  userId: string
  profile: Profile
  signal: AbortSignal
  now?: number
}
async function publicPosts(ctx: Context, rows: PostRow[]): Promise<PostPublic[]> {
  // Recheck trước ký và trước trả: hide trong lúc Storage chờ không được lộ URL mới.
  const visible = async (ids: string[]) => {
    const result = await ctx.client.from('posts').select('id').in('id', ids).eq('status', 'PUBLISHED')
      .abortSignal(ctx.signal)
    if (result.error || !Array.isArray(result.data)) throw new ApiError('INTERNAL_ERROR')
    return new Set(result.data.map((row) => row.id))
  }
  if (!rows.length) return []
  const before = await visible(rows.map((row) => row.id))
  rows = rows.filter((row) => before.has(row.id))
  const posts = rows.map((row) => mapPost(row, ctx.userId, false))
  if (!posts.length) return []
  const { data, error } = await ctx.client.from('post_votes').select('post_id')
    .eq('user_id', ctx.userId).in('post_id', posts.map((post) => post.id)).abortSignal(ctx.signal)
  if (error || !Array.isArray(data)) throw new ApiError('INTERNAL_ERROR')
  const votes = new Set(data.map((row) => row.post_id))
  const result = await Promise.all(
    posts.map(async (post, i) => ({
      ...post,
      hasUpvoted: votes.has(post.id),
      images: await signedImages(ctx.client, rows[i], ctx.now ?? Date.now()),
    })),
  )
  const after = await visible(result.map((post) => post.id))
  return result.filter((post) => after.has(post.id))
}

export async function deletePost(ctx: Context, postId: string) {
  const result = await ctx.client.from('posts').update({ status: 'DELETED' }).eq('id', postId)
    .eq('author_id', ctx.userId).eq('status', 'PUBLISHED').select('id').abortSignal(ctx.signal).maybeSingle()
  if (result.error) throw new ApiError(result.error.code === '42501' ? 'FORBIDDEN' : 'INTERNAL_ERROR')
  if (!result.data) {
    const replay = await ctx.client.from('posts').select('id,author_id,status').eq('id', postId).eq(
      'author_id',
      ctx.userId,
    ).abortSignal(ctx.signal).maybeSingle()
    if (replay.error) throw new ApiError('INTERNAL_ERROR')
    if (!replay.data) throw new ApiError('NOT_FOUND')
    if (replay.data.status !== 'DELETED') throw new ApiError('CONFLICT')
  }
  return { success: true as const }
}

export async function createPost(ctx: Context, input: CreatePostInput) {
  // Unique + DO NOTHING xử lý race, không merge nội dung/status của request đã thắng.
  const { error } = await ctx.client.from('posts').upsert({
    author_id: ctx.userId,
    body: input.body,
    tag: input.tag,
    display_mode: input.displayMode,
    nickname_snapshot: input.displayMode === 'NICKNAME' ? ctx.profile.nickname : null,
    contact_url: input.contactUrl,
    idempotency_key: input.idempotencyKey,
  }, { onConflict: 'author_id,idempotency_key', ignoreDuplicates: true }).abortSignal(ctx.signal)
  if (error) {
    throw new ApiError(
      error.code === '23514' || error.code === '22001' ? 'VALIDATION_ERROR' : 'INTERNAL_ERROR',
    )
  }
  const result = await ctx.client.from('posts').select('id,body,tag,display_mode,contact_url')
    .eq('author_id', ctx.userId).eq('idempotency_key', input.idempotencyKey).abortSignal(ctx.signal)
    .maybeSingle()
  if (result.error || !result.data) throw new ApiError('INTERNAL_ERROR')
  const row = result.data
  if (typeof row.id !== 'string' || !uuidPattern.test(row.id)) throw new ApiError('INTERNAL_ERROR')
  if (
    row.body !== input.body || row.tag !== input.tag || row.display_mode !== input.displayMode ||
    row.contact_url !== input.contactUrl
  ) throw new ApiError('CONFLICT')
  // ACK của create được giữ nguyên cả khi retry sau publish; không đổi bài về DRAFT.
  return { postId: row.id as string, status: 'DRAFT' as const }
}

export async function publishPost(ctx: Context, postId: string) {
  const result = await ctx.client.from('posts').update({ status: 'PUBLISHED' })
    .eq('id', postId).eq('author_id', ctx.userId).eq('status', 'DRAFT')
    .select(postColumns).abortSignal(ctx.signal).maybeSingle()
  if (result.error) {
    throw new ApiError(
      result.error.code === '42501'
        ? 'FORBIDDEN'
        : result.error.code === '23514'
        ? 'CONFLICT'
        : 'INTERNAL_ERROR',
    )
  }
  let row = result.data as PostRow | null
  if (!row) {
    const existing = await ctx.client.from('posts').select(postColumns)
      .eq('id', postId).eq('author_id', ctx.userId).abortSignal(ctx.signal).maybeSingle()
    if (existing.error) throw new ApiError('INTERNAL_ERROR')
    if (!existing.data) throw new ApiError('NOT_FOUND')
    row = existing.data as PostRow
    if (row.status !== 'PUBLISHED') throw new ApiError('CONFLICT')
  }
  const post = (await publicPosts(ctx, [row]))[0]
  if (!post) throw new ApiError('NOT_FOUND')
  return post
}

export async function getPost(ctx: Context, postId: string) {
  const { data, error } = await ctx.client.from('posts').select(postColumns)
    .eq('id', postId).eq('status', 'PUBLISHED').abortSignal(ctx.signal).maybeSingle()
  if (error) throw new ApiError('INTERNAL_ERROR')
  if (!data) throw new ApiError('NOT_FOUND')
  const post = (await publicPosts(ctx, [data as PostRow]))[0]
  if (!post) throw new ApiError('NOT_FOUND')
  return post
}

export async function listPosts(ctx: Context, input: ListPostsInput, secret: string, now: number) {
  assertCursorSecret(secret)
  const cursor = input.cursor ? await decodeCursor(input.cursor, input, secret, now) : null
  const asOf = cursor?.asOf ?? now
  let query = ctx.client.from('posts').select(postColumns).eq('status', 'PUBLISHED')
    .lte('published_at', new Date(asOf).toISOString())
  if (input.tag) query = query.eq('tag', input.tag)
  if (input.sort === 'HOT') {
    // shortcut: vote thay đổi có thể gây lặp/bỏ sót; T07 cần dedupe/refresh, snapshot nếu cần sau này.
    query = query.gte('published_at', new Date(now - 86_400_000).toISOString()).order('upvote_count', {
      ascending: false,
    })
  }
  if (cursor) {
    const t = cursor.publishedAt
    const id = cursor.id
    query = input.sort === 'NEW'
      ? query.or(`published_at.lt.${t},and(published_at.eq.${t},id.lt.${id})`)
      : query.or(
        `upvote_count.lt.${cursor.upvoteCount},and(upvote_count.eq.${cursor.upvoteCount},published_at.lt.${t}),and(upvote_count.eq.${cursor.upvoteCount},published_at.eq.${t},id.lt.${id})`,
      )
  }
  const { data, error } = await query.order('published_at', { ascending: false }).order('id', {
    ascending: false,
  })
    .limit(input.limit + 1).abortSignal(ctx.signal)
  if (error || !Array.isArray(data)) throw new ApiError('INTERNAL_ERROR')
  const rows = data.slice(0, input.limit) as PostRow[]
  const items = await publicPosts(ctx, rows)
  const last = rows.at(-1)
  const nextCursor = data.length > input.limit && last
    ? await encodeCursor({
      sort: input.sort,
      tag: input.tag,
      asOf,
      publishedAt: last.published_at,
      id: last.id,
      upvoteCount: last.upvote_count,
    }, secret)
    : null
  return { items, nextCursor }
}
