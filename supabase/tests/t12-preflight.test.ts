import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { a, b, postFixture } from './helpers/post-fixture.ts'
import { identityHash } from '../scripts/t09-cloud-inventory.ts'
import { type ModerationSnapshot } from '../scripts/t11-cloud-inventory.ts'
import {
  assertNoT12Incidents,
  type T12ReadJournal,
  t12ReadStore,
  withT12ProjectLock,
} from '../scripts/t12-evidence.ts'
import { createT12Cli, runT12Preflight } from '../scripts/t12-cloud-runner.ts'
import {
  adminTargetEmailHash,
  assertT12WriteGate,
  parseT12Proof,
  readT12Compatibility,
  readT12Config,
  sha256,
  t12ApprovalFlags,
  t12FixturePlan,
  t12Origin,
  t12RoleReviewTemplate,
  t12SnapshotSql,
  verifyT12Actor,
} from '../scripts/t12-preflight.ts'
import { t04ProjectRef } from '../scripts/t04-cloud-recovery.ts'

const config = {
  THEOU_ALLOW_T12_PREFLIGHT: 'theou-dev',
  THEOU_AUTH_SUPABASE_URL: t12Origin,
}
const temp = async () => pathToFileURL((await mkdtemp(join(tmpdir(), 'theou-t12-'))) + '/')

test('T12 exact project/default read-only/independent approvals, no executable write mode', () => {
  assert.equal(readT12Config(config, t04ProjectRef, []).mode, '--preflight')
  assert.equal(readT12Config({}, '', ['--prepare']).mode, '--prepare')
  for (
    const [env, ref, args] of [
      [{}, t04ProjectRef, []],
      [config, 'wrong', []],
      [
        { ...config, THEOU_AUTH_SUPABASE_URL: t12Origin + '/' },
        t04ProjectRef,
        [],
      ],
      [config, t04ProjectRef, ['--fixture-write']],
      [config, t04ProjectRef, ['--preflight', '--write']],
      [
        { ...config, THEOU_ALLOW_T11_FIXTURE_WRITES: 'theou-dev' },
        t04ProjectRef,
        [],
      ],
      ...t12ApprovalFlags.map((
        key,
      ) => [{ ...config, [key]: 'theou-dev' }, t04ProjectRef, []]),
    ] as [NodeJS.ProcessEnv, string, string[]][]
  ) assert.throws(() => readT12Config(env, ref, args))
  for (const phase of ['auth', 'fixtures', 'moderation', 'role'] as const) {
    assert.throws(
      () =>
        assertT12WriteGate(
          phase,
          Object.fromEntries(t12ApprovalFlags.map((k) => [k, 'theou-dev'])),
        ),
      /NOT_IMPLEMENTED/,
    )
  }
})

test('T12 manifest budget, states, relationships, count/audit deltas and role templates are non-executable', () => {
  const posts = t12FixturePlan.filter((f) => f.kind === 'POST'),
    comments = t12FixturePlan.filter((f) => f.kind === 'COMMENT')
  assert.equal(posts.length, 4)
  assert.equal(comments.length, 5)
  assert.equal(posts.reduce((sum, p) => sum + p.images, 0), 3)
  for (const post of posts) {
    assert.equal(
      comments.filter((c) => c.parent === post.label && c.final === 'VISIBLE')
        .length,
      post.visibleCount,
    )
  }
  assert.equal(t12FixturePlan.filter((f) => f.final === 'HIDDEN').length, 2)
  assert.ok(!JSON.stringify(t12FixturePlan).includes('706637'))
  for (const mode of ['grant', 'revoke'] as const) {
    const text = t12RoleReviewTemplate(mode)
    assert.match(text, /BLOCKED/)
    assert.match(text, /postcondition/)
    assert.doesNotMatch(text, /\b[0-9a-f]{8}-[0-9a-f-]{27}\b|@ou[.]edu[.]vn/)
  }
})

