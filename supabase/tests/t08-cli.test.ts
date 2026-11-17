import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { type CliExecute, createT08Cli, parseT08Snapshot, resolveT08Cli } from '../scripts/t08-cloud-cli.ts'
import { type CommentBaseline, commentSnapshotSql } from '../scripts/t08-cloud-inventory.ts'
import { protectedComments } from '../scripts/t08-cloud-runner.ts'
import { t04ProjectRef } from '../scripts/t04-cloud-recovery.ts'

const env = {
  THEOU_SUPABASE_CLI: 'C:/offline path & test/supabase.exe',
  PATH: 'offline-path',
  PRIVATE_TEST: 'fake-password-not-to-log',
}
const hash = 'a'.repeat(32), id = '10000000-0000-4000-8000-000000000001'
const baseline: CommentBaseline = {
  readOnly: 'on',
  users: 2,
  profiles: 2,
  roles: 0,
  profileHash: hash,
  roleHash: hash,
  profileOwners: [{ authorHash: hash, status: 'ACTIVE' }],
  comments: [],
  posts: [{
    id,
    authorHash: hash,
    status: 'PUBLISHED',
    commentCount: 0,
    visibleCount: 0,
    immutableHash: hash,
    rowHash: hash,
  }],
}
const result = (value: unknown) => ({ stdout: JSON.stringify(value), stderr: '' })

