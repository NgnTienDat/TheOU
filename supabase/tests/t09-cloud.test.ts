import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'
import { a, b, postFixture, serverKey, userEmail } from './helpers/post-fixture.ts'
import { t04ProjectRef } from '../scripts/t04-cloud-recovery.ts'
import { type CliExecute } from '../scripts/t08-cloud-cli.ts'
import { createT09Cli } from '../scripts/t09-cloud-cli.ts'
import {
  guardT09Fetch,
  readT09Config,
  runT09Cloud,
  type VoteNetworkScope,
} from '../scripts/t09-cloud-runner.ts'
import {
  approvedVotePost,
  assertVoteBaseline,
  assertVoteProtected,
  fileVoteStore,
  identityHash,
  parseVoteSnapshot,
  validateVoteJournal,
  voteCleanupSql,
  type VoteInventory,
  type VoteJournal,
  type VoteSnapshot,
  voteSnapshotSql,
  voteVerificationSql,
} from '../scripts/t09-cloud-inventory.ts'

const env = {
  THEOU_ALLOW_AUTH_TESTS: 'theou-dev',
  THEOU_AUTH_SUPABASE_URL: `https://${t04ProjectRef}.supabase.co`,
  THEOU_AUTH_PUBLISHABLE_KEY: 'sb_publishable_offline',
  THEOU_ALLOW_T09_CLOUD_WRITES: 'theou-dev',
  THEOU_T09_POST_ID: approvedVotePost,
  THEOU_T06_EMAIL_A: 'offline-a@ou.edu.vn',
  THEOU_T06_EMAIL_B: 'offline-b@ou.edu.vn',
  THEOU_T06_PASSWORD_A: 'offline password A',
  THEOU_T06_PASSWORD_B: 'offline password B',
}
const token = (id: string) => `eyJhbGciOiJFUzI1NiJ9.${btoa(id)}.offline`
type Engine = Awaited<ReturnType<typeof postFixture>>
interface Options {
  networkLoss?: boolean
  intentIo?: boolean
  ackIo?: boolean
  drift?: boolean
  badResponse?: boolean
  failProject?: boolean
  logoutFail?: boolean
}
async function harness(f: Engine, options: Options = {}) {
  await f.reset()
  await f.seed({ id: approvedVotePost })
  await f.seed({ author: b })
  await f.db.query(
    "insert into comments(post_id,author_id,body,idempotency_key) values($1,$2,'Protected OP',$3),($1,$4,'Protected visible B',$5),($1,$4,'Protected deleted',$6)",
    [approvedVotePost, a, randomUUID(), b, randomUUID(), randomUUID()],
  )
  await f.db.query("update comments set status='DELETED' where body='Protected deleted'")
  let saved: VoteJournal | undefined,
    record: VoteInventory | undefined,
    writes = 0,
    acquired = false,
    released = false,
    projects = 0,
    logout = 0
  const logs: string[] = [], actions: string[] = []
  async function snapshot() {
    await f.db.exec('reset role; begin read only')
    let result: VoteSnapshot
    try {
      result = parseVoteSnapshot(
        (await f.db.query<{ snapshot: VoteSnapshot }>(voteSnapshotSql)).rows[0].snapshot,
      )
    } finally {
      await f.db.exec('rollback; set role service_role')
    }
    if (options.drift && writes) result.comments[0].rowHash = 'f'.repeat(32)
    return result
  }
  const store = {
    acquire() {
      checkScope()
      acquired = true
      return Promise.resolve()
    },
    begin(value: VoteInventory) {
      assert.ok(acquired)
      record = structuredClone(value)
      saved = { inventory: structuredClone(value), status: 'PREPARED', uncertain: false, events: [] }
      return Promise.resolve()
    },
    save(value: VoteJournal) {
      validateVoteJournal(value)
      if (
        options.intentIo && value.events.at(-1)?.phase === 'INTENT' ||
        options.ackIo && value.events.some((e) => e.phase === 'ACK')
      ) throw new Error(`private disk ${env.THEOU_T06_PASSWORD_A}`)
      saved = structuredClone(value)
      return Promise.resolve()
    },
    release() {
      released = true
      return Promise.resolve()
    },
  }
  function checkScope() {
    assert.equal(acquired, false)
  }
  const request: typeof fetch = async (input, init) => {
    const url = new URL(String(input)), headers = new Headers(init?.headers)
    assert.equal(url.origin, env.THEOU_AUTH_SUPABASE_URL)
    assert.equal(headers.get('apikey'), env.THEOU_AUTH_PUBLISHABLE_KEY)
    assert.equal(init?.redirect, 'error')
    assert.equal(init?.credentials, 'omit')
    const body = init?.body ? JSON.parse(String(init.body)) : null
    const caller = [a, b].find((id) => headers.get('authorization') === `Bearer ${token(id)}`)
    if (url.pathname === '/auth/v1/token') {
      assert.equal(url.searchParams.get('grant_type'), 'password')
      const id = body.email === env.THEOU_T06_EMAIL_A ? a : b
      return Response.json({
        access_token: token(id),
        refresh_token: 'offline-refresh',
        token_type: 'bearer',
        expires_in: 3600,
        user: { id, email: body.email, email_confirmed_at: '2026-11-01T00:00:00Z' },
      })
    }
    if (url.pathname === '/auth/v1/user') {
      return Response.json({
        id: caller,
        email: caller === a ? env.THEOU_T06_EMAIL_A : env.THEOU_T06_EMAIL_B,
        email_confirmed_at: '2026-11-01T00:00:00Z',
      })
    }
    if (url.pathname === '/auth/v1/logout') {
      logout++
      return options.logoutFail ? Response.json({}, { status: 500 }) : new Response(null, { status: 204 })
    }
    assert.equal(url.pathname, '/functions/v1/social-api')
    actions.push(body.action)
    let mutationIndex = 0
    if (body.action === 'toggleUpvote') {
      writes++
      mutationIndex = writes
      assert.ok(record && saved, 'inventory/WAL before HTTP mutation')
      assert.equal(saved.uncertain, true)
      assert.ok(
        saved.events.some((e) =>
          e.phase === 'INTENT' &&
          e.requests?.some((r) =>
            r.actor === (caller === a ? 'A' : 'B') && r.desiredState === body.payload.desiredState
          )
        ),
      )
    }
    const response = await f.handler(
      f.request(
        body.action,
        body.payload,
        caller ?? null,
        headers.has('authorization') ? { authorization: headers.get('authorization')! } : {},
      ),
    )
    if (options.networkLoss && mutationIndex === 1) throw new Error(`${token(a)} ${serverKey}`)
    if (options.badResponse && body.action === 'toggleUpvote') {
      const body = await response.json()
      body.data.hasUpvoted = false
      body.data.upvoteCount = 0
      return Response.json(body)
    }
    return response
  }
  return {
    snapshot,
    store,
    logs,
    actions,
    get saved() {
      return saved!
    },
    get record() {
      return record!
    },
    get writes() {
      return writes
    },
    get logout() {
      return logout
    },
    get released() {
      return released
    },
    get projects() {
      return projects
    },
    run(mode: '--smoke' | '--write' = '--write') {
      return runT09Cloud(
        readT09Config(env, t04ProjectRef, [mode]),
        env,
        () => Promise.reject(new Error('Unexpected prompt')),
        store,
        snapshot,
        () => {
          projects++
          assert.ok(acquired)
          if (options.failProject) throw new Error('private project error')
          return Promise.resolve()
        },
        (line) => logs.push(line),
        request,
      )
    },
  }
}

