import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { a, b, postFixture } from './helpers/post-fixture.ts'

test('T10-B.2-R1 image trigger — SQL trên PGlite, không Storage/Cloud', async (t) => {
  const f = await postFixture()
  t.after(() => f.db.close())
  t.beforeEach(() => f.reset())
  const draft = (author = a) => f.seed({ status: 'DRAFT', author })
  const hasCode = (code: string) => (error: unknown) =>
    !!error && typeof error === 'object' && 'code' in error && error.code === code
  async function insertImage(postId: string, position = 1) {
    const id = randomUUID()
    await f.db.query(
      `insert into public.post_images(id,post_id,storage_path,mime_type,size_bytes,position)
        values($1,$2,$3,'image/png',68,$4)`,
      [id, postId, `posts/${postId}/${id}.png`, position],
    )
    return id
  }
  async function status(id: string) {
    return (await f.db.query<{ status: string }>(
      'select status from public.post_images where id=$1',
      [id],
    )).rows[0]?.status
  }
  async function transition(id: string, value: string) {
    const result = await f.db.query<{ id: string; status: string }>(
      'update public.post_images set status=$2 where id=$1 returning id,status',
      [id, value],
    )
    assert.deepEqual(result.rows, [{ id, status: value }])
  }
  async function snapshot() {
    const records = await Promise.all(
      ['posts', 'post_images', 'profiles'].map((table) =>
        f.db.query<{ row: { id: string } }>(`select to_jsonb(r) as row from public.${table} r order by id`)
      ),
    )
    return records.map((result) => result.rows)
  }

  await t.test('INSERT PENDING và UPDATE PENDING→READY→REMOVING→REMOVED trên own DRAFT', async () => {
    const postId = await draft()
    const id = await insertImage(postId)
    assert.equal(await status(id), 'PENDING')
    for (const next of ['READY', 'REMOVING', 'REMOVED']) await transition(id, next)
    const parent = (await f.db.query<{ status: string; published_at: null }>(
      'select status,published_at from public.posts where id=$1',
      [postId],
    )).rows[0]
    assert.deepEqual(parent, { status: 'DRAFT', published_at: null })
  })

  await t.test('DELETE trả OLD đúng row trên DRAFT/ACTIVE ở cả bốn trạng thái ảnh', async () => {
    const postId = await draft()
    const protectedId = await insertImage(await draft(b))
    for (const state of ['PENDING', 'READY', 'REMOVING', 'REMOVED']) {
      const id = await insertImage(postId)
      if (state !== 'PENDING') await transition(id, 'READY')
      if (state === 'REMOVING' || state === 'REMOVED') await transition(id, 'REMOVING')
      if (state === 'REMOVED') await transition(id, 'REMOVED')
      const before = await snapshot()
      const deleted = await f.db.query(
        'delete from public.post_images where id=$1 returning id,post_id,status',
        [id],
      )
      assert.deepEqual(deleted.rows, [{ id, post_id: postId, status: state }])
      assert.equal(await status(id), undefined)
      const after = await snapshot()
      assert.deepEqual(after[0], before[0], 'DELETE image không sửa parent')
      assert.deepEqual(after[1], before[1].filter((entry) => (entry.row as { id: string }).id !== id))
      assert.deepEqual(after[2], before[2])
      assert.equal(await status(protectedId), 'PENDING', 'Không đụng ảnh của post khác')
    }
  })

  await t.test('DELETE trên PUBLISHED trả 23514 và rollback, giữ nguyên image/post/profile', async () => {
    const postId = await draft(), id = await insertImage(postId)
    await transition(id, 'READY')
    await f.db.query("update public.posts set status='PUBLISHED' where id=$1", [postId])
    const before = await snapshot()
    await assert.rejects(f.db.query('delete from public.post_images where id=$1', [id]), hasCode('23514'))
    assert.deepEqual(await snapshot(), before)
  })

  await t.test('DELETE trên DRAFT của owner BANNED trả 42501 và không xóa row', async () => {
    const id = await insertImage(await draft())
    await f.db.query("update public.profiles set status='BANNED' where id=$1", [a])
    const before = await snapshot()
    await assert.rejects(f.db.query('delete from public.post_images where id=$1', [id]), hasCode('42501'))
    assert.deepEqual(await snapshot(), before)
    await f.db.query("update public.profiles set status='ACTIVE' where id=$1", [a])
    assert.equal(
      (await f.db.query('delete from public.post_images where id=$1 returning id', [id])).rows.length,
      1,
    )
  })

  await t.test('Transaction rollback cả writes trước lỗi state hoặc chuyển image sang post owner khác', async () => {
    const postId = await draft(), otherPostId = await draft(b), id = await insertImage(postId)
    const before = await snapshot()
    for (const invalid of ['state', 'ownership']) {
      await assert.rejects(
        f.db.transaction(async (tx) => {
          await tx.query('update public.posts set body=$2 where id=$1', [postId, 'Thay đổi phải rollback'])
          await tx.query("update public.post_images set status='READY' where id=$1", [id])
          if (invalid === 'state') {
            await tx.query("update public.post_images set status='PENDING' where id=$1", [id])
          } else {
            // Identity trigger T02 vẫn cấm đổi parent/owner của image, kể cả dùng service_role.
            await tx.query('update public.post_images set post_id=$2,storage_path=$3 where id=$1', [
              id,
              otherPostId,
              `posts/${otherPostId}/${id}.png`,
            ])
          }
        }),
        hasCode('23514'),
      )
      assert.deepEqual(await snapshot(), before)
      assert.equal(await status(id), 'PENDING')
    }
  })

  await t.test('Publish text-only và 1/2 READY giữ trigger snapshot; PENDING vẫn bị chặn', async () => {
    for (const count of [0, 1, 2]) {
      const postId = await draft()
      for (let position = 1; position <= count; position++) {
        const id = await insertImage(postId, position)
        const before = await snapshot()
        await assert.rejects(
          f.db.query("update public.posts set status='PUBLISHED' where id=$1", [postId]),
          hasCode('23514'),
        )
        assert.deepEqual(await snapshot(), before)
        await transition(id, 'READY')
      }
      const published = await f.db.query<{ status: string; published: boolean; nickname_snapshot: null }>(
        "update public.posts set status='PUBLISHED' where id=$1 returning status,published_at is not null as published,nickname_snapshot",
        [postId],
      )
      assert.deepEqual(published.rows, [{ status: 'PUBLISHED', published: true, nickname_snapshot: null }])
    }
  })

  await t.test('Partial unique: PENDING/READY/REMOVING giữ slot, REMOVED cho UUID mới cùng position', async () => {
    const postId = await draft(), oldId = await insertImage(postId)
    await insertImage(postId, 2)
    for (const next of ['PENDING', 'READY', 'REMOVING']) {
      if (next !== 'PENDING') await transition(oldId, next)
      const before = await snapshot()
      await assert.rejects(insertImage(postId), hasCode('23505'))
      assert.deepEqual(await snapshot(), before)
    }
    await transition(oldId, 'REMOVED')
    const replacement = await insertImage(postId)
    assert.notEqual(replacement, oldId)
    assert.equal(await status(oldId), 'REMOVED')
    assert.equal(await status(replacement), 'PENDING')
    const before = await snapshot()
    await assert.rejects(transition(oldId, 'READY'), hasCode('23514'))
    await assert.rejects(insertImage(postId, 3), hasCode('23514'))
    assert.deepEqual(await snapshot(), before)
    assert.deepEqual(
      (await f.db.query<{ total: number; live: number }>(
        "select count(*)::integer total,count(*) filter(where status <> 'REMOVED')::integer live from public.post_images where post_id=$1",
        [postId],
      )).rows,
      [{ total: 3, live: 2 }],
    )
  })
})
