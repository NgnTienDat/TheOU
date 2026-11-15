import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { readCloudTestConfig } from './cloud-config.ts'

const ref = 'puhkisyehspcmgzerutm'
const env = {
  THEOU_ALLOW_CLOUD_TESTS: 'theou-dev',
  THEOU_TEST_PROJECT_REF: ref,
  THEOU_TEST_SUPABASE_URL: `https://${ref}.supabase.co`,
  THEOU_TEST_PUBLISHABLE_KEY: 'sb_publishable_fake',
  THEOU_TEST_SECRET_KEY: 'sb_secret_fake',
  THEOU_TEST_EMAIL_BASE: 'theou.test@gmail.com',
}

test('test Cloud mặc định bị chặn trước khi khởi tạo SDK', () => {
  assert.throws(() => readCloudTestConfig({}, ref), /Chưa cho phép/)
  assert.throws(() => readCloudTestConfig({ ...env, THEOU_ALLOW_CLOUD_TESTS: 'true' }, ref), /Chưa cho phép/)
})

test('Gmail base được chuẩn hóa, cấu hình thiếu/sai bị chặn trước API', () => {
  for (const email of [undefined, '', ' ', 'user@example.invalid', 'tester@googlemail.com',
    'tester@gmail.com.evil', 'tester+alias@gmail.com', 'te..ster@gmail.com',
    '.tester@gmail.com', 'tester.@gmail.com', 'te ster@gmail.com', 'short@gmail.com',
    `${'a'.repeat(31)}@gmail.com`, 'tester\n@gmail.com']) {
    assert.throws(() => readCloudTestConfig({ ...env, THEOU_TEST_EMAIL_BASE: email }, ref), /THEOU_TEST_EMAIL_BASE/)
  }
  assert.equal(readCloudTestConfig({ ...env, THEOU_TEST_EMAIL_BASE: '  TheOU.Test@GMAIL.COM  ' }, ref).emailBase,
    'theou.test@gmail.com')
  assert.equal(readCloudTestConfig({ ...env, THEOU_TEST_EMAIL_BASE: `${'a'.repeat(30)}@gmail.com` }, ref).emailBase,
    `${'a'.repeat(30)}@gmail.com`)
})

test('test:cloud nạp .env.test.local bằng cờ Node rõ ràng, chỉ thử với dữ liệu giả', () => {
  const { scripts } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.match(scripts['test:cloud'], /^node --env-file=\.env\.test\.local --test tests\/cloud\.integration\.ts$/)
  const directory = mkdtempSync(join(tmpdir(), 'theou-env-test-'))
  try {
    writeFileSync(join(directory, '.env.test.local'), 'THEOU_TEST_EMAIL_BASE=theou.test@gmail.com\n')
    const childEnv = { ...process.env }
    delete childEnv.THEOU_TEST_EMAIL_BASE
    const result = spawnSync(process.execPath, ['--env-file=.env.test.local', '-e',
      'process.stdout.write(process.env.THEOU_TEST_EMAIL_BASE ?? "")'], { cwd: directory, env: childEnv, encoding: 'utf8' })
    assert.equal(result.status, 0)
    assert.equal(result.stdout, env.THEOU_TEST_EMAIL_BASE)
  } finally {
    unlinkSync(join(directory, '.env.test.local'))
    rmdirSync(directory)
  }
})

test('không chạy test trên ref/URL khác project đã xác nhận', () => {
  assert.throws(() => readCloudTestConfig(env, 'anotherprojectrefxxxx'), /không khớp/)
  assert.throws(() => readCloudTestConfig({ ...env, THEOU_TEST_SUPABASE_URL: 'https://example.invalid' }, ref), /URL/)
  assert.throws(() => readCloudTestConfig({ ...env, THEOU_TEST_SECRET_KEY: '' }, ref), /Thiếu/)
  assert.equal(readCloudTestConfig(env, ref).url, env.THEOU_TEST_SUPABASE_URL)
})

test('từ chối project khác dù env, URL và CLI linked ref nhất quán', () => {
  for (const otherRef of ['abcdefghijklmnopqrst', 'zzzzzzzzzzzzzzzzzzzz']) {
    assert.throws(() => readCloudTestConfig({
      ...env,
      THEOU_TEST_PROJECT_REF: otherRef,
      THEOU_TEST_SUPABASE_URL: `https://${otherRef}.supabase.co`,
    }, otherRef), /không khớp/)
  }
})