test('T09 config exact URL/ref/publishable, default smoke, independent write flag and exact post', () => {
  assert.equal(readT09Config(env, t04ProjectRef, []).mode, '--smoke')
  for (
    const changes of [
      { THEOU_ALLOW_T09_CLOUD_WRITES: '' },
      { THEOU_T09_POST_ID: '' },
      { THEOU_T09_POST_ID: randomUUID() },
      { THEOU_AUTH_SUPABASE_URL: 'https://other.supabase.co' },
      { THEOU_AUTH_PUBLISHABLE_KEY: 'sb_secret_private' },
    ]
  ) {
    assert.throws(() =>
      readT09Config({ ...env, ...changes, THEOU_ALLOW_T08_CLOUD_WRITES: 'theou-dev' }, t04ProjectRef, [
        '--write',
      ])
    )
  }
  assert.throws(() => readT09Config(env, 'wrong', ['--smoke']))
  for (const args of [['--cleanup'], ['--write', '--smoke'], ['--write', '--resume']]) {
    assert.throws(() => readT09Config(env, t04ProjectRef, args))
  }
})
test('T09 network firewall: smoke never toggle; write requires exact intent, caller, shape and scope; no SDK JWT fallback', async () => {
  let sent = 0
  const scope: VoteNetworkScope = {
    tokens: new Map([[token(a), 'A']]),
    permits: [],
    dropSeq: null,
    dropped: false,
  }
  const headers = { apikey: env.THEOU_AUTH_PUBLISHABLE_KEY, authorization: `Bearer ${token(a)}` }
  const request: typeof fetch = () => {
    sent++
    return Promise.resolve(Response.json({}))
  }
  const input = { action: 'toggleUpvote', payload: { postId: approvedVotePost, desiredState: true } }
  const smoke = guardT09Fetch(readT09Config(env, t04ProjectRef, []), scope, request)
  await assert.rejects(
    smoke(`${env.THEOU_AUTH_SUPABASE_URL}/functions/v1/social-api`, {
      method: 'POST',
      headers,
      body: JSON.stringify(input),
    }),
    /NO_UNAPPROVED/,
  )
  const guard = guardT09Fetch(readT09Config(env, t04ProjectRef, ['--write']), scope, request)
  for (
    const change of [input, { ...input, payload: { postId: randomUUID(), desiredState: true } }, {
      ...input,
      payload: { ...input.payload, userId: a },
    }, { action: 'createComment', payload: {} }]
  ) {
    await assert.rejects(
      guard(`${env.THEOU_AUTH_SUPABASE_URL}/functions/v1/social-api`, {
        method: 'POST',
        headers,
        body: JSON.stringify(change),
      }),
    )
  }
  for (const path of ['/rest/v1/post_votes', '/auth/v1/admin/users', '/auth/v1/signup', '/auth/v1/otp']) {
    await assert.rejects(guard(`${env.THEOU_AUTH_SUPABASE_URL}${path}`, { method: 'POST', headers }))
  }
  scope.permits = [{ seq: 1, actor: 'A', desiredState: true }]
  await assert.rejects(
    guard(`${env.THEOU_AUTH_SUPABASE_URL}/functions/v1/social-api`, {
      method: 'POST',
      headers: { ...headers, authorization: `Bearer ${token(b)}` },
      body: JSON.stringify(input),
    }),
  )
  await guard(`${env.THEOU_AUTH_SUPABASE_URL}/functions/v1/social-api`, {
    method: 'POST',
    headers,
    body: JSON.stringify(input),
  })
  await assert.rejects(
    guard(`${env.THEOU_AUTH_SUPABASE_URL}/functions/v1/social-api`, {
      method: 'POST',
      headers,
      body: JSON.stringify(input),
    }),
  )
  assert.equal(sent, 1)
})