test('T12 read-only SQL on PGlite: compatibility, Auth, RLS, media and full fingerprints fail closed', async (t) => {
  const f = await postFixture(), compatibility = await readT12Compatibility()
  try {
    await f.db.exec(`reset role;
      alter table auth.users add email text, add email_confirmed_at timestamptz, add is_anonymous boolean default false;
      update auth.users set email='offline.student@ou.edu.vn',email_confirmed_at=now();
      create schema storage;create table storage.buckets(id text primary key,public boolean,file_size_limit bigint,allowed_mime_types text[]);
      create table storage.objects(name text primary key,bucket_id text,metadata jsonb);alter table storage.objects enable row level security;
      insert into storage.buckets values('post-media',false,2097152,array['image/jpeg','image/png','image/webp']);
      create schema supabase_migrations;create table supabase_migrations.schema_migrations(version text primary key);`)
    for (const version of compatibility.versions) {
      await f.db.query(
        'insert into supabase_migrations.schema_migrations values($1)',
        [version],
      )
    }
    await f.db.exec('set role service_role')
    const post = await f.seed()
    const sql = t12SnapshotSql(compatibility)
    assert.match(sql, /select/i)
    assert.doesNotMatch(
      sql,
      /\b(insert into|delete from|update public|grant execute)\b/i,
    )
    const proof = async () => {
      await f.db.exec('reset role')
      await f.db.exec('begin read only')
      try {
        return (await f.db.query<
          {
            proof: {
              snapshot: ModerationSnapshot
              compatibility: boolean
              existingAuthEligible: boolean
            }
          }
        >(sql)).rows[0].proof
      } finally {
        await f.db.exec('rollback')
      }
    }
    const value = await proof(), expected = value.snapshot
    await t.test('fresh proof twice matches independent expected; no row writes', async () => {
      assert.equal(value.compatibility, true)
      assert.equal(value.existingAuthEligible, true)
      assert.deepEqual(
        parseT12Proof(value, expected),
        parseT12Proof(await proof(), expected),
      )
      assert.equal(expected.business.counts.users, 2)
    })
    await t.test('T02 CF-01 historical rls_auto_enable DEFINER and ensure_rls binding pass the T12 full proof', async () => {
      const fixture = (await readFile(new URL('./fixtures/rls-auto-enable.sql', import.meta.url), 'utf8'))
        .replaceAll('\r\n', '\n')
      await f.db.exec('begin')
      try {
        await f.db.exec(fixture)
        await f.db.exec('set local transaction_read_only=on')
        const row = (await f.db.query<{ proof: unknown }>(sql)).rows[0].proof
        assert.deepEqual(parseT12Proof(row, expected), expected)
      } finally {
        await f.db.exec('rollback')
      }
    })
    await t.test('CF-01 rejects signature/security/body/event drift and NULL metadata; no general DEFINER exception', async () => {
      const fixture = (await readFile(new URL('./fixtures/rls-auto-enable.sql', import.meta.url), 'utf8'))
        .replaceAll('\r\n', '\n')
      await f.db.exec('begin')
      try {
        await f.db.exec(fixture)
        await f.db.exec('create role t12_other_owner superuser')
        const mutations = [
          'alter function public.rls_auto_enable() rename to ensure_rls',
          'create function public.rls_auto_enable(integer) returns integer language sql as $$select 1$$',
          'create function public.t11_admin_hide_content(uuid,text) returns integer language sql as $$select 1$$',
          'alter function public.t11_admin_hide_content(uuid,text,uuid,text) reset all',
          'alter function public.t11_admin_hide_content(uuid,text,uuid,text) owner to t12_other_owner',
          'grant execute on function public.t11_admin_hide_content(uuid,text,uuid,text) to anon',
          'alter function public.rls_auto_enable() owner to t12_other_owner',
          'alter function public.rls_auto_enable() security invoker',
          'alter function public.rls_auto_enable() reset all',
          'alter function public.rls_auto_enable() set search_path=public',
          "update pg_proc set proconfig=array[null]::text[] where oid='public.rls_auto_enable()'::regprocedure",
          "update pg_proc set prosrc=prosrc || E'\\n-- drift' where oid='public.rls_auto_enable()'::regprocedure",
          "update pg_proc set prolang=(select oid from pg_language where lanname='sql') where oid='public.rls_auto_enable()'::regprocedure",
          "update pg_proc set proretset=true where oid='public.rls_auto_enable()'::regprocedure",
          'alter event trigger ensure_rls rename to unexpected_binding',
          'alter event trigger ensure_rls disable',
          'alter event trigger ensure_rls enable always',
          'alter event trigger ensure_rls owner to t12_other_owner',
          'drop event trigger ensure_rls',
          "drop event trigger ensure_rls;create event trigger ensure_rls on ddl_command_end when tag in ('CREATE TABLE') execute function public.rls_auto_enable()",
          'drop event trigger ensure_rls;create event trigger ensure_rls on ddl_command_end execute function public.rls_auto_enable()',
          "create event trigger extra_binding on ddl_command_end when tag in ('CREATE TABLE') execute function public.rls_auto_enable()",
          'create function public.wrong_binding() returns event_trigger language plpgsql as $$begin return;end;$$;drop event trigger ensure_rls;create event trigger ensure_rls on ddl_command_end execute function public.wrong_binding()',
          'drop event trigger ensure_rls;drop function public.rls_auto_enable();create function public.rls_auto_enable() returns integer language sql as $$select 1$$',
          'create function public.unreviewed_rpc() returns integer language sql security definer as $$select 1$$',
          'drop function public.t11_admin_hide_content(uuid,text,uuid,text)',
        ]
        for (const change of mutations) {
          await f.db.exec('savepoint event_drift')
          try {
            await f.db.exec(change)
            const row = (await f.db.query<{ proof: { compatibility: boolean } }>(sql)).rows[0].proof
            assert.equal(row.compatibility, false, change)
            assert.throws(() => parseT12Proof(row, expected), /T12_COMPATIBILITY_OR_EXISTING_AUTH/)
          } finally {
            await f.db.exec('rollback to savepoint event_drift')
          }
        }
        await f.db.exec('set local transaction_read_only=on')
        assert.deepEqual(
          parseT12Proof((await f.db.query<{ proof: unknown }>(sql)).rows[0].proof, expected),
          expected,
        )
      } finally {
        await f.db.exec('rollback')
      }
    })
    await t.test('database read-only rejects writes inside allowed WITH/SELECT prefixes, full proof unchanged', async () => {
      for (
        const statement of [
          "with changed as (update public.posts set body='changed' returning id) select * from changed",
          'with changed as (delete from public.posts returning id) select * from changed',
          'select 1 into public.t12_forbidden_table',
        ]
      ) {
        await f.db.exec('begin read only')
        try {
          await assert.rejects(f.db.query(statement), (error: unknown) => {
            assert.equal((error as { code: string }).code, '25006')
            return true
          })
        } finally {
          await f.db.exec('rollback')
        }
      }
      assert.deepEqual(parseT12Proof(await proof(), expected), expected)
    })
    await t.test('same counts but body/profile/Storage drift is not accepted', async () => {
      for (
        const change of [
          "update public.posts set body='changed'",
          "update public.profiles set nickname='Changed nickname'",
          'update storage.buckets set file_size_limit=123',
        ]
      ) {
        await f.db.exec('begin')
        await f.db.exec(change)
        const row = (await f.db.query<{ proof: unknown }>(sql)).rows[0].proof
        assert.throws(() => parseT12Proof(row, expected))
        await f.db.exec('rollback')
      }
    })
    await t.test('unexpected migration, function-body drift, MIME/RLS/EXECUTE drift rejected', async () => {
      for (
        const change of [
          "insert into supabase_migrations.schema_migrations values('20990101000000')",
          "update pg_proc set prosrc=prosrc || E'\\n-- drift' where oid='theou_private.guard_audit_immutable()'::regprocedure",
          "update storage.buckets set allowed_mime_types=array['image/png']",
          'alter table public.posts no force row level security',
          'grant execute on function public.t11_admin_hide_content(uuid,text,uuid,text) to authenticated',
          'create function public.unreviewed_rpc() returns integer language sql as $$select 1$$',
        ]
      ) {
        await f.db.exec('begin')
        await f.db.exec(change)
        const changed = (await f.db.query<{ proof: unknown }>(sql)).rows[0].proof
        assert.throws(() => parseT12Proof(changed, expected))
        await f.db.exec('rollback')
      }
    })
    await t.test('unconfirmed/outside OU/anonymous/BANNED/missing profile rejected; no profile provisioning', async () => {
      for (
        const change of [
          'update auth.users set email_confirmed_at=null',
          "update auth.users set email='outside@example.invalid'",
          'update auth.users set is_anonymous=true',
          "update public.profiles set status='BANNED'",
          'delete from public.profiles',
        ]
      ) {
        await f.db.exec('begin')
        await f.db.exec(change)
        assert.equal(
          (await f.db.query<{ proof: { existingAuthEligible: boolean } }>(sql))
            .rows[0].proof
            .existingAuthEligible,
          false,
        )
        await f.db.exec('rollback')
      }
    })
    await t.test('role grant/audit/count/security changes cannot be normalized to force PASS', () => {
      const role = structuredClone(value)
      role.snapshot.roles = [{
        actorHash: identityHash(b),
        role: 'ADMIN',
        rowHash: 'a'.repeat(32),
      }]
      role.snapshot.business.counts.roles = 1
      assert.throws(() => parseT12Proof(role, expected))
      const modified = structuredClone(value)
      modified.snapshot.postProofs.find((p) => p.id === post)!.bodyHash = 'b'
        .repeat(32)
      assert.throws(() => parseT12Proof(modified, expected))
      assert.throws(() => parseT12Proof({ ...value, compatibility: false }, expected))
    })
    await t.test('verified identity maps to existing ACTIVE hash, admin email cannot be guessed from aliases', () => {
      const user = {
        id: a,
        email: 'offline.student@ou.edu.vn',
        email_confirmed_at: '2026-11-01T00:00:00Z',
        is_anonymous: false,
      }
      assert.equal(verifyT12Actor(user, user.email, expected), identityHash(a))
      for (
        const patch of [
          { id: 'bad' },
          { email: 'outside@example.invalid' },
          { email_confirmed_at: null },
          {
            is_anonymous: true,
          },
          { is_anonymous: 'false' },
          { id: '00000000-0000-4000-8000-000000000099' },
        ]
      ) {
        assert.throws(() => verifyT12Actor({ ...user, ...patch }, user.email, expected))
      }
      assert.throws(() => verifyT12Actor(user, 'other@ou.edu.vn', expected))
      assert.throws(() => verifyT12Actor(user, user.email, expected, true))
      assert.match(adminTargetEmailHash, /^[a-f0-9]{64}$/)
    })
    await t.test('durable preflight INTENT/ACK/VERIFIED; timeout/drift/I/O fail closed without business calls', async () => {
      for (
        const fault of [
          '',
          'intentIo',
          'ackIo',
          'unknownCommit',
          'drift',
          'extraIncident',
        ]
      ) {
        let calls = 0, saved: T12ReadJournal | undefined
        const store = {
          create: (j: T12ReadJournal) => {
            saved = structuredClone(j)
            return Promise.resolve()
          },
          save: (j: T12ReadJournal) => {
            if (fault === 'intentIo' && j.events.at(-1)?.phase === 'INTENT') {
              throw Error('PRIVATE')
            }
            if (fault === 'ackIo' && j.events.at(-1)?.phase === 'ACK') {
              throw Error('PRIVATE')
            }
            saved = structuredClone(j)
            return Promise.resolve()
          },
        }
        const logs: string[] = []
        const run = () =>
          runT12Preflight(
            expected,
            {
              project: () => {
                calls++
                if (fault === 'unknownCommit') throw Error('PRIVATE UUID JWT')
                return Promise.resolve()
              },
              snapshot: () => {
                calls++
                return Promise.resolve(
                  fault === 'drift' ? { ...value, compatibility: false } : value,
                )
              },
            },
            store,
            () => {
              if (fault === 'extraIncident') throw Error('PRIVATE')
              return Promise.resolve()
            },
            (line) => logs.push(line),
          )
        if (fault) {
          await assert.rejects(run())
          assert.equal(saved?.uncertain, true)
          assert.ok(!logs.length)
          if (fault === 'intentIo' || fault === 'extraIncident') {
            assert.equal(calls, 0)
          }
        } else {
          await run()
          assert.equal(saved?.status, 'PREFLIGHT_COMPLETE')
          assert.equal(saved?.events.length, 9)
          assert.deepEqual(saved?.baseline, expected)
          assert.equal(calls, 3)
          assert.match(logs[0], /AUTH_POLICY_ACTORS_EDGE_DEPLOYMENT_PENDING/)
          assert.doesNotMatch(logs[0], /PRIVATE|@|https|00000000-/)
        }
      }
    })
    await t.test('real local read-only orchestration owns lock/journal; receipt records fresh baseline and cannot overwrite', async () => {
      const root = await temp(), legacy = new URL('t11-moderation/', root)
      await mkdir(legacy)
      for (let i = 0; i < 19; i++) {
        await writeFile(new URL(`${i}.sql`, legacy), '')
      }
      const relative = 't12-e2e/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/preflight.journal.json'
      const store = t12ReadStore(
        new URL('t12-e2e/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/', root),
      )
      await withT12ProjectLock(() =>
        runT12Preflight(
          expected,
          {
            project: () => Promise.resolve(),
            snapshot: () => Promise.resolve(value),
          },
          store,
          () => assertNoT12Incidents(root, true, relative),
          () => {},
        ), root)
      await assertNoT12Incidents(root)
      const receipt = JSON.parse(
        await readFile(new URL(relative, root), 'utf8'),
      ) as T12ReadJournal
      assert.equal(receipt.status, 'PREFLIGHT_COMPLETE')
      assert.deepEqual(receipt.baseline, expected)
      await assert.rejects(store.create(receipt))
      const bytes = await readFile(new URL(relative, root))
      let replayCalls = 0
      await assert.rejects(runT12Preflight(
        expected,
        {
          project: () => {
            replayCalls++
            return Promise.resolve()
          },
          snapshot: () => {
            replayCalls++
            return Promise.resolve(value)
          },
        },
        store,
        () => Promise.resolve(),
        () => {},
      ))
      assert.equal(replayCalls, 0)
      assert.deepEqual(await readFile(new URL(relative, root)), bytes)
    })
    await t.test('AFTER is a fresh full proof; same-count drift, timeout and unknown response never complete or replay', async () => {
      for (const fault of ['rowDrift', 'timeout', 'unknownResponse']) {
        const root = await temp(),
          directory = new URL('receipt/', root),
          store = t12ReadStore(directory)
        let snapshots = 0
        const cli = {
          project: () => Promise.resolve(),
          snapshot: () => {
            if (++snapshots === 1) {
              return Promise.resolve(structuredClone(value))
            }
            if (fault === 'timeout') {
              return Promise.reject(
                Object.assign(new Error('PRIVATE'), { code: 'ETIMEDOUT' }),
              )
            }
            if (fault === 'unknownResponse') {
              return Promise.resolve({ rows: [] })
            }
            const changed = structuredClone(value)
            changed.snapshot.business.profileHash = '0'.repeat(32)
            return Promise.resolve(changed)
          },
        }
        await assert.rejects(
          runT12Preflight(
            expected,
            cli,
            store,
            () => Promise.resolve(),
            () => assert.fail('no PASS'),
          ),
        )
        assert.equal(snapshots, 2)
        const bytes = await readFile(
          new URL('preflight.journal.json', directory),
        )
        const receipt = JSON.parse(bytes.toString()) as T12ReadJournal
        assert.equal(receipt.status, 'UNCERTAIN')
        assert.equal(receipt.uncertain, true)
        assert.deepEqual(receipt.baseline, expected)
        assert.equal(receipt.events.at(-1)?.stage, 'AFTER')
        assert.equal(receipt.events.at(-1)?.phase, 'INTENT')
        await assert.rejects(
          runT12Preflight(
            expected,
            cli,
            store,
            () => Promise.resolve(),
            () => {},
          ),
        )
        assert.equal(snapshots, 2)
        assert.deepEqual(
          await readFile(new URL('preflight.journal.json', directory)),
          bytes,
        )
      }
    })
  } finally {
    await f.db.close()
  }
})

