import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { test } from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { domainRejectionMessage, isOuEmail } from '../scripts/auth-helpers.ts'

test('T03 hook — chạy toàn bộ migration trên PostgreSQL tạm', async (t) => {
  const db = new PGlite()
  t.after(() => db.close())
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create role supabase_auth_admin; create schema auth; create table auth.users(id uuid primary key);
    grant usage on schema public to anon, authenticated, service_role;`)
  for (const name of (await readdir(new URL('../migrations/', import.meta.url))).filter(name => name.endsWith('.sql')).sort()) {
    await db.exec(await readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8'))
  }
  const denied = { error: { http_code: 403, message: domainRejectionMessage } }
  const valid = ['student.test@ou.edu.vn', 'TESTER+otp@OU.EDU.VN', `${'a'.repeat(64)}@ou.edu.vn`]
  const invalid = ['student@gmail.com', 'student@sub.ou.edu.vn', 'student@ou.edu.vn.evil',
    'student@ou.edu.vn@evil.com', 'student@@ou.edu.vn', '@ou.edu.vn', 'student@ou.edu.vn.',
    ' student@ou.edu.vn', 'student@ou.edu.vn\n', 'stu dent@ou.edu.vn', 'student@οu.edu.vn',
    '.student@ou.edu.vn', 'student..test@ou.edu.vn', `${'a'.repeat(65)}@ou.edu.vn`]

  await t.test('supabase_auth_admin gọi hook hợp lệ; domain JS/SQL nhất quán', async () => {
    await db.exec('set role supabase_auth_admin')
    try {
      for (const email of [...valid, ...invalid]) {
        const { rows } = await db.query<{ result: object }>('select theou_private.before_user_created($1::jsonb) as result',
          [JSON.stringify({ user: { email } })])
        assert.deepEqual(rows[0].result, valid.includes(email) ? {} : denied)
        assert.equal(isOuEmail(email), valid.includes(email))
      }
    } finally { await db.exec('reset role') }
  })

  await t.test('payload thiếu/sai kiểu bị từ chối, không tin user_metadata', async () => {
    await db.exec('set role supabase_auth_admin')
    try {
      for (const event of [null, [], {}, { user: null }, { user: [] }, { user: {} },
        { user: { email: null } }, { user: { email: 123 } }, { user: { email: ['test@ou.edu.vn'] } },
        { user: { email: { domain: 'ou.edu.vn' } } },
        { user: { email: 'tester@gmail.com', user_metadata: { email: 'tester@ou.edu.vn', role: 'ADMIN' } } }]) {
        assert.deepEqual((await db.query<{ result: object }>('select theou_private.before_user_created($1::jsonb) as result',
          [JSON.stringify(event)])).rows[0].result, denied)
      }
      assert.deepEqual((await db.query<{ result: object }>('select theou_private.before_user_created(null) as result')).rows[0].result, denied)
    } finally { await db.exec('reset role') }
  })

  await t.test('client/server không được gọi hook, auth admin không được thêm quyền nghiệp vụ', async () => {
    for (const role of ['anon', 'authenticated', 'service_role']) {
      assert.equal((await db.query<{ allowed: boolean }>(`select has_function_privilege($1,
        'theou_private.before_user_created(jsonb)', 'EXECUTE') as allowed`, [role])).rows[0].allowed, false)
      await db.exec(`set role ${role}`)
      try {
        await assert.rejects(db.query(`select theou_private.before_user_created('{}'::jsonb)`),
          (error: unknown) => (error as { code: string }).code === '42501')
      } finally { await db.exec('reset role') }
    }
    assert.deepEqual((await db.query(`select prosecdef, proconfig from pg_proc
      where oid = 'theou_private.before_user_created(jsonb)'::regprocedure`)).rows,
    [{ prosecdef: false, proconfig: ['search_path=""'] }])
    assert.equal((await db.query<{ allowed: boolean }>(`select has_schema_privilege('supabase_auth_admin', 'theou_private', 'USAGE') as allowed`)).rows[0].allowed, true)
    assert.equal((await db.query<{ allowed: boolean }>(`select has_schema_privilege('supabase_auth_admin', 'theou_private', 'CREATE') as allowed`)).rows[0].allowed, false)
    assert.equal((await db.query<{ allowed: boolean }>(`select has_function_privilege('supabase_auth_admin',
      'theou_private.guard_immutable_columns()', 'EXECUTE') as allowed`)).rows[0].allowed, false)
    await db.exec('set role supabase_auth_admin')
    try {
      for (const table of ['profiles', 'user_roles', 'posts', 'comments', 'post_votes', 'post_images',
        'reports', 'moderation_actions', 'rate_limit_counters']) {
        for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
          assert.equal((await db.query<{ allowed: boolean }>(`select has_table_privilege('supabase_auth_admin', $1, $2) as allowed`,
            [`public.${table}`, privilege])).rows[0].allowed, false)
        }
        await assert.rejects(db.query(`select * from public.${table}`),
          (error: unknown) => (error as { code: string }).code === '42501')
      }
    } finally { await db.exec('reset role') }
  })
})
