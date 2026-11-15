import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { readCloudTestConfig } from './cloud-config.ts'

type Result = { error: { code?: string; status?: number } | null; data?: unknown }
function ok(result: Result, operation: string) {
  // Không serialize SDK error/data vì có thể chứa credentials hoặc danh tính fixture.
  assert.equal(result.error?.code ?? result.error?.status ?? (result.error ? 'ERROR' : null), null, operation)
}
function denied(result: Result, operation: string) {
  assert.equal(result.error?.code, '42501', operation)
  assert.equal(result.data, null, `${operation}: không trả dữ liệu`)
}

test('T02 Cloud — phiên Auth thật, grants và constraints', async (t) => {
  const linkedRef = await readFile(new URL('../.temp/project-ref', import.meta.url), 'utf8')
  const config = readCloudTestConfig(process.env, linkedRef)
  const options = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } }
  const admin = createClient(config.url, config.secretKey, options)
  const guest = createClient(config.url, config.publishableKey, options)
  const users: string[] = []
  const sessions: SupabaseClient[] = []
  // Giữ local-part của Gmail alias <=64 ký tự kể cả username dài 30 ký tự.
  const run = randomUUID().replaceAll('-', '').slice(0, 20)
  const postId = randomUUID()
  const attemptedPostIds = new Set<string>([postId])
  const commentId = randomUUID()
  const imageId = randomUUID()
  const reportId = randomUUID()

  // Dọn duy nhất dữ liệu gắn với các user vừa tạo; không dùng truncate/reset hoặc tài khoản có sẵn.
  t.after(async () => {
    const failed: string[] = []
    for (const client of sessions) {
      const result = await client.auth.signOut()
      if (result.error) failed.push('signOut')
    }
    if (users.length) {
      for (const [table, owner] of [
        ['reports', 'reporter_id'], ['post_votes', 'user_id'], ['comments', 'author_id'],
      ]) {
        if ((await admin.from(table).delete().in(owner, users)).error) failed.push(table)
      }
      const posts = await admin.from('posts').select('id').in('author_id', users)
      if (posts.error) failed.push('posts/list')
      else for (const post of posts.data) attemptedPostIds.add(post.id)
      if ((await admin.from('post_images').delete().in('post_id', [...attemptedPostIds])).error) failed.push('post_images')
      if ((await admin.from('posts').delete().in('id', [...attemptedPostIds])).error) failed.push('posts/attempted')
      for (const [table, owner] of [
        ['posts', 'author_id'], ['rate_limit_counters', 'actor_id'], ['user_roles', 'user_id'], ['profiles', 'id'],
      ]) {
        if ((await admin.from(table).delete().in(owner, users)).error) failed.push(table)
      }
      for (const id of users) {
        if ((await admin.auth.admin.deleteUser(id)).error) failed.push('auth/deleteUser')
      }
    }
    assert.deepEqual(failed, [], `Dọn fixture thất bại; mã lần chạy: ${run}`)
  })

  for (const label of ['a', 'b']) {
    const email = config.emailBase.replace('@gmail.com', `+theou-t02-${run}-${label}@gmail.com`)
    // Supabase Auth giới hạn password bcrypt tối đa 72 byte.
    const password = `${randomUUID()}-Aa1!`
    assert.ok(Buffer.byteLength(password, 'utf8') <= 72, 'Password fixture vượt giới hạn Supabase Auth')
    const created = await admin.auth.admin.createUser({ email, password, email_confirm: true })
    ok(created, 'Tạo Auth fixture')
    assert.ok(created.data.user)
    users.push(created.data.user.id)
    const client = createClient(config.url, config.publishableKey, options)
    sessions.push(client)
    ok(await client.auth.signInWithPassword({ email, password }), 'Đăng nhập Auth fixture')
    const verified = await client.auth.getUser()
    ok(verified, 'Xác minh phiên Auth')
    assert.equal(verified.data.user?.id, created.data.user.id)
  }
  const [a, b] = users
  const postKey = randomUUID()
  const fixtures: Record<string, Record<string, unknown>> = {
    profiles: { id: a, nickname: 'Test-A' },
    user_roles: { user_id: a, role: 'ADMIN', granted_by: null },
    posts: { id: postId, author_id: a, tag: 'CONFESSION', body: 'Bài ẩn danh giả để kiểm thử', idempotency_key: postKey },
    comments: { id: commentId, post_id: postId, author_id: a, body: 'Bình luận giả', idempotency_key: randomUUID() },
    post_votes: { post_id: postId, user_id: a },
    post_images: { id: imageId, post_id: postId, storage_path: `posts/${postId}/${imageId}.webp`, mime_type: 'image/webp', size_bytes: 1024, position: 1 },
    reports: { id: reportId, reporter_id: b, target_type: 'POST', target_id: postId, reason: 'SPAM' },
    // FK không tồn tại tránh để lại audit nếu một deployment sai vô tình mở INSERT.
    moderation_actions: { id: randomUUID(), admin_id: randomUUID(), target_type: 'POST', target_id: postId, action: 'HIDE', reason: 'Test-only' },
    rate_limit_counters: { actor_id: a, action: 'createPost', window_start: new Date().toISOString(), count: 0 },
  }
  ok(await admin.from('profiles').insert([fixtures.profiles, { id: b, nickname: 'Test-B' }]), 'Tạo profile fixture')
  for (const table of ['user_roles', 'posts', 'comments', 'post_votes', 'post_images', 'reports', 'rate_limit_counters']) {
    ok(await admin.from(table).insert(fixtures[table]), `Server INSERT ${table}`)
  }

  await t.test('server đọc đúng fixture trên 8 bảng CRUD; audit kiểm tra bằng catalog/offline', async () => {
    for (const [table, fixture] of Object.entries(fixtures)) {
      if (table === 'moderation_actions') continue
      const filterColumn = table === 'user_roles' ? 'user_id' : table === 'post_votes' ? 'post_id' : table === 'rate_limit_counters' ? 'actor_id' : 'id'
      // PostgREST có thể chuẩn hóa cách biểu diễn timestamp; so sánh các giá trị còn lại.
      const expected = Object.fromEntries(Object.entries(fixture).filter(([key]) => key !== 'window_start'))
      const result = await admin.from(table).select(Object.keys(expected).join(',')).eq(filterColumn, fixture[filterColumn])
      ok(result, `Server SELECT ${table}`)
      assert.deepEqual(result.data, [expected], `Server phải đọc đúng fixture ${table}`)
    }
  })

  for (const [label, client] of [['guest', guest], ['A', sessions[0]], ['B', sessions[1]]] as const) {
    await t.test(`${label}: từ chối SELECT/INSERT/UPDATE/DELETE trực tiếp trên 9 bảng`, async () => {
      for (const [table, fixture] of Object.entries(fixtures)) {
        const filterColumn = table === 'user_roles' ? 'user_id' : table === 'post_votes' ? 'post_id' : table === 'rate_limit_counters' ? 'actor_id' : 'id'
        const filterValue = fixture[filterColumn]
        denied(await client.from(table).select('*').eq(filterColumn, filterValue), `${table}/SELECT`)
        denied(await client.from(table).insert(fixture), `${table}/INSERT`)
        denied(await client.from(table).update(fixture).eq(filterColumn, filterValue), `${table}/UPDATE`)
        denied(await client.from(table).delete().eq(filterColumn, filterValue), `${table}/DELETE`)
      }
      denied(await client.from('posts').select('id,author_id').eq('id', postId), 'Không đọc được identity')
      denied(await client.from('posts').update({ author_id: b }).eq('id', postId), 'Không đổi chủ bài A')
      denied(await client.from('user_roles').insert({ user_id: b, role: 'ADMIN' }), 'Không tự nâng admin')
    })
  }

  await t.test('server ghi hợp lệ; thay đổi ownership vẫn bị trigger chặn', async () => {
    const published = await admin.from('posts').update({ status: 'PUBLISHED', published_at: new Date().toISOString() }).eq('id', postId).select('id')
    ok(published, 'Publish fixture bằng server')
    assert.equal(published.data?.length, 1)
    for (const [table, change, column, id] of [
      ['posts', { author_id: b }, 'id', postId],
      ['comments', { author_id: b }, 'id', commentId],
      ['post_votes', { user_id: b }, 'post_id', postId],
      ['reports', { reporter_id: a }, 'id', reportId],
    ] as const) {
      assert.equal((await admin.from(table).update(change).eq(column, id)).error?.code, '23514', `${table}/ownership`)
    }
    denied(await admin.from('moderation_actions').update({ reason: 'Không sửa audit' }).eq('id', fixtures.moderation_actions.id), 'Server không UPDATE audit')
    denied(await admin.from('moderation_actions').delete().eq('id', fixtures.moderation_actions.id), 'Server không DELETE audit')
  })

  await t.test('FK/unique/idempotency và validation được thực thi trên Cloud', async () => {
    const badCases: [string, Record<string, unknown>, string][] = [
      ['posts', { ...fixtures.posts, id: randomUUID() }, '23505'],
      ['posts', { ...fixtures.posts, id: randomUUID(), author_id: randomUUID() }, '23503'],
      ['posts', { ...fixtures.posts, id: randomUUID(), idempotency_key: randomUUID(), body: ' ' }, '23514'],
      ['posts', { ...fixtures.posts, id: randomUUID(), idempotency_key: randomUUID(), nickname_snapshot: 'Bị lộ' }, '23514'],
      ['posts', { ...fixtures.posts, id: randomUUID(), idempotency_key: randomUUID(), contact_url: 'https://zalo.me/test' }, '23514'],
      ['comments', { ...fixtures.comments, id: randomUUID() }, '23505'],
      ['post_votes', fixtures.post_votes, '23505'],
      ['reports', { ...fixtures.reports, id: randomUUID() }, '23505'],
      ['rate_limit_counters', { ...fixtures.rate_limit_counters, action: 'invalid', count: -1 }, '23514'],
    ]
    for (const [table, input, expected] of badCases) {
      if (table === 'posts') attemptedPostIds.add(input.id as string)
      assert.equal((await admin.from(table).insert(input)).error?.code, expected, `${table}/constraint`)
    }
    for (const change of [{ size_bytes: 2097153 }, { position: 3 }, { mime_type: 'image/gif' }]) {
      assert.equal((await admin.from('post_images').update(change).eq('id', imageId)).error?.code, '23514')
    }
    const invalidPathId = randomUUID()
    assert.equal((await admin.from('post_images').insert({ ...fixtures.post_images, id: invalidPathId, position: 2,
      storage_path: `posts/${a}/${invalidPathId}.webp` })).error?.code, '23514')
  })

  await t.test('server DELETE fixture được phép và không còn dữ liệu', async () => {
    const result = await admin.from('comments').delete().eq('id', commentId).select('id')
    ok(result, 'Server DELETE comment')
    assert.equal(result.data?.length, 1)
    const remaining = await admin.from('comments').select('id').eq('id', commentId)
    ok(remaining, 'Kiểm tra đã xóa')
    assert.equal(remaining.data?.length, 0)
  })
})
