import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createSocialApi, parseSocialResponse, SocialApiError } from '../src/shared/api/social-api.ts'
import { createPostSubmission } from '../src/features/posts/post-submission.ts'
import { emptyDraft } from '../src/features/posts/post-draft.ts'
import { imageDimensions, validateImageFile } from '../src/features/posts/image-processing.ts'
import { deferred, post as makePost } from './post-fixture.ts'
const post = makePost()

const id = '10000000-0000-4000-8000-000000000001'
const imageId = '20000000-0000-4000-8000-000000000001'
const upload = { imageId, path: `posts/${id}/${imageId}.png`, token: 'offline-only-upload' }
const image = {
  id: imageId,
  signedUrl:
    `https://offline.example.invalid/storage/v1/object/sign/post-media/${upload.path}?token=offline-only-read`,
  expiresAt: '2026-11-17T12:05:00Z',
}
const envelope = (data: unknown) => ({ data, error: null, meta: { requestId: id } })
const file = new Blob([new Uint8Array(68)], { type: 'image/png' })
const draft = { ...emptyDraft, body: 'Bài offline' }

test('PublicImage allowlist, URL capability scope and invalid/private fields fail closed', () => {
  const p = { ...post, images: [image] }
  assert.deepEqual(parseSocialResponse(envelope(p), 200, 'getPost'), p)
  for (
    const patch of [
      { authorId: id },
      { storagePath: upload.path },
      { token: upload.token },
      { signedUrl: 'https://example.invalid/storage/v1/object/public/post-media/image.png' },
      { signedUrl: image.signedUrl.replace(id, imageId) },
      { expiresAt: 'bad' },
    ]
  ) {
    assert.throws(
      () => parseSocialResponse(envelope({ ...p, images: [{ ...image, ...patch }] }), 200, 'getPost'),
      SocialApiError,
    )
  }
  assert.throws(
    () => parseSocialResponse(envelope({ ...p, images: [image, image, image] }), 200, 'getPost'),
    SocialApiError,
  )
})
test('three media actions exact DTO, signed upload only/upsert false and safe Storage errors', async () => {
  const calls: unknown[] = []
  const client = {
    functions: {
      invoke: async (
        _name: string,
        options: { body: { action: string; payload: unknown }; headers: unknown },
      ) => {
        calls.push(options)
        const data = options.body.action === 'createImageUpload'
          ? upload
          : options.body.action === 'finalizeImage'
          ? { imageId, status: 'READY' }
          : { success: true }
        return { data: envelope(data), error: null, response: { status: 200 } }
      },
    },
    storage: {
      from: (bucket: string) => {
        assert.equal(bucket, 'post-media')
        return {
          uploadToSignedUrl: async (...args: unknown[]) => {
            calls.push(args)
            return { error: null }
          },
        }
      },
    },
  } as unknown as SupabaseClient
  const api = createSocialApi(client, 'offline-scoped-jwt')
  const reserved = await api.createImageUpload({
    postId: id,
    mimeType: 'image/png',
    sizeBytes: 68,
    position: 1,
  })
  await api.uploadImage(reserved, file)
  assert.deepEqual(calls[1], [upload.path, upload.token, file, {
    contentType: 'image/png',
    cacheControl: '300',
    upsert: false,
  }])
  assert.deepEqual(await api.finalizeImage(id, imageId), { imageId, status: 'READY' })
  assert.deepEqual(await api.removeDraftImage(id, imageId), { success: true })
  const bad = {
    storage: {
      from: () => ({
        uploadToSignedUrl: async () => {
          throw new Error('secret raw credentials')
        },
      }),
    },
  } as unknown as SupabaseClient
  await assert.rejects(
    createSocialApi(bad).uploadImage(upload, file),
    (e) => e instanceof SocialApiError && e.code === 'UPLOAD_ERROR' && !e.message.includes('secret'),
  )
})
test('media response extra identity/path/token rejected outside the upload ACK', () => {
  for (
    const [action, data] of [['createImageUpload', { ...upload, email: 'private' }], ['finalizeImage', {
      imageId,
      status: 'READY',
      path: upload.path,
    }], ['removeDraftImage', { success: true, token: upload.token }]] as const
  ) assert.throws(() => parseSocialResponse(envelope(data), 200, action), SocialApiError)
  assert.throws(
    () =>
      parseSocialResponse(
        { data: null, error: { code: 'UPLOAD_ERROR' }, meta: { requestId: id } },
        422,
        'finalizeImage',
      ),
    (e) => e instanceof SocialApiError && e.code === 'UPLOAD_ERROR',
  )
})
test('file input MIME/size/magic/dimensions checked before browser decoder', () => {
  const png = Uint8Array.from(
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==',
      'base64',
    ),
  )
  assert.deepEqual(imageDimensions(png, 'image/png'), [1, 1])
  validateImageFile(file)
  for (
    const blob of [
      new Blob([], { type: 'image/png' }),
      new Blob(['<svg/>'], { type: 'image/svg+xml' }),
      new Blob([new Uint8Array(16 * 1024 * 1024 + 1)], { type: 'image/png' }),
    ]
  ) assert.throws(() => validateImageFile(blob))
  for (const mime of ['image/jpeg', 'image/webp', 'image/svg+xml']) {
    assert.throws(() => imageDimensions(png, mime))
  }
})
test('0/1/2 images pipeline, phases, double submit, publish after all READY only', async () => {
  for (const count of [0, 1, 2]) {
    const calls: string[] = []
    const ready = new Set<string>()
    const api = {
      createPost: async () => {
        calls.push('create')
        return { postId: id, status: 'DRAFT' as const }
      },
      publishPost: async () => {
        assert.equal(ready.size, count)
        calls.push('publish')
        return post
      },
      createImageUpload: async (input: { position: number }) => {
        calls.push('reserve')
        return { ...upload, imageId: String(input.position) }
      },
      uploadImage: async () => {
        calls.push('upload')
      },
      finalizeImage: async (_p: string, i: string) => {
        ready.add(i)
        calls.push('finalize')
        return { imageId: i, status: 'READY' as const }
      },
    }
    const submission = createPostSubmission(api, () => true, () => {})
    const phases: string[] = []
    submission.subscribe(() => phases.push(submission.getSnapshot().phase))
    for (let n = 0; n < count; n++) assert.ok(submission.addImage(file, 'blob:offline'))
    await Promise.all([submission.submit(draft), submission.submit(draft)])
    assert.equal(calls.filter((s) => s === 'create').length, 1)
    assert.equal(calls.filter((s) => s === 'upload').length, count)
    assert.equal(calls.at(-1), 'publish')
    assert.equal(submission.getSnapshot().phase, 'success')
    if (count) assert.ok(phases.includes('uploading'))
  }
})
test('second image failure retains first READY, refresh token/retry same post+snapshot; lost ACK safe', async () => {
  let create = 0, uploadCount = 0, fail = true
  const ready = new Set<string>()
  const ids: string[] = []
  const api = {
    createPost: async () => {
      create++
      return { postId: id, status: 'DRAFT' as const }
    },
    publishPost: async (p: string) => {
      ids.push(p)
      return post
    },
    createImageUpload: async (input: { position: number }) => ({
      ...upload,
      imageId: String(input.position),
    }),
    uploadImage: async (u: { imageId: string }) => {
      uploadCount++
      if (u.imageId === '2' && fail) throw new SocialApiError('UPLOAD_ERROR')
      ready.add(u.imageId)
    },
    finalizeImage: async (_p: string, i: string) => {
      if (!ready.has(i)) throw new SocialApiError('UPLOAD_ERROR')
      return { imageId: i, status: 'READY' as const }
    },
  }
  const s = createPostSubmission(api, () => true, () => {})
  s.addImage(file, 'blob:1')
  s.addImage(file, 'blob:2')
  assert.equal(s.addImage(file, 'blob:3'), false)
  assert.equal(await s.submit(draft), undefined)
  assert.equal(s.getSnapshot().images[0].status, 'ready')
  assert.equal(s.getSnapshot().images[1].status, 'error')
  assert.equal(ids.length, 0)
  fail = false
  await s.submit({ ...draft, body: 'Không được thay payload' })
  assert.equal(create, 1)
  assert.deepEqual(ids, [id])
  assert.equal(uploadCount, 3)
})
test('lost upload/finalize ACK recovers by finalize without overwrite; publish lost ACK retries same post', async () => {
  let uploaded = false, uploads = 0, finalizes = 0, publishes = 0
  const api = {
    createPost: async () => ({ postId: id, status: 'DRAFT' as const }),
    createImageUpload: async () => upload,
    uploadImage: async () => {
      uploaded = true
      uploads++
      throw new SocialApiError('UPLOAD_ERROR')
    },
    finalizeImage: async () => {
      finalizes++
      if (!uploaded || finalizes === 1) throw new SocialApiError('UPLOAD_ERROR')
      return { imageId, status: 'READY' as const }
    },
    publishPost: async () => {
      publishes++
      if (publishes === 1) throw new SocialApiError('INTERNAL_ERROR')
      return post
    },
  }
  const s = createPostSubmission(api, () => true, () => {})
  s.addImage(file, 'blob:1')
  await s.submit(draft)
  await s.submit(draft)
  assert.equal(s.getSnapshot().attachmentsLocked, true)
  assert.equal(s.addImage(file, 'blob:new-after-unknown-publish'), false)
  await s.removeImage(1)
  assert.equal(s.getSnapshot().images.length, 1)
  await s.submit(draft)
  assert.equal(uploads, 1)
  assert.equal(publishes, 2)
  assert.equal(s.getSnapshot().phase, 'success')
})
test('upload timeout returns safe unknown outcome without a second upload or changing capability', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const waiting = deferred<{ error: null }>()
  let calls = 0
  const client = {
    storage: {
      from: () => ({
        uploadToSignedUrl: () => {
          calls++
          return waiting.promise
        },
      }),
    },
  } as unknown as SupabaseClient
  const promise = createSocialApi(client).uploadImage(upload, file)
  const rejection = assert.rejects(promise, (e) => e instanceof SocialApiError && e.code === 'UPLOAD_ERROR')
  t.mock.timers.tick(30000)
  await rejection
  assert.equal(calls, 1)
  waiting.resolve({ error: null })
})
test('remove before submit/after reservation failure, retry removal, replace same slot new ID', async () => {
  let fail = true
  let removes = 0
  let reserved = 0
  const api = {
    createPost: async () => ({ postId: id, status: 'DRAFT' as const }),
    publishPost: async () => post,
    createImageUpload: async () => {
      reserved++
      if (reserved === 1) throw new SocialApiError('UPLOAD_ERROR')
      return upload
    },
    removeDraftImage: async () => {
      removes++
      if (fail) throw new SocialApiError('UPLOAD_ERROR')
      return { success: true as const }
    },
  }
  const s = createPostSubmission(api, () => true, () => {})
  s.addImage(file, 'blob:1')
  await s.removeImage(1)
  assert.equal(s.getSnapshot().images.length, 0)
  assert.equal(removes, 0)
  s.addImage(file, 'blob:2')
  await s.submit(draft)
  await s.removeImage(1)
  assert.equal(s.getSnapshot().images.length, 1)
  fail = false
  await s.removeImage(1)
  assert.equal(s.getSnapshot().images.length, 0)
  s.addImage(file, 'blob:3')
  assert.equal(s.getSnapshot().images[0].position, 1)
  s.addImage(file, 'blob:4')
  await s.removeImage(1)
  s.addImage(file, 'blob:5')
  assert.deepEqual(s.getSnapshot().images.map((image) => image.position), [1, 2])
})
test('late upload callback after logout never finalize/publish or mutate next session', async () => {
  let current = true
  const waiting = deferred<void>()
  let finalizes = 0, publishes = 0, rejects = 0
  const api = {
    createPost: async () => ({ postId: id, status: 'DRAFT' as const }),
    createImageUpload: async () => upload,
    uploadImage: () => waiting.promise,
    finalizeImage: async () => {
      finalizes++
      return { imageId, status: 'READY' as const }
    },
    publishPost: async () => {
      publishes++
      return post
    },
  }
  const s = createPostSubmission(api, () => current, () => {
    rejects++
  })
  s.addImage(file, 'blob:1')
  const promise = s.submit(draft)
  for (let n = 0; n < 8; n++) await Promise.resolve()
  current = false
  const before = s.getSnapshot()
  waiting.resolve()
  await promise
  assert.equal(finalizes, 0)
  assert.equal(publishes, 0)
  assert.equal(rejects, 0)
  assert.equal(s.getSnapshot(), before)
})
