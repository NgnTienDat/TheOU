import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { runInNewContext } from 'node:vm'
import { resolveT08Cli } from './t08-cloud-cli.ts'
import { readT12Compatibility, sha256, t12SnapshotSql } from './t12-preflight.ts'

// Chỉ đọc binary Windows 3.1.0 đã review; không gọi db query hoặc tải CLI.
const executable = await resolveT08Cli(process.env)
const { stdout } = await promisify(execFile)(executable, ['--version'], {
  env: {
    SystemRoot: process.env.SystemRoot,
    DO_NOT_TRACK: '1',
    SUPABASE_NO_UPDATE_NOTIFIER: '1',
  },
  windowsHide: true,
  timeout: 10_000,
  encoding: 'utf8',
})
assert.equal(stdout.trim(), '3.1.0')
const binary = await readFile(executable)
assert.equal(
  createHash('sha256').update(binary).digest('hex'),
  'f6adec9cab13b017eea61f75e1c54769eb520e0760453fd8a722877a8c0b30ff',
)
const source = binary.toString('utf8')
const tokenizer = source.slice(
  source.indexOf('function Tbe(e,n){'),
  source.indexOf('var VC=S('),
)
const checker = source.slice(
  source.indexOf('var aat,o6o,i6o,YPn='),
  source.indexOf('var sat,cat,lat,uat,pat,dat,NW,fat;'),
)
assert.equal(
  sha256(tokenizer),
  '4d7fef6b25a1bc27046401080b7b8ff72b64fb40be6cb2a610b70deffa86c241',
)
assert.equal(
  sha256(checker),
  'ed95e49743318146533c4fe8ee3fe199ff6549ac88ecd7dff2ba822e178b740c',
)
// Chạy nguyên parser trong VM không process/require/fetch; S chỉ khởi tạo các hằng pure.
const context: Record<string, unknown> = { sql: '' }
runInNewContext(
  `const S = init => init; const VC = () => {}; ${tokenizer}\n${checker}\neRn();`,
  context,
  { timeout: 1000, contextCodeGeneration: { strings: false, wasm: false } },
)
const rejected = (sql: string) => {
  context.sql = sql
  return runInNewContext('ZPn(sql)', context, { timeout: 1000 }) as
    | string
    | undefined
}
const sql = t12SnapshotSql(await readT12Compatibility())
const original = await readFile(
  new URL('../.temp/t12-e2e-review/preflight.sql', import.meta.url),
  'utf8',
)
const revised = await readFile(
  new URL('../.temp/t12-e2e-review/preflight-cli-r1.sql', import.meta.url),
  'utf8',
)
const current = await readFile(
  new URL('../.temp/t12-e2e-review/preflight-cli-r3-v2.sql', import.meta.url),
  'utf8',
)
assert.equal(
  sha256(original),
  'b59f44f73be2e98e3a8f44a732877a10948e19a88efd883fbd5d23df966e072d',
)
assert.equal(sha256(revised), 'bc4378522e14a64b7592914b9e99c8043f5b88b15b21ee6bfa3ff03cb9928c52')
assert.equal(current, `${sql};\n`)
assert.equal(rejected(original), 'BEGIN')
assert.equal(rejected(revised), undefined)
assert.equal(rejected(sql), undefined)
assert.equal(rejected(`${sql};\n`), undefined)
for (
  const statement of [
    'SELECT 1',
    'WITH x AS (SELECT 1) SELECT * FROM x',
    'VALUES (1)',
    'TABLE x',
    'SHOW transaction_read_only',
    'EXPLAIN SELECT 1',
    "SELECT ';DELETE', $$;COMMIT$$ /* ;DROP */; SELECT 2",
  ]
) {
  assert.equal(rejected(statement), undefined)
}
for (
  const statement of [
    'INSERT INTO x VALUES (1)',
    'UPDATE x SET y=1',
    'DELETE FROM x',
    'CREATE TABLE x(y int)',
    'DROP TABLE x',
    'ALTER TABLE x ADD y int',
    'GRANT SELECT ON x TO public',
    'REVOKE ALL ON x FROM public',
    'BEGIN READ ONLY',
    'COMMIT',
    'ROLLBACK',
    'SET transaction_read_only=off',
    'DO $$BEGIN NULL; END$$',
  ]
) {
  assert.ok(rejected(statement))
  assert.ok(rejected(`SELECT 1; ${statement}`))
}
assert.ok(rejected("SELECT 'unterminated"))
assert.ok(rejected('SELECT 1; /* unterminated'))
// Prefix allowlist không phải semantic SQL authorization; DB read-only vẫn bắt buộc.
assert.equal(
  rejected('WITH x AS (DELETE FROM x RETURNING *) SELECT * FROM x'),
  undefined,
)
process.stdout.write(
  'PASS: CLI_3_1_0_OFFLINE_PARSER; ORIGINAL_BEGIN_REJECTED; RUNTIME_R1_R3_ACCEPTED; DML_DDL_TRANSACTION_REJECTED; ZERO_QUERY_EXECUTIONS.\n',
)