test('T09 runner SDK/handler/SQL real local, phases C1–C8 and recovery — PGlite is not Cloud contention', async (t) => {
  const f = await postFixture()
  t.after(() => f.db.close())
  await t.test('snapshot shape/invariants/historical baseline and protected fields fail closed', async () => {
    const h = await harness(f), baseline = await h.snapshot()
    assertVoteBaseline(baseline)
    assert.throws(() => parseVoteSnapshot({ ...baseline, readOnly: 'off' }))
    assert.throws(() => parseVoteSnapshot({ ...baseline, email: env.THEOU_T06_EMAIL_A }))
    assert.throws(() => assertVoteBaseline({ ...baseline, counts: { ...baseline.counts, users: 3 } }))
    for (
      const mutate of [
        (s: VoteSnapshot) => {
          s.comments[0].rowHash = 'e'.repeat(32)
        },
        (s: VoteSnapshot) => {
          s.posts.find((p) => p.id !== approvedVotePost)!.rowHash = 'e'.repeat(32)
        },
        (s: VoteSnapshot) => {
          s.profileHash = 'e'.repeat(32)
        },
        (s: VoteSnapshot) => {
          s.otherHash = 'e'.repeat(32)
        },
      ]
    ) {
      const altered = structuredClone(baseline)
      mutate(altered)
      assert.throws(() => assertVoteProtected(baseline, altered, [identityHash(a), identityHash(b)]))
    }
    const invalid = structuredClone(baseline)
    invalid.posts[0].upvoteCount = 1
    assert.throws(() => parseVoteSnapshot(invalid), /INVARIANT/)
    await f.db.query('insert into post_votes(post_id,user_id) values($1,$2)', [approvedVotePost, b])
    const outside = await h.snapshot()
    assert.throws(() => assertVoteProtected(baseline, outside, [identityHash(a)]), /OUTSIDE_EXACT_SCOPE/)
  })
  await t.test('smoke baseline before/after identical, no toggle/raw/admin, masked artifacts and logout', async () => {
    const h = await harness(f), before = await h.snapshot(), journal = await h.run('--smoke')
    assert.equal(h.writes, 0)
    assert.equal(h.logout, 2)
    assert.ok(h.released)
    assert.equal(h.projects, 1)
    assert.equal(journal.status, 'COMPLETED')
    assert.equal(journal.uncertain, false)
    assert.deepEqual(await h.snapshot(), before)
    assert.deepEqual(journal.events.filter((e) => e.phase === 'VERIFIED').map((e) => e.stage), [
      'C7',
      'C8',
      'FINISH',
    ])
  })
  await t.test('C1–C6 desired-state concurrency, mixed snapshot, controlled ACK loss, C7 exact caller reads; leave A vote for reviewed cleanup', async () => {
    const h = await harness(f), journal = await h.run()
    assert.equal(h.writes, 15)
    assert.equal(journal.status, 'AWAITING_CLEANUP')
    assert.equal(journal.uncertain, false)
    for (
      const [stage, n] of [['C1', 1], ['C2', 0], ['C3', 2], ['C4', 0], ['C6_PREPARE', 0], ['C6_LOST', 1], [
        'C6_RETRY',
        1,
      ]] as const
    ) {
      assert.equal(
        journal.events.find((e) => e.stage === stage && e.phase === 'VERIFIED')!.snapshot!.counts.votes,
        n,
      )
    }
    assert.equal(journal.events.filter((e) => e.phase === 'DROPPED').length, 1)
    assert.equal((await h.snapshot()).votes[0].userHash, identityHash(a))
    assert.equal(h.logout, 2)
    const artifacts = JSON.stringify(journal) + voteCleanupSql(journal) +
      voteVerificationSql(journal.inventory) + h.logs.join('\n')
    for (
      const secret of [
        a,
        b,
        token(a),
        token(b),
        userEmail,
        serverKey,
        env.THEOU_T06_EMAIL_A,
        env.THEOU_T06_PASSWORD_A,
      ]
    ) assert.ok(!artifacts.includes(secret), 'secret/identity redacted')
    assert.match(voteCleanupSql(journal), /user_id in \(a_id,b_id\)/)
    assert.doesNotMatch(
      voteCleanupSql(journal),
      /set upvote_count|delete from public\.(posts|comments|profiles)/i,
    )
  })
  await t.test('missing write-ahead persistence blocks all mutations; IO after ACK leaves durable uncertain intent, no replay', async () => {
    for (const options of [{ intentIo: true }, { ackIo: true }]) {
      const h = await harness(f, options)
      await assert.rejects(h.run(), /T09_/)
      assert.equal(h.writes, options.intentIo ? 0 : 3)
      if (options.ackIo) {
        assert.equal(h.saved.uncertain, true)
        assert.equal(h.saved.events.at(-1)!.phase, 'INTENT')
      }
      assert.ok(h.released)
      assert.equal(h.logout, 2)
    }
  })
  await t.test('real unknown network loss after commit: stop after current batch settles, uncertain, no cleanup SQL or batch replay', async () => {
    const h = await harness(f, { networkLoss: true })
    await assert.rejects(h.run(), /BATCH_FAILED_OR_UNCERTAIN/)
    assert.equal(h.writes, 3)
    assert.equal(h.saved.status, 'FAILED')
    assert.equal(h.saved.uncertain, true)
    assert.equal(h.saved.events.some((e) => e.stage === 'C2'), false)
    assert.doesNotMatch(voteCleanupSql(h.saved), /delete from/i)
    assert.equal((await h.snapshot()).counts.votes, 1)
  })
  await t.test('wrong response state and protected SQL drift are not concurrency PASS; no next batch', async () => {
    for (const options of [{ badResponse: true }, { drift: true }]) {
      const h = await harness(f, options)
      await assert.rejects(h.run(), /T09_/)
      assert.equal(h.writes, 3)
      assert.equal(h.saved.uncertain, true)
      assert.equal(h.saved.status, 'FAILED')
      assert.equal(h.saved.events.some((e) => e.stage === 'C2'), false)
    }
  })
  await t.test('project/baseline failure before credentials or API writes, logout failure never final PASS', async () => {
    const badProject = await harness(f, { failProject: true })
    await assert.rejects(badProject.run())
    assert.equal(badProject.writes, 0)
    assert.equal(badProject.logout, 0)
    assert.ok(badProject.released)
    const h = await harness(f)
    await f.db.query("update comments set status='DELETED' where body='Protected visible B'")
    await assert.rejects(h.run(), /BASELINE_MISMATCH/)
    assert.equal(h.actions.length, 0)
    const badLogout = await harness(f, { logoutFail: true })
    await assert.rejects(badLogout.run('--smoke'), /LOGOUT/)
    assert.equal(badLogout.saved.status, 'FAILED')
  })
  await t.test('cleanup SQL exact runtime UUID ownership, snapshot/dependency drift fail closed, trigger restores baseline; SQL is never run by runner', async () => {
    const h = await harness(f), journal = await h.run(), sql = voteCleanupSql(journal)
    const last = await h.snapshot()
    await f.db.exec('reset role')
    await assert.rejects(f.db.exec(sql), /ownership mismatch/)
    await f.db.exec('rollback')
    await f.db.query(
      "select set_config('theou.t09_user_a',$1,false),set_config('theou.t09_user_b',$2,false)",
      [b, a],
    )
    await assert.rejects(f.db.exec(sql), /ownership mismatch/)
    await f.db.exec('rollback')
    await f.db.query(
      "select set_config('theou.t09_user_a',$1,false),set_config('theou.t09_user_b',$2,false)",
      [a, b],
    )
    await f.db.query("update comments set body='protected drift' where body='Protected OP'")
    await assert.rejects(f.db.exec(sql), /snapshot drift/)
    await f.db.exec('rollback; set role service_role')
    assert.equal((await h.snapshot()).counts.votes, last.counts.votes)
    const clean = await harness(f), cleanJournal = await clean.run()
    await f.db.exec('reset role')
    await f.db.query(
      "select set_config('theou.t09_user_a',$1,false),set_config('theou.t09_user_b',$2,false)",
      [a, b],
    )
    await f.db.exec(voteCleanupSql(cleanJournal))
    const restored = await clean.snapshot()
    assertVoteBaseline(restored)
    assertVoteProtected(cleanJournal.inventory.baseline, restored, [identityHash(a), identityHash(b)])
    const verification = await f.db.query<{ exact_scope: boolean }>(
      voteVerificationSql(cleanJournal.inventory).split(';').filter((s) => s.includes('as exact_scope'))[0],
    )
    assert.equal(verification.rows[0].exact_scope, true)
  })
  await t.test('file mutex, append history, immutable inventory and unresolved journal/crash block new runs', async () => {
    const h = await harness(f), journal = await h.run()
    const dir = await mkdtemp(join(tmpdir(), 'theou-t09-'))
    const directory = pathToFileURL(dir + sep)
    const first = fileVoteStore(directory), second = fileVoteStore(directory)
    try {
      const orphan = join(dir, randomUUID().replaceAll('-', '') + '.json')
      await writeFile(orphan, '{}')
      await assert.rejects(first.acquire(journal.inventory.runId), /ORPHAN_ARTIFACT/)
      await first.release()
      await unlink(orphan)
      await first.acquire(journal.inventory.runId)
      await assert.rejects(second.acquire(randomUUID().replaceAll('-', '')), /SCOPE_BUSY/)
      await second.release()
      await first.begin(journal.inventory)
      await first.save(journal)
      const before = await readFile(join(dir, journal.inventory.runId + '.journal.json'), 'utf8')
      const modified = structuredClone(journal)
      modified.events.shift()
      await assert.rejects(first.save(modified), /HISTORY_IMMUTABLE/)
      await first.release()
      const again = fileVoteStore(directory)
      await assert.rejects(again.acquire(randomUUID().replaceAll('-', '')), /UNRESOLVED_JOURNAL/)
      await again.release()
      assert.equal(await readFile(join(dir, journal.inventory.runId + '.journal.json'), 'utf8'), before)
      await writeFile(join(dir, journal.inventory.runId + '.journal.json'), '{}')
      const corrupt = fileVoteStore(directory)
      await assert.rejects(corrupt.acquire(randomUUID().replaceAll('-', '')), /JOURNAL_INVALID/)
      await corrupt.release()
    } finally {
      await first.release()
      await second.release()
      assert.ok(resolve(dir).startsWith(resolve(tmpdir()) + sep) && dir.includes('theou-t09-'))
      await rm(dir, { recursive: true, force: true })
    }
  })
  await t.test('journal rejects ACK without intent, duplicate ACK, smoke mutation and unresolved intent marked certain', async () => {
    const h = await harness(f), journal = await h.run()
    const missing = structuredClone(journal)
    missing.events = missing.events.filter((e) => e.phase !== 'INTENT')
    assert.throws(() => validateVoteJournal(missing), /ACK_MATCHES_INTENT/)
    const duplicate = structuredClone(journal)
    const index = duplicate.events.findIndex((e) => e.phase === 'ACK')
    duplicate.events.splice(index + 1, 0, structuredClone(duplicate.events[index]))
    assert.throws(() => validateVoteJournal(duplicate), /ACK_MATCHES_INTENT/)
    const smoke = structuredClone(journal)
    smoke.inventory.mode = '--smoke'
    assert.throws(() => validateVoteJournal(smoke), /SMOKE_JOURNAL/)
    const pending = structuredClone(journal)
    pending.status = 'FAILED'
    pending.events = pending.events.slice(0, pending.events.findIndex((e) => e.phase === 'INTENT') + 1)
    pending.uncertain = false
    assert.throws(() => validateVoteJournal(pending), /UNRESOLVED_INTENT/)
    pending.uncertain = true
    validateVoteJournal(pending)
  })
  await t.test('CLI project and snapshot success use exact ref/read-only and parse safe snapshot envelope', async () => {
    const h = await harness(f), baseline = await h.snapshot()
    let projects = 0, queries = 0
    const execute: CliExecute = (_file, args) => {
      if (args[0] === '--version') return Promise.resolve({ stdout: '3.1.0', stderr: '' })
      if (args[0] === 'projects') {
        projects++
        return Promise.resolve({
          stdout: JSON.stringify([{
            id: t04ProjectRef,
            ref: t04ProjectRef,
            name: 'TheOU-dev',
            linked: true,
            status: 'ACTIVE_HEALTHY',
          }]),
          stderr: '',
        })
      }
      queries++
      assert.ok(args.includes('--read-only'))
      assert.ok(args.includes(`--remote=${t04ProjectRef}`))
      assert.equal(args.at(-1), voteSnapshotSql)
      return Promise.resolve({ stdout: JSON.stringify({ rows: [{ snapshot: baseline }] }), stderr: '' })
    }
    const cli = await createT09Cli({ THEOU_SUPABASE_CLI: 'offline.exe' }, execute)
    await cli.project()
    assert.deepEqual(await cli.snapshot(), baseline)
    assert.equal(projects, 1)
    assert.equal(queries, 1)
  })
})

