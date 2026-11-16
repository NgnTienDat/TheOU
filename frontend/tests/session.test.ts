import assert from 'node:assert/strict'
import { test } from 'node:test'
import { QueryClient } from '@tanstack/react-query'
import type { AuthIdentity, AuthService } from '../src/features/auth/auth-service.ts'
import { createSessionController } from '../src/features/auth/session-controller.ts'
import { SocialApiError } from '../src/shared/api/social-api.ts'

const me = { nickname: 'OUer offline', emailMasked: '***@ou.edu.vn', isAdmin: false }
const user = { userId: 'offline-A', token: 'offline-A-token' }
const tick = () => new Promise(resolve => setTimeout(resolve, 10))
function fixture(initial: AuthIdentity | null = user, getMe = async () => ({ ...me })) {
  let listener: (value: AuthIdentity | null) => void = () => {}
  let unsubscribed = false
  let logoutCalls = 0
  const auth = {
    restore: async () => initial,
    subscribe: (callback: typeof listener) => { listener = callback; return () => { unsubscribed = true } },
    logout: async () => { logoutCalls++; listener(null) },
  } as AuthService
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  const controller = createSessionController(auth, { getMe }, cache)
  return { controller, cache, auth, emit: (value: AuthIdentity | null) => listener(value), get unsubscribed() { return unsubscribed }, get logoutCalls() { return logoutCalls } }
}
test('refresh restore session, getMe trước ready; guest không có profile; unsubscribe', async () => {
  const f = fixture()
  const stop = f.controller.start()
  assert.equal(f.controller.getSnapshot().phase, 'loading')
  await tick()
  assert.deepEqual(f.controller.getSnapshot(), { phase: 'ready', me })
  stop(); assert.equal(f.unsubscribed, true)
  const guest = fixture(null)
  const end = guest.controller.start(); await tick()
  assert.deepEqual(guest.controller.getSnapshot(), { phase: 'guest', me: null }); end()
})
test('403 BANNED/domain/confirmed không vào ready; 401 JWT expired về guest, logout', async () => {
  for (const code of ['FORBIDDEN', 'UNAUTHENTICATED', 'INTERNAL_ERROR'] as const) {
    const f = fixture(user, async () => { throw new SocialApiError(code) })
    const stop = f.controller.start(); await tick()
    assert.equal(f.controller.getSnapshot().phase, code === 'FORBIDDEN' ? 'blocked' : code === 'UNAUTHENTICATED' ? 'guest' : 'error')
    assert.equal(f.controller.getSnapshot().me, null)
    assert.equal(f.cache.getQueryCache().getAll().length, 0)
    if (code === 'UNAUTHENTICATED') assert.equal(f.logoutCalls, 1)
    stop()
  }
})
test('logout xóa cache và dữ liệu cũ; getMe response tới muộn không khôi phục profile', async () => {
  let resolve!: (value: typeof me) => void
  const f = fixture(user, () => new Promise(r => { resolve = r }))
  const stop = f.controller.start(); await tick()
  await f.controller.logout()
  resolve(me); await tick()
  assert.deepEqual(f.controller.getSnapshot(), { phase: 'guest', me: null })
  assert.equal(f.cache.getQueryCache().getAll().length, 0)
  stop()
})
test('đổi user không giữ data cũ; metadata không set ADMIN; update cũ không đổi user mới', async () => {
  const f = fixture()
  const stop = f.controller.start(); await tick()
  const oldMe = f.controller.getSnapshot().me!
  f.emit({ userId: 'offline-B', token: 'offline-B-token' })
  assert.deepEqual(f.controller.getSnapshot(), { phase: 'loading', me: null })
  await tick()
  f.controller.replaceNickname('Không được ghi', oldMe)
  assert.notEqual(f.controller.getSnapshot().me?.nickname, 'Không được ghi')
  f.controller.replaceNickname('Tên mới', f.controller.getSnapshot().me!)
  assert.equal(f.controller.getSnapshot().me?.nickname, 'Tên mới')
  assert.equal(f.controller.getSnapshot().me?.isAdmin, false)
  f.controller.reject(new SocialApiError('FORBIDDEN'))
  assert.deepEqual(f.controller.getSnapshot(), { phase: 'blocked', me: null })
  stop()
})
test('error retry tải lại profile, không redirect loop; callback Auth không chờ API', async () => {
  let calls = 0
  const f = fixture(user, async () => { if (++calls === 1) throw new Error('private'); return me })
  const stop = f.controller.start(); await tick()
  assert.equal(f.controller.getSnapshot().phase, 'error')
  f.controller.retry(); await tick()
  assert.equal(f.controller.getSnapshot().phase, 'ready')
  f.emit(null)
  assert.equal(f.controller.getSnapshot().phase, 'guest')
  stop()
})

test('retry restore tới muộn sau logout không khôi phục user cũ; logout lỗi vẫn ẩn dữ liệu', async () => {
  const f = fixture(null)
  const stop = f.controller.start(); await tick()
  let resolve!: (value: AuthIdentity) => void
  f.auth.restore = () => new Promise(done => { resolve = done })
  f.controller.retry()
  await f.controller.logout()
  resolve(user); await tick()
  assert.deepEqual(f.controller.getSnapshot(), { phase: 'guest', me: null })
  f.auth.logout = async () => { throw new Error('private') }
  await assert.rejects(f.controller.logout())
  assert.deepEqual(f.controller.getSnapshot(), { phase: 'error', me: null })
  assert.equal(f.cache.getQueryCache().getAll().length, 0)
  stop()
})
