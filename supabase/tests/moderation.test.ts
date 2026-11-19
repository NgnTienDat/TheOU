import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { a, b, postFixture, serverKey, userEmail } from './helpers/post-fixture.ts'

test('T11 HTTP/SDK + transactional PostgreSQL-compatible engine, không Cloud', async (t) => {
  const f = await postFixture()
  const call = (...args: Parameters<typeof f.request>) => f.handler(f.request(...args))
  const reason = 'Nội dung vi phạm quy định cộng đồng.'
  const hide = (targetId: string, targetType = 'POST', caller = b) =>
    call('adminHideContent', { targetId, targetType, reason }, caller)
  async function denied(response: Response, status: number, code: string) {
    assert.equal(response.status, status)
    const text = await response.text()
    assert.equal(JSON.parse(text).error.code, code)
    for (const secret of [userEmail, serverKey, 'offline SQL detail', 'stack']) {
      assert.ok(!text.includes(secret))
    }
  }
  const audits = async () =>
    (await f.db.query<{ n: number }>('select count(*)::int n from moderation_actions')).rows[0].n
  const comment = async (postId: string) => {
    const r = await call('createComment', { postId, body: 'Bình luận giả lập', idempotencyKey: randomUUID() })
    assert.equal(r.status, 200)
    return (await r.json()).data.id as string
  }
  try {
    await t.test('JWT/domain/confirmed/BANNED guards, ADMIN từ DB không từ metadata', async () => {
      const p = await f.seed()
      await denied(await call('deletePost', { postId: p }, null), 401, 'UNAUTHENTICATED')
      await denied(
        await call('adminHideContent', { targetType: 'POST', targetId: p, reason }, 'invalid'),
        401,
        'UNAUTHENTICATED',
      )
      for (const flag of ['outsideOu', 'unconfirmed'] as const) {
        f.state[flag] = true
        await denied(await hide(p), 403, 'FORBIDDEN')
        f.state[flag] = false
      }
      await denied(await hide(p), 403, 'FORBIDDEN')
      await f.db.query("insert into user_roles(user_id,role) values($1,'ADMIN')", [b])
      await f.db.query("update profiles set status='BANNED' where id=$1", [b])
      await denied(await hide(p), 403, 'FORBIDDEN')
      await f.db.query("update profiles set status='ACTIVE' where id=$1", [b])
    })
    await t.test('payload exact, UUID/type/reason Unicode500, trim và controls', async () => {
      const p = await f.seed()
      for (const payload of [{ postId: p, authorId: a }, { postId: 'x' }]) {
        await denied(await call('deletePost', payload), 400, 'VALIDATION_ERROR')
      }
      const base = { targetType: 'POST', targetId: p, reason }
      await denied(
        await call('adminHideContent', { ...base, targetType: ['POST'] }, b),
        400,
        'VALIDATION_ERROR',
      )
      for (
        const input of [
          { ...base, role: 'ADMIN' },
          { ...base, adminId: a },
          { ...base, status: 'HIDDEN' },
          { ...base, targetType: 'USER' },
          { ...base, targetId: 'x' },
          ...['', '   ', 'x\n', 'x\u200B', '\uD800', '👋'.repeat(501)].map((reason) => ({ ...base, reason })),
        ]
      ) await denied(await call('adminHideContent', input, b), 400, 'VALIDATION_ERROR')
      assert.equal(
        (await call('adminHideContent', { ...base, reason: `  ${'👋'.repeat(500)}  ` }, b)).status,
        200,
      )
      assert.equal(
        (await f.db.query<{ reason: string }>('select reason from moderation_actions where target_id=$1', [
          p,
        ])).rows[0].reason,
        '👋'.repeat(500),
      )
    })
    await t.test('owner delete atomic filter/replay/concurrent, cross-owner cả ADMIN không bypass', async () => {
      const p = await f.seed(), c = await comment(p)
      await f.db.query('insert into post_votes(post_id,user_id) values($1,$2)', [p, b])
      const before =
        (await f.db.query("select to_jsonb(p)-'status'-'updated_at' value from posts p where id=$1", [p]))
          .rows[0]
      await denied(await call('deletePost', { postId: p }, b), 404, 'NOT_FOUND')
      const responses = await Promise.all(Array.from({ length: 3 }, () => call('deletePost', { postId: p })))
      assert.ok(responses.every((r) => r.status === 200))
      assert.deepEqual(
        (await f.db.query("select to_jsonb(p)-'status'-'updated_at' value from posts p where id=$1", [p]))
          .rows[0],
        before,
      )
      const deleted = (await f.db.query('select to_jsonb(p) value from posts p where id=$1', [p])).rows
      assert.equal((await call('deletePost', { postId: p })).status, 200)
      assert.deepEqual(
        (await f.db.query('select to_jsonb(p) value from posts p where id=$1', [p])).rows,
        deleted,
      )
      assert.equal((await f.db.query('select id from comments where id=$1', [c])).rows.length, 1)
      assert.equal((await f.db.query('select * from post_votes where post_id=$1', [p])).rows.length, 1)
      for (const action of ['getPost', 'listComments']) {
        await denied(
          await call(action, action === 'getPost' ? { postId: p } : { postId: p, cursor: null, limit: 20 }),
          404,
          'NOT_FOUND',
        )
      }
      await denied(
        await call('createComment', { postId: p, body: 'x', idempotencyKey: randomUUID() }),
        404,
        'NOT_FOUND',
      )
      await denied(await call('toggleUpvote', { postId: p, desiredState: true }), 404, 'NOT_FOUND')
    })
    await t.test('DRAFT/HIDDEN conflict, DELETED terminal và missing/wrong target', async () => {
      for (const status of ['DRAFT', 'HIDDEN'] as const) {
        const p = await f.seed({ status })
        await denied(await call('deletePost', { postId: p }), 409, 'CONFLICT')
        await denied(await hide(p), 409, 'CONFLICT')
      }
      await denied(await hide(randomUUID()), 404, 'NOT_FOUND')
      const p = await f.seed()
      await denied(await hide(p, 'COMMENT'), 404, 'NOT_FOUND')
      await call('deletePost', { postId: p })
      await denied(await hide(p), 409, 'CONFLICT')
      await assert.rejects(
        f.db.query("update posts set status='PUBLISHED' where id=$1", [p]),
        (e: { code: string }) => e.code === '23514',
      )
    })
    await t.test('POST hide one audit, replay/conflicting admins and NEW/HOT visibility', async () => {
      await f.db.query("insert into user_roles(user_id,role) values($1,'ADMIN')", [a])
      const p = await f.seed(), n = await audits()
      const responses = await Promise.all([hide(p), hide(p, 'POST', a), hide(p)])
      assert.deepEqual(responses.map((r) => r.status).sort(), [200, 409, 409])
      assert.equal(await audits(), n + 1)
      await denied(await call('getPost', { postId: p }, b), 404, 'NOT_FOUND')
      for (const sort of ['NEW', 'HOT']) {
        const page = await (await call('listPosts', { sort, tag: null, cursor: null, limit: 20 })).json()
        assert.ok(!page.data.items.some((item: { id: string }) => item.id === p))
        assert.ok(!JSON.stringify(page).includes('admin_id'))
      }
      assert.equal(
        (await f.db.query<{ action: string }>('select action from moderation_actions where target_id=$1', [
          p,
        ])).rows[0].action,
        'HIDE',
      )
    })
    await t.test('COMMENT hide audit+count exact, list/cursor filters, owner-delete T08 regression', async () => {
      const p = await f.seed(), c = await comment(p), other = await comment(p), n = await audits()
      assert.equal((await hide(c, 'COMMENT')).status, 200)
      assert.equal(
        (await f.db.query<{ status: string }>('select status from comments where id=$1', [c])).rows[0].status,
        'HIDDEN',
      )
      await denied(await hide(c, 'COMMENT'), 409, 'CONFLICT')
      f.state.now = Date.now() + 1000
      const page = await (await call('listComments', { postId: p, cursor: null, limit: 1 }, b)).json()
      assert.deepEqual(page.data.items.map((x: { id: string }) => x.id), [other])
      const detail = await (await call('getPost', { postId: p })).json()
      assert.equal(detail.data.commentCount, 1)
      assert.equal(await audits(), n + 1)
      await denied(await call('deleteComment', { commentId: c }), 404, 'NOT_FOUND')
      assert.equal((await call('deleteComment', { commentId: other })).status, 200)
      assert.equal((await call('deleteComment', { commentId: other })).status, 200)
      assert.equal(
        (await f.db.query<{ n: number }>('select comment_count n from posts where id=$1', [p])).rows[0].n,
        0,
      )
      await denied(await hide(other, 'COMMENT'), 409, 'CONFLICT')
    })
    await t.test('reader discards a comment hidden while its query was in flight', async () => {
      const p = await f.seed(), c = await comment(p)
      f.state.now = Date.now() + 1000
      f.state.afterCommentRead = async () => {
        assert.equal((await hide(c, 'COMMENT')).status, 200)
      }
      const page = await (await call('listComments', { postId: p, cursor: null, limit: 20 })).json()
      assert.equal(page.data.items.length, 0)
    })
    await t.test('audit INSERT failure rolls back POST/COMMENT/count and emits safe error', async () => {
      await f.db.exec(
        "reset role; create function public.test_audit_fail() returns trigger language plpgsql as $$ begin raise exception 'offline SQL detail'; end $$; create trigger test_audit_fail before insert on moderation_actions for each row execute function public.test_audit_fail(); set role service_role;",
      )
      const p = await f.seed(), c = await comment(p), n = await audits()
      for (const [id, type] of [[p, 'POST'], [c, 'COMMENT']]) {
        await denied(await hide(id, type), 500, 'INTERNAL_ERROR')
      }
      assert.equal(await audits(), n)
      assert.equal(
        (await f.db.query<{ status: string }>('select status from posts where id=$1', [p])).rows[0].status,
        'PUBLISHED',
      )
      assert.equal(
        (await f.db.query<{ status: string }>('select status from comments where id=$1', [c])).rows[0].status,
        'VISIBLE',
      )
      assert.equal(
        (await f.db.query<{ n: number }>('select comment_count n from posts where id=$1', [p])).rows[0].n,
        1,
      )
      await f.db.exec(
        'reset role; drop trigger test_audit_fail on moderation_actions; drop function public.test_audit_fail(); set role service_role;',
      )
    })
    await t.test('DB role/ACTIVE recheck after Edge guard; no audit on authorization failure', async () => {
      const p = await f.seed(), n = await audits()
      f.state.beforeModeration = async () => {
        await f.db.query("delete from user_roles where user_id=$1 and role='ADMIN'", [b])
      }
      await denied(await hide(p), 403, 'FORBIDDEN')
      f.state.beforeModeration = null
      assert.equal(await audits(), n)
      await f.db.query("insert into user_roles(user_id,role) values($1,'ADMIN')", [b])
      f.state.beforeModeration = async () => {
        await f.db.query("update profiles set status='BANNED' where id=$1", [b])
      }
      await denied(await hide(p), 403, 'FORBIDDEN')
      f.state.beforeModeration = null
      await f.db.query("update profiles set status='ACTIVE' where id=$1", [b])
    })
    await t.test('owner delete/admin hide interleavings and comment count have one winner', async () => {
      const p = await f.seed(), n = await audits()
      f.state.beforePatch = async () => {
        f.state.beforePatch = null
        assert.equal((await hide(p)).status, 200)
      }
      await denied(await call('deletePost', { postId: p }), 409, 'CONFLICT')
      assert.equal(await audits(), n + 1)
      const deleted = await f.seed(), beforeDeleteWins = await audits()
      f.state.beforeModeration = async () => {
        f.state.beforeModeration = null
        assert.equal((await call('deletePost', { postId: deleted })).status, 200)
      }
      await denied(await hide(deleted), 409, 'CONFLICT')
      assert.equal(await audits(), beforeDeleteWins)
      const parent = await f.seed(), c = await comment(parent)
      const result = await Promise.all([hide(c, 'COMMENT'), call('deleteComment', { commentId: c })])
      assert.equal(result.filter((r) => r.status === 200).length, 1)
      const finalStatus =
        (await f.db.query<{ status: string }>('select status from comments where id=$1', [c])).rows[0].status
      const auditCount = (await f.db.query<{ n: number }>(
        'select count(*)::int n from moderation_actions where target_id=$1',
        [c],
      )).rows[0].n
      assert.equal(auditCount, finalStatus === 'HIDDEN' ? 1 : 0)
      assert.equal(
        (await f.db.query<{ n: number }>('select comment_count n from posts where id=$1', [parent])).rows[0]
          .n,
        0,
      )
    })
    await t.test('owner banned after guard cannot commit delete', async () => {
      const p = await f.seed()
      f.state.beforePatch = async () => {
        await f.db.query("update profiles set status='BANNED' where id=$1", [a])
      }
      await denied(await call('deletePost', { postId: p }), 403, 'FORBIDDEN')
      f.state.beforePatch = null
      await f.db.query("update profiles set status='ACTIVE' where id=$1", [a])
      assert.equal(
        (await f.db.query<{ status: string }>('select status from posts where id=$1', [p])).rows[0].status,
        'PUBLISHED',
      )
    })
    await t.test('hide during Storage signing discards URL; new reads never sign hidden/deleted post', async () => {
      const p = await f.seed({ status: 'DRAFT' })
      const id = randomUUID(), path = `posts/${p}/${id}.png`
      await f.db.query(
        "insert into post_images(id,post_id,storage_path,mime_type,size_bytes,position) values($1,$2,$3,'image/png',74,1)",
        [id, p, path],
      )
      await f.db.query("update post_images set status='READY' where id=$1", [id])
      await f.db.query("update posts set status='PUBLISHED' where id=$1", [p])
      f.storage.before = async () => {
        if (f.storage.calls.at(-1)?.operation !== 'readSign') return
        f.storage.before = null
        assert.equal((await hide(p)).status, 200)
      }
      await denied(await call('getPost', { postId: p }), 404, 'NOT_FOUND')
      const signed = f.storage.calls.length
      await denied(await call('getPost', { postId: p }), 404, 'NOT_FOUND')
      assert.equal(f.storage.calls.length, signed)
      assert.equal((await f.db.query('select * from post_images where id=$1', [id])).rows.length, 1)
      const own = await f.seed({ status: 'DRAFT' }), ownImage = randomUUID()
      await f.db.query(
        "insert into post_images(id,post_id,storage_path,mime_type,size_bytes,position) values($1,$2,$3,'image/png',74,1)",
        [ownImage, own, `posts/${own}/${ownImage}.png`],
      )
      await f.db.query("update post_images set status='READY' where id=$1", [ownImage])
      await f.db.query("update posts set status='PUBLISHED' where id=$1", [own])
      const imageBefore =
        (await f.db.query('select to_jsonb(i) value from post_images i where id=$1', [ownImage])).rows
      assert.equal((await call('deletePost', { postId: own })).status, 200)
      await denied(await call('getPost', { postId: own }), 404, 'NOT_FOUND')
      assert.deepEqual(
        (await f.db.query('select to_jsonb(i) value from post_images i where id=$1', [ownImage])).rows,
        imageBefore,
      )
      assert.ok(!f.storage.calls.some((x) => x.operation === 'remove'))
    })
    await t.test('raw RPC/table deny anon/authenticated, service-only INVOKER and audit immutability', async () => {
      for (const role of ['anon', 'authenticated', 'supabase_auth_admin']) {
        await f.db.exec(`reset role; set role ${role}`)
        await assert.rejects(
          f.db.query('select public.t11_admin_hide_content($1,$2,$3,$4)', [b, 'POST', randomUUID(), reason]),
          (e: { code: string }) => e.code === '42501',
        )
        if (role !== 'supabase_auth_admin') {
          await assert.rejects(
            f.db.query('select * from moderation_actions'),
            (e: { code: string }) => e.code === '42501',
          )
        }
      }
      await f.db.exec('reset role')
      await assert.rejects(
        f.db.exec("update moderation_actions set reason='x'"),
        (e: { code: string }) => e.code === '42501',
      )
      await assert.rejects(
        f.db.exec('delete from moderation_actions'),
        (e: { code: string }) => e.code === '42501',
      )
      const fn = (await f.db.query<{ definer: boolean }>(
        "select prosecdef definer from pg_proc where proname='t11_admin_hide_content'",
      )).rows[0]
      assert.equal(fn.definer, false)
      const catalog = await readFile(new URL('./catalog-check.sql', import.meta.url), 'utf8')
      for (
        const tamper of [
          'grant execute on function public.t11_admin_hide_content(uuid,text,uuid,text) to authenticated',
          'alter function public.t11_admin_hide_content(uuid,text,uuid,text) security definer',
          'alter function public.t11_admin_hide_content(uuid,text,uuid,text) set search_path=public',
        ]
      ) {
        await f.db.exec('begin')
        try {
          await f.db.exec(tamper)
          await assert.rejects(f.db.exec(catalog))
        } finally {
          await f.db.exec('rollback')
        }
      }
    })
  } finally {
    await f.db.close()
  }
})
