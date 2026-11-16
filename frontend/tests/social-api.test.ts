import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createClient } from '@supabase/supabase-js'
import { createProfileApi, parseSocialResponse, SocialApiError } from '../src/shared/api/social-api.ts'

const me = { nickname: 'OUer offline', emailMasked: '***@ou.edu.vn', isAdmin: false }
const envelope = (data: unknown) => ({ data, error: null, meta: { requestId: '00000000-0000-4000-8000-000000000001' } })
test('adapter getMe/updateNickname gọi functions.invoke, data đúng allowlist', async () => {
  const calls: unknown[] = []
  const client = createClient('https://offline.example.invalid', 'sb_publishable_offline', {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: async (input, init) => {
      assert.equal(new URL(String(input)).pathname, '/functions/v1/social-api')
      const body = JSON.parse(String(init?.body)); calls.push(body)
      return Response.json(envelope(body.action === 'getMe' ? me : { nickname: body.payload.nickname }))
    } },
  })
  const api = createProfileApi(client)
  assert.deepEqual(await api.getMe(), me)
  assert.deepEqual(await api.updateNickname('Tên mới'), { nickname: 'Tên mới' })
  assert.deepEqual(calls, [{ action: 'getMe', payload: {} }, { action: 'updateNickname', payload: { nickname: 'Tên mới' } }])
})
test('adapter loại DTO rò email/id/metadata, envelope malformed và phản hồi không đúng contract', () => {
  for (const body of [
    envelope({ ...me, id: 'private' }), envelope({ ...me, email: 'private@ou.edu.vn' }),
    envelope({ ...me, metadata: { role: 'ADMIN' } }), envelope({ ...me, emailMasked: 'private@ou.edu.vn' }),
    envelope({ ...me, isAdmin: 'true' }), { ...envelope(me), meta: {} }, { data: me }, envelope(null),
  ]) assert.throws(() => parseSocialResponse(body, 200, 'getMe'), SocialApiError)
  assert.deepEqual(parseSocialResponse(envelope(me), 200, 'getMe'), me)
  assert.throws(() => parseSocialResponse(envelope({ nickname: 'Tên mới', status: 'ACTIVE' }), 200, 'updateNickname'))
})
test('handler/gateway 401 và 403 an toàn, server/network không lộ raw errors', async () => {
  for (const [status, expected] of [[401, 'UNAUTHENTICATED'], [403, 'FORBIDDEN'], [400, 'VALIDATION_ERROR'], [503, 'INTERNAL_ERROR']] as const) {
    const client = createClient('https://offline.example.invalid', 'sb_publishable_offline', {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch: async () => Response.json({ code: 'SECRET', message: 'email password JWT SQL' }, { status }) },
    })
    await assert.rejects(createProfileApi(client).getMe(), error => {
      assert.ok(error instanceof SocialApiError)
      assert.equal(error.code, expected)
      assert.doesNotMatch(error.message, /SECRET|email password|JWT|SQL/); return true
    })
  }
})