test('T12 local exclusive locks/journal no overwrite; extra unresolved history and lock block', async () => {
  const root = await temp(), legacy = new URL('t11-moderation/', root)
  await mkdir(legacy)
  for (let i = 0; i < 19; i++) await writeFile(new URL(`${i}.sql`, legacy), '')
  await assertNoT12Incidents(root)
  await withT12ProjectLock(async () => {
    await assert.rejects(withT12ProjectLock(async () => {}, root))
    await assert.rejects(assertNoT12Incidents(root))
    await assertNoT12Incidents(root, true)
  }, root)
  const directory = new URL('t12-e2e/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/', root),
    store = t12ReadStore(directory)
  const journal: T12ReadJournal = {
    version: 1,
    projectRef: t04ProjectRef,
    status: 'RUNNING',
    uncertain: true,
    baseline: null,
    events: [],
  }
  await store.create(journal)
  await assert.rejects(store.create(journal))
  await assert.rejects(assertNoT12Incidents(root))
  journal.status = 'PREFLIGHT_COMPLETE'
  journal.uncertain = false
  journal.events = [{ stage: 'PROJECT', phase: 'INTENT', proof: sha256('a') }]
  await store.save(journal)
  await assert.rejects(assertNoT12Incidents(root), /PENDING_INTENT/)
  journal.events.push({ stage: 'PROJECT', phase: 'ACK', proof: sha256('a') }, {
    stage: 'PROJECT',
    phase: 'VERIFIED',
    proof: sha256('a'),
  })
  await store.save(journal)
  await assertNoT12Incidents(root)
  await writeFile(
    new URL('extra-inventory.json', root),
    JSON.stringify({ fixtures: [{ state: 'pending' }] }),
  )
  await assert.rejects(assertNoT12Incidents(root), /UNKNOWN_MUTATION_MARKER/)
  await writeFile(new URL('extra-inventory.json', root), '{}')
  await writeFile(
    new URL('extra.journal.json', root),
    JSON.stringify({ status: 'UNCERTAIN', uncertain: true }),
  )
  await assert.rejects(assertNoT12Incidents(root))
  assert.equal(
    JSON.parse(
      await readFile(new URL('preflight.journal.json', directory), 'utf8'),
    ).status,
    'PREFLIGHT_COMPLETE',
  )
})

