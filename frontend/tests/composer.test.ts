import assert from 'node:assert/strict'
import { test } from 'node:test'
import { allowsContact, bodyLength, changeDraft, draftPayload, emptyDraft, validateDraft } from '../src/features/posts/post-draft.ts'
import { createPostSubmission } from '../src/features/posts/post-submission.ts'
import { SocialApiError } from '../src/shared/api/social-api.ts'
import type { CreatePostInput } from '../src/shared/api/SocialApiClient.ts'
import { deferred, post } from './post-fixture.ts'

const valid = { ...emptyDraft, body: '  Câu chuyện offline 👋  ' }
test('Composer mặc định CONFESSION/ANONYMOUS; đếm trimmed Unicode 0/1/1000/1001', () => {
  assert.deepEqual(emptyDraft, { body: '', tag: 'CONFESSION', displayMode: 'ANONYMOUS', contactUrl: '' })
  for (const count of [0, 1, 1000, 1001]) {
    const draft = { ...emptyDraft, body: ` ${'👋'.repeat(count)} ` }
    assert.equal(bodyLength(draft.body), count)
    assert.equal(!!validateDraft(draft).body, count === 0 || count > 1000)
  }
  assert.deepEqual(validateDraft(valid), {})
  for (const body of ['x\u0000y', 'x\uD800y', 'x\uDC00y']) assert.ok(validateDraft({ ...valid, body }).body)
  assert.ok(validateDraft({ ...valid, tag: 'BAD' as typeof valid.tag }).tag)
})
test('Contact chỉ NICKNAME + tài liệu/trọ; đổi mode/tag xóa URL và payload bỏ hẳn field', () => {
  const contact = { ...valid, displayMode: 'NICKNAME' as const, tag: 'TAI_LIEU' as const, contactUrl: 'https://ZALO.me:443/offline' }
  assert.equal(allowsContact(contact), true)
  assert.equal(draftPayload(contact).contactUrl, 'https://zalo.me/offline')
  for (const patch of [{ displayMode: 'ANONYMOUS' as const }, { tag: 'CONFESSION' as const }]) {
    const next = changeDraft(contact, patch)
    assert.equal(next.contactUrl, '')
    assert.equal(Object.hasOwn(draftPayload({ ...next, contactUrl: 'https://zalo.me/stale' }), 'contactUrl'), false)
  }
  assert.equal(Object.hasOwn(draftPayload({ ...contact, contactUrl: '' }), 'contactUrl'), false)
})
test('Contact HTTPS/exact host, không credentials/cổng lạ/whitespace/control', () => {
  for (const host of ['zalo.me', 'facebook.com', 'www.facebook.com', 'm.facebook.com', 'm.me']) {
    assert.deepEqual(validateDraft({ ...valid, displayMode: 'NICKNAME', tag: 'TIM_TRO', contactUrl: `https://${host}/offline` }), {})
  }
  for (const contactUrl of ['http://zalo.me/x', 'https://zalo.me.evil.invalid/', 'https://user:pass@zalo.me/', 'https://zalo.me:444/',
    ' https://zalo.me/', 'https://zalo.me/\n', 'javascript:alert(1)', 'https://other.invalid/', `https://m.me/${'x'.repeat(2048)}`]) {
    assert.ok(validateDraft({ ...valid, displayMode: 'NICKNAME', tag: 'TAI_LIEU', contactUrl }).contactUrl)
  }
})
test('Submit invalid không tạo key/API; double submit chỉ một create → ACK → publish; không success sớm', async () => {
  const ack = deferred<{ postId: string; status: 'DRAFT' }>()
  const published = deferred<ReturnType<typeof post>>()
  let keys = 0; let creates = 0; let publishes = 0
  const model = createPostSubmission({ createPost: async () => { creates++; return ack.promise }, publishPost: async id => { publishes++; assert.equal(id, post().id); return published.promise } }, () => true, () => {}, () => { keys++; return post().id })
  await model.submit(emptyDraft); assert.equal(keys, 0)
  const first = model.submit(valid); await model.submit(valid)
  assert.equal(creates, 1); assert.equal(publishes, 0); assert.equal(model.getSnapshot().phase, 'creating')
  ack.resolve({ postId: post().id, status: 'DRAFT' }); await Promise.resolve(); await Promise.resolve()
  assert.equal(model.getSnapshot().phase, 'publishing'); assert.equal(publishes, 1)
  published.resolve(post()); assert.deepEqual(await first, post())
  await model.submit(valid); assert.equal(keys, 1); assert.equal(creates, 1); assert.equal(model.getSnapshot().phase, 'success')
})
test('Create mất response: retry cùng key/payload đã canonical, bất chấp caller thay nội dung', async () => {
  const inputs: CreatePostInput[] = []; let keys = 0
  const model = createPostSubmission({ createPost: async input => { inputs.push({ ...input }); if (inputs.length === 1) throw new Error('private email JWT SQL'); return { postId: post().id, status: 'DRAFT' } }, publishPost: async () => post() }, () => true, () => {}, () => { keys++; return post().id })
  assert.equal(await model.submit(valid), undefined)
  assert.equal(model.getSnapshot().phase, 'failed'); assert.equal(model.getSnapshot().locked, true)
  assert.doesNotMatch(model.getSnapshot().error, /private|JWT|SQL/)
  assert.deepEqual(await model.submit({ ...valid, body: 'Không được đổi', tag: 'TIM_TRO' }), post())
  assert.deepEqual(inputs[0], inputs[1]); assert.equal(inputs[0].body, valid.body.trim()); assert.equal(keys, 1)
})
test('Publish mất response sau commit: chỉ replay cùng postId; không create lần nữa', async () => {
  let creates = 0; const publishes: string[] = []
  const model = createPostSubmission({ createPost: async () => { creates++; return { postId: post().id, status: 'DRAFT' } }, publishPost: async id => { publishes.push(id); if (publishes.length === 1) throw new Error('lost response'); return post() } }, () => true, () => {})
  await model.submit(valid); assert.equal(model.getSnapshot().postId, post().id)
  assert.deepEqual(await model.submit(valid), post()); assert.equal(creates, 1); assert.deepEqual(publishes, [post().id, post().id])
})
test('Conflict/validation/server error giữ khóa và snapshot cho retry, không âm thầm đổi key', async () => {
  for (const code of ['CONFLICT', 'VALIDATION_ERROR', 'INTERNAL_ERROR'] as const) {
    const inputs: CreatePostInput[] = []
    const model = createPostSubmission({ createPost: async input => { inputs.push(input); throw new SocialApiError(code) }, publishPost: async () => { assert.fail('Không publish khi create thất bại') } }, () => true, () => {})
    await model.submit(valid); await model.submit({ ...valid, body: 'Nội dung mới' })
    assert.equal(inputs.length, 2); assert.deepEqual(inputs[0], inputs[1]); assert.equal(model.getSnapshot().locked, true)
    assert.equal(model.getSnapshot().error, new SocialApiError(code).message)
  }
})
test('Logout/đổi phiên/rời trang trước ACK: không publish, không navigate/thông báo của phiên cũ', async () => {
  const ack = deferred<{ postId: string; status: 'DRAFT' }>(); let current = true; let publishes = 0
  const model = createPostSubmission({ createPost: async () => ack.promise, publishPost: async () => { publishes++; return post() } }, () => current, () => assert.fail('Không reject phiên mới'))
  const result = model.submit(valid); current = false; ack.resolve({ postId: post().id, status: 'DRAFT' })
  assert.equal(await result, undefined); assert.equal(publishes, 0)
  await model.submit(valid); assert.equal(publishes, 0)
})
test('Lỗi/publish tới muộn không tác động phiên mới; create mới sau thành công dùng model/key mới', async () => {
  for (const outcome of ['error', 'success']) {
    let current = true; const pending = deferred<ReturnType<typeof post>>()
    const model = createPostSubmission({ createPost: async () => ({ postId: post().id, status: 'DRAFT' }), publishPost: async () => pending.promise }, () => current, () => assert.fail('stale auth reject'))
    const result = model.submit(valid); await Promise.resolve(); current = false
    if (outcome === 'error') pending.reject(new SocialApiError('UNAUTHENTICATED')); else pending.resolve(post())
    assert.equal(await result, undefined)
  }
  const keys: string[] = []
  const api = { createPost: async (input: CreatePostInput) => { keys.push(input.idempotencyKey); return { postId: post().id, status: 'DRAFT' as const } }, publishPost: async () => post() }
  await createPostSubmission(api, () => true, () => {}).submit(valid)
  await createPostSubmission(api, () => true, () => {}).submit(valid)
  assert.notEqual(keys[0], keys[1])
})
