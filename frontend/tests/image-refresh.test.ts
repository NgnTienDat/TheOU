import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createImageRefresh } from '../src/features/posts/image-refresh.ts'
import { deferred, post } from './post-fixture.ts'

const image = { id: 'offline-image', signedUrl: 'https://offline.example.invalid/image?token=offline-only', expiresAt: '2030-01-01T00:00:00Z' }
test('gallery refresh shares pending request and caps three attempts across changing URLs', async () => {
  const response = deferred<ReturnType<typeof post>>()
  let calls = 0, accepted = 0
  const refresh = createImageRefresh({
    wait: () => Promise.resolve(), isCurrent: () => true,
    load: () => { calls++; return calls === 1 ? response.promise : Promise.resolve({ ...post(), images: [{ ...image, signedUrl: image.signedUrl + calls }] }) },
    accept: images => { accepted++; assert.equal(images.length, 1) }, reject: () => assert.fail('unexpected failure'),
  })
  const first = refresh.refresh()
  assert.equal(refresh.refresh(), first)
  response.resolve({ ...post(), images: [image] })
  await first
  for (let i = 0; i < 6; i++) await refresh.refresh()
  assert.equal(calls, 3)
  assert.equal(accepted, 3)
})
test('gallery retries safe API failures three times, never publishes error data', async () => {
  let calls = 0, rejected = 0
  const refresh = createImageRefresh({
    wait: () => Promise.resolve(), isCurrent: () => true,
    load: async () => { calls++; throw new Error('private SDK token') },
    accept: () => assert.fail('must not publish failure'), reject: () => { rejected++ },
  })
  await refresh.refresh()
  await refresh.refresh()
  assert.equal(calls, 3)
  assert.equal(rejected, 3)
})
test('gallery discards late response after session change or unmount', async () => {
  for (const change of ['session', 'unmount']) {
    const response = deferred<ReturnType<typeof post>>(), started = deferred<void>()
    let current = true
    const refresh = createImageRefresh({
      wait: () => Promise.resolve(), isCurrent: () => current,
      load: () => { started.resolve(); return response.promise },
      accept: () => assert.fail('stale images'), reject: () => assert.fail('stale error'),
    })
    const pending = refresh.refresh()
    await started.promise
    if (change === 'session') current = false
    else refresh.dispose()
    response.resolve({ ...post(), images: [image] })
    await pending
    await refresh.refresh()
  }
})
test('authorization rejection stops retries once session guard changes', async () => {
  let current = true, calls = 0
  const refresh = createImageRefresh({
    wait: () => Promise.resolve(), isCurrent: () => current,
    load: async () => { calls++; throw new Error('denied') },
    accept: () => assert.fail('denied response'), reject: () => { current = false },
  })
  await refresh.refresh()
  assert.equal(calls, 1)
})

test('hidden refresh consumes no budget; timer/focus/error overlap shares one request', async () => {
  let visible = false, calls = 0
  const response = deferred<ReturnType<typeof post>>()
  const refresh = createImageRefresh({ isVisible: () => visible, isCurrent: () => true, wait: async () => {},
    load: () => { calls++; return response.promise }, accept: () => {}, reject: () => assert.fail() })
  await refresh.refresh(); assert.equal(calls, 0)
  visible = true
  const first = refresh.refresh()
  assert.equal(first, refresh.refresh()); assert.equal(first, refresh.refresh())
  response.resolve(post()); await first
  assert.equal(calls, 1)
  refresh.dispose(); await refresh.refresh(); assert.equal(calls, 1)
})
test('hidden during debounce pauses retries; a newer source defeats late success', async () => {
  let visible = true, generation = 1, calls = 0
  const wait = deferred<void>(), response = deferred<ReturnType<typeof post>>()
  const refresh = createImageRefresh({ isVisible: () => visible, generation: () => generation, isCurrent: () => true,
    wait: () => wait.promise, load: () => { calls++; return response.promise },
    accept: () => assert.fail('must not replace newer URLs'), reject: () => assert.fail() })
  const paused = refresh.refresh(); visible = false; wait.resolve(); await paused
  assert.equal(calls, 0)
  visible = true
  const pending = refresh.refresh(); await Promise.resolve(); generation++
  response.resolve(post()); await pending
  assert.equal(calls, 1)
})
test('late Auth error after account switch/dispose cannot reject the new session', async () => {
  for (const dispose of [false, true]) {
    const response = deferred<ReturnType<typeof post>>(), started = deferred<void>()
    let current = true
    const refresh = createImageRefresh({ wait: async () => {}, isCurrent: () => current,
      load: () => { started.resolve(); return response.promise },
      accept: () => assert.fail(), reject: () => assert.fail('stale Auth rejection') })
    const request = refresh.refresh(); await started.promise
    if (dispose) refresh.dispose(); else current = false
    response.reject(new Error('private Auth failure')); await request
  }
})
test('a query renewing URLs during debounce prevents an unnecessary API call', async () => {
  const wait = deferred<void>()
  let needed = true, calls = 0
  const refresh = createImageRefresh({ isCurrent: () => true, isNeeded: () => needed, wait: () => wait.promise,
    load: async () => { calls++; return post() }, accept: () => {}, reject: () => assert.fail() })
  const pending = refresh.refresh(); needed = false; wait.resolve(); await pending
  await refresh.refresh(); assert.equal(calls, 0)
  needed = true; await refresh.refresh(); assert.equal(calls, 1)
})