test('T12 CLI exact native argv/ref/read-only, pinned version, no Auth/business fetch or shell', async () => {
  const calls: string[][] = []
  const sql = t12SnapshotSql(await readT12Compatibility())
  const cli = await createT12Cli(
    { THEOU_SUPABASE_CLI: 'C:/approved/supabase.exe' },
    sql,
    (_file, args, options) => {
      calls.push([...args])
      assert.equal('shell' in options, false)
      assert.equal(options.windowsHide, true)
      if (args[0] === '--version') {
        return Promise.resolve({ stdout: '3.1.0', stderr: '' })
      }
      if (args[0] === 'projects') {
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
      assert.deepEqual(args, [
        'db',
        'query',
        `--remote=${t04ProjectRef}`,
        '--read-only',
        '--output-format',
        'json',
        sql,
      ])
      assert.match(sql, /^with original as /)
      assert.equal(options.env.DO_NOT_TRACK, '1')
      assert.equal(options.timeout, 60_000)
      return Promise.resolve({
        stdout: JSON.stringify([{ proof: true }]),
        stderr: '',
      })
    },
  )
  await cli.project()
  assert.equal(await cli.snapshot(), true)
  assert.equal(calls.length, 3)
  await assert.rejects(
    createT12Cli(
      { THEOU_SUPABASE_CLI: 'C:/approved/supabase.exe' },
      '',
      () => Promise.resolve({ stdout: '9.0.0', stderr: '' }),
    ),
    /CLI_VERSION/,
  )
})

test('T12 CLI wrong live project, timeout, malformed JSON and unknown proof fail without automatic retry', async () => {
  for (
    const fault of [
      'wrongProject',
      'timeout',
      'invalidJson',
      'emptyRows',
      'extraRows',
    ]
  ) {
    let calls = 0
    const cli = await createT12Cli(
      { THEOU_SUPABASE_CLI: 'C:/approved/supabase.exe' },
      'select 1 as proof',
      (_file, args) => {
        if (args[0] === '--version') {
          return Promise.resolve({ stdout: '3.1.0', stderr: '' })
        }
        calls++
        if (fault === 'timeout') {
          return Promise.reject(
            Object.assign(Error('PRIVATE'), { code: 'ETIMEDOUT' }),
          )
        }
        const stdout = fault === 'wrongProject'
          ? JSON.stringify([{
            id: 'wrong',
            ref: 'wrong',
            name: 'TheOU-dev',
            linked: true,
            status: 'ACTIVE_HEALTHY',
          }])
          : fault === 'invalidJson'
          ? 'PRIVATE INVALID JSON'
          : fault === 'extraRows'
          ? '[{"proof":true},{"proof":true}]'
          : '[]'
        return Promise.resolve({ stdout, stderr: '' })
      },
    )
    await assert.rejects(
      fault === 'wrongProject' ? cli.project() : cli.snapshot(),
    )
    assert.equal(calls, 1)
  }
})
