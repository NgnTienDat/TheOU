import { readFile } from 'node:fs/promises'
import { createInterface } from 'node:readline/promises'
import { Writable } from 'node:stream'
import { createClient } from '@supabase/supabase-js'
import { ManualAuthError, readManualAuthConfig } from './auth-helpers.ts'
import { manualAuthModes, runManualAuth, type ManualAuthMode } from './auth-manual-flow.ts'
import { runGetMeChecks } from './social-api-manual.ts'

try {
  const mode = process.argv[2]
  if (!manualAuthModes.includes(mode as ManualAuthMode)) {
    throw new ManualAuthError(`Chọn mode: ${manualAuthModes.join(', ')}. Ví dụ: npm run auth:manual -- signup`)
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new ManualAuthError('Chạy trong terminal tương tác để nhập email/mật khẩu/OTP ẩn; không pipe hoặc ghi transcript input.')
  }
  const linkedRef = await readFile(new URL('../.temp/project-ref', import.meta.url), 'utf8')
  const config = readManualAuthConfig(process.env, linkedRef)
  const client = createClient(config.url, config.publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  })
  // Readline xử lý bàn phím nhưng không echo email/mật khẩu/OTP hoặc giữ history.
  const mutedOutput = new Writable({ write(_chunk, _encoding, callback) { callback() } })
  const input = createInterface({ input: process.stdin, output: mutedOutput, terminal: true, historySize: 0 })
  input.on('SIGINT', () => input.close())
  try {
    await runManualAuth(client.auth, mode as ManualAuthMode, async (prompt) => {
      process.stdout.write(prompt)
      try { return await input.question('') }
      finally { process.stdout.write('\n') }
    }, message => process.stdout.write(`${message}\n`), identity =>
      runGetMeChecks(client, config, identity, message => process.stdout.write(`${message}\n`)))
  } finally { input.close() }
} catch (error) {
  process.stderr.write(`${error instanceof ManualAuthError ? error.message : 'Không khởi chạy được manual test. Kiểm tra file env, CLI link và terminal; không in lỗi thô.'}\n`)
  process.exitCode = 1
}
