import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readSupabaseEnv } from '../src/shared/lib/env.ts'

const validEnv = {
  VITE_SUPABASE_URL: 'https://example.supabase.co',
  VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_example_for_tests',
}

test('đọc cấu hình công khai và bỏ khoảng trắng', () => {
  assert.deepEqual(readSupabaseEnv({
    ...validEnv, VITE_SUPABASE_URL: ` ${validEnv.VITE_SUPABASE_URL} `,
  }), { url: validEnv.VITE_SUPABASE_URL, publishableKey: validEnv.VITE_SUPABASE_PUBLISHABLE_KEY })
})

test('cho phép HTTP local để phát triển', () => {
  for (const host of ['localhost', '127.0.0.1', '[::1]']) {
    const url = `http://${host}:54321`
    assert.equal(readSupabaseEnv({ ...validEnv, VITE_SUPABASE_URL: url }).url, url)
  }
})

test('từ chối cấu hình thiếu hoặc trống', () => {
  for (const env of [{}, { ...validEnv, VITE_SUPABASE_URL: ' ' }, { ...validEnv, VITE_SUPABASE_PUBLISHABLE_KEY: '' }]) {
    assert.throws(() => readSupabaseEnv(env), /Thiếu cấu hình/)
  }
})

test('từ chối URL sai hoặc mang credentials', () => {
  for (const url of ['invalid', 'http://example.com', 'ftp://localhost', 'https://user:password@example.com', 'https://example.com/path', 'https://example.com?key=value', 'https://example.com#token']) {
    assert.throws(() => readSupabaseEnv({ ...validEnv, VITE_SUPABASE_URL: url }), /URL/)
  }
})

test('từ chối secret, JWT legacy và placeholder mà không lộ giá trị', () => {
  for (const key of ['sb_secret_example_for_tests', 'eyJhbGciOiJub25lIn0.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.', 'YOUR_PUBLISHABLE_KEY']) {
    assert.throws(() => readSupabaseEnv({ ...validEnv, VITE_SUPABASE_PUBLISHABLE_KEY: key }), (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /publishable key/)
      assert.ok(!error.message.includes(key))
      return true
    })
  }
})

test('không cho biến VITE ngoài allowlist đi vào bundle', () => {
  assert.throws(() => readSupabaseEnv({ ...validEnv, VITE_PRIVATE_TOKEN: 'test-only' }), /ngoài danh sách/)
  assert.doesNotThrow(() => readSupabaseEnv({ ...validEnv, SERVER_ONLY: 'test-only' }))
})