test('T08 CLI resolver: native PATH executable, pinned npx cache fallback, no shell/npm install', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'theou t08-cli & '))
  try {
    const bin = join(dir, 'native bin'), cache = join(dir, 'npm-cache')
    await mkdir(bin, { recursive: true })
    await writeFile(join(bin, 'npx.cmd'), 'offline shim only')
    const pkg = join(cache, '_npx', 'offline', 'node_modules', '@supabase', 'cli-windows-x64')
    await mkdir(join(pkg, 'bin'), { recursive: true })
    await writeFile(
      join(pkg, 'package.json'),
      JSON.stringify({ name: '@supabase/cli-windows-x64', version: '3.1.0' }),
    )
    const exe = join(pkg, 'bin', 'supabase.exe')
    await writeFile(exe, 'offline native fixture')
    assert.equal(await resolveT08Cli({ PATH: bin, npm_config_cache: cache }, 'win32', 'x64'), exe)
    await writeFile(join(bin, 'supabase.exe'), 'offline native PATH')
    assert.equal(
      await resolveT08Cli({ PATH: bin, npm_config_cache: cache }, 'win32', 'x64'),
      join(bin, 'supabase.exe'),
    )
    await writeFile(
      join(pkg, 'package.json'),
      JSON.stringify({ name: '@supabase/cli-windows-x64', version: '3.2.0' }),
    )
    await assert.rejects(
      resolveT08Cli({ PATH: '', npm_config_cache: cache }, 'win32', 'x64'),
      /EXECUTABLE_NOT_FOUND/,
    )
    await assert.rejects(
      resolveT08Cli({ PATH: '' }, 'win32', 'x64'),
      /stage=RESOLVE; code=EXECUTABLE_NOT_FOUND/,
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
test('T08 CLI explicit path is one executable; cmd/bat shims never passed to execFile or shell', async () => {
  assert.equal(await resolveT08Cli(env), env.THEOU_SUPABASE_CLI)
  for (const path of ['npx.cmd', 'supabase.cmd', 'C:/space & path/SUPABASE.BAT']) {
    await assert.rejects(
      resolveT08Cli({ ...env, THEOU_SUPABASE_CLI: path }),
      /CMD_SHIM_UNSUPPORTED_USE_NATIVE_EXE/,
    )
  }
})
test('T08 CLI native argv/cwd/env preserve multi-line SQL, exact remote/read-only and original process limits', async () => {
  const calls: string[][] = []
  const run: CliExecute = async (file, args, options) => {
    assert.equal(file, env.THEOU_SUPABASE_CLI)
    assert.equal(Object.hasOwn(options, 'shell'), false)
    assert.equal(options.encoding, 'utf8')
    assert.equal(options.windowsHide, true)
    assert.equal(options.timeout, 60_000)
    assert.equal(options.maxBuffer, 8 * 1024 * 1024)
    assert.ok(options.cwd.replaceAll('\\', '/').endsWith('/TheOU/'))
    assert.equal(options.env.PRIVATE_TEST, env.PRIVATE_TEST)
    assert.equal(options.env.DO_NOT_TRACK, '1')
    calls.push(args)
    if (args[0] === '--version') return { stdout: '3.1.0\n', stderr: '' }
    return args[0] === 'projects' ? result({ projects: [] }) : result({ rows: [{ snapshot: baseline }] })
  }
  const cli = await createT08Cli(env, run)
  await cli.projects()
  assert.deepEqual(await cli.snapshot(), baseline)
  assert.deepEqual(calls, [['--version'], ['projects', 'list', '--output-format', 'json'], [
    'db',
    'query',
    `--remote=${t04ProjectRef}`,
    '--read-only',
    '--output-format',
    'json',
    commentSnapshotSql,
  ]])
  assert.ok(commentSnapshotSql.includes('\n'))
  assert.ok(commentSnapshotSql.includes("'readOnly'"))
})
test('T08 CLI pinned version mismatch stops before projects/query', async () => {
  let calls = 0
  await assert.rejects(
    createT08Cli(env, async () => {
      calls++
      return { stdout: '3.2.0', stderr: 'private secret' }
    }),
    /stage=VERSION; code=CLI_VERSION_MISMATCH/,
  )
  assert.equal(calls, 1)
})
test('T08 CLI safe subprocess diagnostics distinguish start, timeout, buffer, auth, permission, SQL and exit failures', async () => {
  const cases: [Record<string, unknown>, string][] = [
    [{ code: 'ENOENT' }, 'EXECUTABLE_NOT_FOUND'],
    [{ code: 'EINVAL' }, 'SUBPROCESS_START_FAILED'],
    [{ code: 'EACCES' }, 'SUBPROCESS_START_FAILED'],
    [{ code: 'EPERM' }, 'SUBPROCESS_START_FAILED'],
    [{ code: 'ETIMEDOUT' }, 'TIMEOUT'],
    [{ killed: true, signal: 'SIGTERM' }, 'TIMEOUT'],
    [{ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }, 'OUTPUT_BUFFER_EXCEEDED'],
    [
      { code: 1, stdout: JSON.stringify({ error: { code: 'DbQueryLoginRequiredError' } }) },
      'CLI_AUTHENTICATION_FAILED',
    ],
    [{ code: 1, stdout: JSON.stringify({ error: { code: '42501' } }) }, 'CLI_PERMISSION_DENIED'],
    [{ code: 1, stdout: JSON.stringify({ error: { code: '42601' } }) }, 'SQL_QUERY_FAILED'],
    [
      { code: 2, stdout: 'PRIVATE SQL email@ou.edu.vn', stderr: 'fake-access-token' },
      'CLI_EXIT_NONZERO; exit=2',
    ],
    [{ code: 'PRIVATE_UNKNOWN' }, 'SUBPROCESS_FAILED'],
  ]
  for (const [failure, expected] of cases) {
    const cli = await createT08Cli(env, async (_file, args) => {
      if (args[0] === '--version') return { stdout: '3.1.0', stderr: '' }
      throw Object.assign(new Error('fake-password email@ou.edu.vn JWT'), failure)
    })
    await assert.rejects(cli.snapshot(), (error) => {
      assert.ok(error instanceof Error)
      assert.ok(error.message.includes(`stage=SNAPSHOT; code=${expected}`))
      assert.doesNotMatch(
        error.message,
        /fake-password|email@|PRIVATE|fake-access-token|42601|DbQueryLoginRequiredError/,
      )
      return true
    })
  }
})
test('T08 CLI project stage diagnostics and invalid JSON never become login failures', async () => {
  for (const text of ['not JSON', 'private warning\n{"rows":[]}']) {
    const cli = await createT08Cli(
      env,
      async (_file, args) =>
        args[0] === '--version' ? { stdout: '3.1.0', stderr: '' } : { stdout: text, stderr: 'private token' },
    )
    await assert.rejects(cli.projects(), /stage=PROJECTS; code=INVALID_JSON_OUTPUT/)
    await assert.rejects(cli.snapshot(), /stage=SNAPSHOT; code=INVALID_JSON_OUTPUT/)
  }
})
test('T08 CLI parses wrapped or plain rows, rejects malformed snapshot and keeps actual count/fingerprint errors distinct', () => {
  for (const value of [[{ snapshot: baseline }], { rows: [{ snapshot: baseline }] }]) {
    assert.deepEqual(parseT08Snapshot(value), baseline)
  }
  for (
    const value of [
      null,
      [],
      { rows: [] },
      { rows: [{ snapshot: null }] },
      { rows: [{ snapshot: { ...baseline, posts: [null] } }] },
      { rows: [{ snapshot: { ...baseline, profiles: 'private' } }] },
      [{ snapshot: baseline }, { snapshot: baseline }],
    ]
  ) assert.throws(() => parseT08Snapshot(value), /SNAPSHOT_SCHEMA_INVALID/)
  const mismatch = structuredClone(baseline)
  mismatch.posts[0].commentCount = 1
  assert.throws(() => parseT08Snapshot([{ snapshot: mismatch }]), /DB_POST_COUNT_OR_STATE/)
  const changed = structuredClone(baseline)
  changed.posts[0].immutableHash = 'b'.repeat(32)
  assert.throws(
    () => protectedComments(baseline, parseT08Snapshot([{ snapshot: changed }])),
    /PROTECTED_POST_CHANGED/,
  )
})
test('T08 CLI JSON rows normalization does not bypass live project verification', async () => {
  const cli = await createT08Cli(
    env,
    async (_file, args) =>
      args[0] === '--version' ? { stdout: '3.1.0', stderr: '' } : result([{ id: 'offline-project' }]),
  )
  assert.deepEqual(await cli.projects(), { projects: [{ id: 'offline-project' }] })
})

test('T08 resume CLI requires SQL exact fixture match; missing/false proof never becomes PASS', () => {
  assert.deepEqual(parseT08Snapshot([{ snapshot: baseline, fixtureScopeMatches: true }], true), baseline)
  assert.throws(
    () => parseT08Snapshot([{ snapshot: baseline, fixtureScopeMatches: false }], true),
    /DB_FIXTURE_EXACT_SCOPE/,
  )
  for (const value of [undefined, 'true', 1, null]) {
    assert.throws(
      () => parseT08Snapshot([{ snapshot: baseline, fixtureScopeMatches: value }], true),
      /SNAPSHOT_SCHEMA_INVALID/,
    )
  }
})
