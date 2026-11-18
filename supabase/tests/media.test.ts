import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { a, b, postFixture, serverKey, userEmail } from './helpers/post-fixture.ts'
import { matchesImage } from '../functions/social-api/modules/media/storage.ts'

// Pixel PNG giả lập, không người thật/EXIF.
const png = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==',
    'base64',
  ),
)
const encodedImages = {
  'image/jpeg':
    '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAACAAIDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAn/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AJVAA//Z',
  'image/webp': 'UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoCAAIAAUAmJaQAA3AA/v02aAA=',
}
test('T10 HTTP handler + SDK + PGlite + Storage mock (không phải Cloud)', async (t) => {
  const f = await postFixture()
  t.after(() => f.db.close())
  t.beforeEach(() => f.reset())
  const call = (action: string, payload: unknown, caller: string | null = a) =>
    f.handler(f.request(action, payload, caller))
  async function ok(action: string, payload: unknown, caller = a) {
    const r = await call(action, payload, caller)
    assert.equal(r.status, 200, `${action} status ${r.status}`)
    return (await r.json()).data
  }
  async function fail(
    action: string,
    payload: unknown,
    status: number,
    code: string,
    caller: string | null = a,
  ) {
    const r = await call(action, payload, caller)
    assert.equal(r.status, status, action)
    const data = await r.json()
    assert.equal(data.error.code, code)
    assert.equal(data.data, null)
    for (const secret of [a, b, serverKey, userEmail, 'storage_path', 'SQL', 'offline-upload-token']) {
      assert.equal(JSON.stringify(data).includes(secret), false)
    }
  }
  const draft = () => f.seed({ status: 'DRAFT' })
  const input = (postId: string, patch: Record<string, unknown> = {}) => ({
    postId,
    mimeType: 'image/png',
    sizeBytes: png.length,
    position: 1,
    ...patch,
  })
  async function upload(postId: string, position = 1) {
    const r = await ok('createImageUpload', input(postId, { position }))
    f.storage.objects.set(r.path, new Blob([png], { type: 'image/png' }))
    return r as { imageId: string; path: string; token: string }
  }
  await t.test('strict validation + Auth/domain/confirmed/BANNED + ownership/DRAFT + no client path', async () => {
    const postId = await draft()
    for (
      const patch of [
        { sizeBytes: 0 },
        { sizeBytes: 2097153 },
        { sizeBytes: 1.5 },
        { position: 3 },
        { mimeType: 'image/svg+xml' },
        { mimeType: 'image/gif' },
        { mimeType: '__proto__' },
        { path: 'outside' },
        { authorId: b },
        { status: 'READY' },
      ]
    ) await fail('createImageUpload', input(postId, patch), 400, 'VALIDATION_ERROR')
    await fail('createImageUpload', input(postId), 401, 'UNAUTHENTICATED', null)
    await fail('createImageUpload', input(postId), 401, 'UNAUTHENTICATED', 'invalid')
    f.state.outsideOu = true
    await fail('createImageUpload', input(postId), 403, 'FORBIDDEN')
    f.state.outsideOu = false
    f.state.unconfirmed = true
    await fail('createImageUpload', input(postId), 403, 'FORBIDDEN')
    f.state.unconfirmed = false
    await fail('createImageUpload', input(postId), 404, 'NOT_FOUND', b)
    await fail('createImageUpload', input(await f.seed()), 409, 'CONFLICT')
    await f.db.query("update profiles set status='BANNED' where id=$1", [a])
    await fail('createImageUpload', input(postId), 403, 'FORBIDDEN')
    assert.equal(f.storage.calls.length, 0)
  })
  await t.test('synthetic JPEG/WebP actual containers finalize and publish; mismatched MIME rejected', async () => {
    for (const [mime, base64] of Object.entries(encodedImages)) {
      const postId = await draft(), bytes = Uint8Array.from(Buffer.from(base64, 'base64'))
      const r = await ok('createImageUpload', input(postId, { mimeType: mime, sizeBytes: bytes.length }))
      f.storage.objects.set(r.path, new Blob([bytes], { type: mime }))
      await ok('finalizeImage', { postId, imageId: r.imageId })
      assert.equal((await ok('publishPost', { postId })).images.length, 1)
    }
  })
  await t.test('reserve retry/concurrent same slot → one ID; 2 slots only; mismatched declaration conflict', async () => {
    const postId = await draft()
    const [first, second] = await Promise.all([
      ok('createImageUpload', input(postId)),
      ok('createImageUpload', input(postId)),
    ])
    assert.equal(first.imageId, second.imageId)
    assert.deepEqual(Object.keys(first).sort(), ['imageId', 'path', 'token'])
    assert.match(first.path, new RegExp(`^posts/${postId}/${first.imageId}\\.png$`))
    assert.ok(!first.path.includes(a))
    await ok('createImageUpload', input(postId, { position: 2 }))
    await fail('createImageUpload', input(postId, { sizeBytes: 1 }), 409, 'CONFLICT')
    assert.equal(
      (await f.db.query<{ n: number }>('select count(*)::integer n from post_images')).rows[0].n,
      2,
    )
  })
  await t.test('lost reservation ACK + failed token issuance recover same row/path, no stuck slot', async () => {
    const postId = await draft()
    f.storage.lost = 'reserve'
    await fail('createImageUpload', input(postId), 500, 'INTERNAL_ERROR')
    f.storage.fail = 'uploadSign'
    await fail('createImageUpload', input(postId), 422, 'UPLOAD_ERROR')
    f.storage.fail = ''
    const r = await ok('createImageUpload', input(postId))
    assert.equal((await f.db.query<{ id: string }>('select id from post_images')).rows[0].id, r.imageId)
  })
  await t.test('bucket MIME/size and object bucket/path proof fail closed; uppercase UUID canonicalized', async () => {
    const postId = await draft()
    for (
      const patch of [{ file_size_limit: 2097153 }, { allowed_mime_types: ['image/*'] }, {
        id: 'other-bucket',
      }]
    ) {
      f.storage.bucketPatch = patch
      await fail('createImageUpload', input(postId), 422, 'UPLOAD_ERROR')
    }
    f.storage.bucketPatch = {}
    const r = await ok('createImageUpload', input(postId.toUpperCase()))
    assert.ok(r.path.startsWith(`posts/${postId}/`))
    f.storage.objects.set(r.path, new Blob([png], { type: 'image/png' }))
    for (
      const patch of [{ bucket_id: 'other-bucket' }, { name: 'outside/path.png' }, {
        content_type: 'image/gif',
      }, { size: 0 }]
    ) {
      f.storage.infoPatch = patch
      await fail('finalizeImage', { postId, imageId: r.imageId }, 422, 'UPLOAD_ERROR')
    }
    f.storage.infoPatch = {}
    await ok('finalizeImage', { postId: postId.toUpperCase(), imageId: r.imageId.toUpperCase() })
  })
  await t.test('missing object, fake MIME/magic, actual size mismatch fail finalize safely', async () => {
    const postId = await draft()
    const r = await ok('createImageUpload', input(postId))
    await fail('finalizeImage', { postId, imageId: r.imageId }, 422, 'UPLOAD_ERROR')
    for (
      const blob of [
        new Blob([new Uint8Array(png.length)], { type: 'image/png' }),
        new Blob([png], { type: 'image/jpeg' }),
        new Blob([png, png], { type: 'image/png' }),
      ]
    ) {
      f.storage.objects.set(r.path, blob)
      await fail('finalizeImage', { postId, imageId: r.imageId }, 422, 'UPLOAD_ERROR')
    }
    assert.equal(
      (await f.db.query<{ status: string }>('select status from post_images')).rows[0].status,
      'PENDING',
    )
    await fail('publishPost', { postId }, 409, 'CONFLICT')
  })
  await t.test('finalize replay/concurrent/lost ACK, publish 2 READY, signed read 300s and public allowlist', async () => {
    const postId = await draft()
    const one = await upload(postId)
    const two = await upload(postId, 2)
    f.storage.lost = 'READY'
    await fail('finalizeImage', { postId, imageId: one.imageId }, 500, 'INTERNAL_ERROR')
    await Promise.all([
      ok('finalizeImage', { postId, imageId: one.imageId }),
      ok('finalizeImage', { postId, imageId: one.imageId }),
    ])
    await fail('publishPost', { postId }, 409, 'CONFLICT')
    await ok('finalizeImage', { postId, imageId: two.imageId })
    const published = await ok('publishPost', { postId })
    assert.deepEqual(published.images.map((v: { id: string }) => v.id), [one.imageId, two.imageId])
    for (const image of published.images) {
      assert.deepEqual(Object.keys(image).sort(), ['expiresAt', 'id', 'signedUrl'])
      assert.equal(Date.parse(image.expiresAt) - f.state.now, 300000)
    }
    const other = await ok('getPost', { postId }, b)
    assert.deepEqual(other.images, published.images)
    assert.equal(other.isMine, false)
    for (const secret of [a, b, serverKey, userEmail, 'storage_path', 'offline-upload-token']) {
      assert.equal(JSON.stringify(other).includes(secret), false)
    }
    f.state.now = Date.now() + 1000
    const page = await ok('listPosts', { sort: 'NEW', tag: null, cursor: null, limit: 20 }, b)
    assert.equal(page.items[0].images.length, 2)
    await fail('removeDraftImage', { postId, imageId: one.imageId }, 409, 'CONFLICT')
    await fail('finalizeImage', { postId, imageId: one.imageId }, 409, 'CONFLICT')
    f.storage.fail = 'readSign'
    await fail('getPost', { postId }, 422, 'UPLOAD_ERROR')
  })
  await t.test('private bucket config fail closed, text-only read/publish works with Storage unavailable', async () => {
    const postId = await draft()
    f.storage.fail = 'public'
    await fail('createImageUpload', input(postId), 422, 'UPLOAD_ERROR')
    const plain = await draft()
    f.storage.fail = 'bucket'
    assert.deepEqual((await ok('publishPost', { postId: plain })).images, [])
    f.state.now = Date.now() + 1000
    const page = await ok('listPosts', { sort: 'NEW', tag: null, cursor: null, limit: 20 })
    assert.equal(page.items.length, 1)
  })
  await t.test('remove failure/lost ACK blocks publish, retry tombstone, old finalize rejected and slot can be replaced', async () => {
    const postId = await draft()
    const r = await upload(postId)
    await ok('finalizeImage', { postId, imageId: r.imageId })
    await fail('removeDraftImage', { postId, imageId: r.imageId }, 404, 'NOT_FOUND', b)
    f.storage.fail = 'remove'
    await fail('removeDraftImage', { postId, imageId: r.imageId }, 422, 'UPLOAD_ERROR')
    await fail('publishPost', { postId }, 409, 'CONFLICT')
    f.storage.fail = ''
    f.storage.lost = 'remove'
    await fail('removeDraftImage', { postId, imageId: r.imageId }, 422, 'UPLOAD_ERROR')
    await ok('removeDraftImage', { postId, imageId: r.imageId })
    await ok('removeDraftImage', { postId, imageId: r.imageId })
    f.storage.objects.set(r.path, new Blob([png], { type: 'image/png' })) // token cũ có thể tạo orphan, không phục hồi metadata.
    await fail('finalizeImage', { postId, imageId: r.imageId }, 409, 'CONFLICT')
    const replacement = await upload(postId)
    assert.notEqual(replacement.imageId, r.imageId)
    await ok('finalizeImage', { postId, imageId: replacement.imageId })
    assert.equal((await ok('publishPost', { postId })).images[0].id, replacement.imageId)
    assert.ok(
      f.storage.calls.filter((c) => c.operation === 'remove').every((c) => c.path === 'object/post-media'),
    )
  })
  await t.test('remove vs finalize interleaving cannot revive image; finalize proof cannot mutate published post', async () => {
    const postId = await draft()
    const r = await upload(postId)
    let once = true
    f.storage.before = async () => {
      if (once) {
        once = false
        await f.db.query("update post_images set status='REMOVING' where id=$1", [r.imageId])
      }
    }
    await fail('finalizeImage', { postId, imageId: r.imageId }, 409, 'CONFLICT')
    assert.equal(
      (await f.db.query<{ status: string }>('select status from post_images')).rows[0].status,
      'REMOVING',
    )
    await fail('publishPost', { postId }, 409, 'CONFLICT')
  })
  await t.test('concurrent remove is idempotent; exact NoSuchKey retry releases slot but other failures do not', async () => {
    const postId = await draft(), r = await upload(postId)
    await Promise.all([
      ok('removeDraftImage', { postId, imageId: r.imageId }),
      ok('removeDraftImage', { postId, imageId: r.imageId }),
    ])
    const replacement = await upload(postId)
    f.storage.objects.delete(replacement.path)
    f.storage.fail = 'removeMissing'
    await ok('removeDraftImage', { postId, imageId: replacement.imageId })
    assert.equal(
      (await f.db.query<{ n: number }>("select count(*)::integer n from post_images where status='REMOVED'"))
        .rows[0].n,
      2,
    )
    const p = await ok('publishPost', { postId })
    assert.deepEqual(p.images, [])
  })
  await t.test('new helper ACL/security and direct SQL image state/immutability protection', async () => {
    const postId = await draft()
    const r = await upload(postId)
    for (
      const sql of [
        'update post_images set size_bytes=1',
        'update post_images set position=2',
        "update post_images set status='REMOVED'",
      ]
    ) await assert.rejects(f.db.exec(sql))
    await ok('finalizeImage', { postId, imageId: r.imageId })
    await ok('publishPost', { postId })
    await assert.rejects(f.db.exec('delete from post_images'))
    const rows = (await f.db.query<{ prosecdef: boolean; proconfig: string[]; allowed: boolean }>(
      `select prosecdef,proconfig,has_function_privilege('authenticated',oid,'execute') allowed from pg_proc where oid='theou_private.guard_draft_image()'::regprocedure`,
    )).rows
    assert.equal(rows[0].prosecdef, false)
    assert.equal(rows[0].allowed, false)
    assert.ok(rows[0].proconfig.includes('search_path=""'))
    await fail('getPost', { postId: randomUUID() }, 404, 'NOT_FOUND')
  })
})
test('image magic/container allowlist rejects GIF/SVG and MIME mismatches', () => {
  assert.ok(matchesImage(png, 'image/png'))
  assert.equal(matchesImage(png, 'image/jpeg'), false)
  for (const mime of ['image/png', 'image/jpeg', 'image/webp'] as const) {
    assert.equal(matchesImage(new TextEncoder().encode('<svg onload="alert(1)"/>'), mime), false)
  }
})