test('T09 CLI native invocation: pinned version/exact remote/read-only SQL/no shell; sanitized JSON/process diagnostics', async () => {
  const cliEnv = { THEOU_SUPABASE_CLI: 'offline supabase.exe' }
  for (const failure of ['version', 'json', 'timeout', 'permission', 'query', 'shape']) {
    const execute: CliExecute = (file, args, options) => {
      assert.equal(file, cliEnv.THEOU_SUPABASE_CLI)
      assert.equal(Object.hasOwn(options, 'shell'), false)
      assert.equal(options.windowsHide, true)
      assert.equal(options.env.DO_NOT_TRACK, '1')
      assert.equal(options.env.SUPABASE_NO_UPDATE_NOTIFIER, '1')
      if (args[0] === '--version') {
        return Promise.resolve({ stdout: failure === 'version' ? '3.2.0' : '3.1.0', stderr: '' })
      }
      assert.deepEqual(args.slice(0, -1), [
        'db',
        'query',
        `--remote=${t04ProjectRef}`,
        '--read-only',
        '--output-format',
        'json',
      ])
      assert.equal(args.at(-1), voteSnapshotSql)
      if (failure === 'timeout') throw { code: 'ETIMEDOUT', stderr: env.THEOU_T06_PASSWORD_A }
      if (failure === 'permission') {
        throw { code: 1, stdout: JSON.stringify({ error: { status: 403, message: token(a) } }) }
      }
      if (failure === 'query') {
        throw { code: 1, stderr: JSON.stringify({ error: { code: '42703', message: serverKey } }) }
      }
      return Promise.resolve({
        stdout: failure === 'json' ? 'not-json ' + token(a) : JSON.stringify([{ snapshot: {} }]),
        stderr: '',
      })
    }
    try {
      await (await createT09Cli(cliEnv, execute)).snapshot()
      assert.fail('must reject')
    } catch (error) {
      const message = (error as Error).message
      assert.match(message, /T09_/)
      assert.doesNotMatch(message, new RegExp(`${token(a)}|${serverKey}|${env.THEOU_T06_PASSWORD_A}`))
    }
  }
})
