import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { test } from 'node:test'
import { PGlite } from '@electric-sql/pglite'

const tables = ['profiles', 'user_roles', 'posts', 'comments', 'post_votes', 'post_images',
  'reports', 'moderation_actions', 'rate_limit_counters']

test('migration trên PostgreSQL tạm — không phải Supabase Cloud', async (t) => {
  const db = new PGlite()
  t.after(() => db.close())
  // Chỉ mô phỏng các role và FK Auth để kiểm tra SQL; không mô phỏng đăng nhập Supabase.
  await db.exec(`
    create role anon;
    create role authenticated;
    create role service_role bypassrls;
    create role supabase_auth_admin;
    create schema auth;
    create table auth.users (id uuid primary key);
    grant usage on schema public to anon, authenticated, service_role;
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
    alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
    create role other_creator;
    create schema privilege_fixture;
    grant usage on schema privilege_fixture to anon, authenticated, service_role;
    grant usage, create on schema privilege_fixture to other_creator;
    create function privilege_fixture.existing() returns integer language sql as 'select 1';
  `)
  const existingFunctionAcl = (await db.query(`select proacl::text as acl from pg_proc
    where oid = 'privilege_fixture.existing()'::regprocedure`)).rows
  for (const filename of (await readdir(new URL('../migrations/', import.meta.url))).filter(f => f.endsWith('.sql')).sort()) {
    await db.exec(await readFile(new URL(`../migrations/${filename}`, import.meta.url), 'utf8'))
  }
  const a = randomUUID()
  const b = randomUUID()
  const post = randomUUID()
  const comment = randomUUID()
  const key = randomUUID()
  await db.query('insert into auth.users (id) values ($1), ($2)', [a, b])
  await db.query(`insert into public.profiles (id, nickname) values ($1, 'Test-A'), ($2, 'Test-B')`, [a, b])
  await db.query(`insert into public.posts (id, author_id, tag, body, idempotency_key)
    values ($1, $2, 'CONFESSION', 'Nội dung giả để kiểm thử', $3)`, [post, a, key])
  await db.query(`update public.posts set status='PUBLISHED' where id=$1`, [post])
  await db.query(`insert into public.comments (id, post_id, author_id, body, idempotency_key)
    values ($1, $2, $3, 'Bình luận thử', $4)`, [comment, post, a, randomUUID()])

  async function reject(sql: string, params: unknown[], code: string) {
    await assert.rejects(db.query(sql, params), (error: unknown) => {
      assert.equal((error as { code: string }).code, code)
      return true
    })
  }

  await t.test('9 bảng bật ENABLE/FORCE RLS, không có public view hoặc RPC', async () => {
    await db.exec(await readFile(new URL('./catalog-check.sql', import.meta.url), 'utf8'))
    const { rows } = await db.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `select relname, relrowsecurity, relforcerowsecurity from pg_class
       where relnamespace = 'public'::regnamespace and relkind = 'r' order by relname`)
    assert.deepEqual(rows.map(r => r.relname), [...tables].sort())
    assert.ok(rows.every(r => r.relrowsecurity && r.relforcerowsecurity))
    assert.equal((await db.query(`select 1 from pg_class where relnamespace = 'public'::regnamespace and relkind in ('v', 'm')`)).rows.length, 0)
    assert.equal((await db.query(`select 1 from pg_proc where pronamespace = 'public'::regnamespace`)).rows.length, 0)
    assert.equal((await db.query(`select 1 from pg_proc where pronamespace = 'theou_private'::regnamespace and prosecdef`)).rows.length, 0)
  })

  await t.test('CF-01: chấp nhận đúng event trigger đã review, từ chối drift và public RPC/view khác', async () => {
    const fixture = (await readFile(new URL('./fixtures/rls-auto-enable.sql', import.meta.url), 'utf8')).replace(/\r\n/g, '\n')
    const catalog = await readFile(new URL('./catalog-check.sql', import.meta.url), 'utf8')
    await db.exec('begin')
    try {
      await db.exec(fixture)
      await db.exec(catalog)
      const mutations = [
        'alter function public.rls_auto_enable() owner to other_creator',
        'alter function public.rls_auto_enable() security invoker',
        'alter function public.rls_auto_enable() reset all',
        'alter function public.rls_auto_enable() set search_path = public',
        'alter event trigger ensure_rls disable',
        'alter event trigger ensure_rls rename to unexpected_binding',
        'drop event trigger ensure_rls',
        `create or replace function public.rls_auto_enable() returns event_trigger language plpgsql security definer set search_path = pg_catalog as 'begin end;'`,
        `create function public.rls_auto_enable(integer) returns integer language sql as 'select 1'`,
        `create function public.unreviewed_rpc() returns integer language sql security definer as 'select 1'`,
        'create view public.unreviewed_view as select id, author_id from public.posts',
        `drop event trigger ensure_rls; drop function public.rls_auto_enable(); create function public.rls_auto_enable() returns integer language sql as 'select 1'`,
        `drop event trigger ensure_rls; create event trigger ensure_rls on ddl_command_end when tag in ('CREATE TABLE') execute function public.rls_auto_enable()`,
      ]
      for (const sql of mutations) {
        await db.exec('savepoint cf01')
        try {
          await db.exec(sql)
          await assert.rejects(db.exec(catalog), (error: unknown) => {
            assert.equal((error as { code: string }).code, 'P0001')
            assert.match((error as Error).message, /public view\/function/)
            return true
          })
        } finally { await db.exec('rollback to savepoint cf01') }
      }
      await db.exec(catalog)
    } finally { await db.exec('rollback') }
  })

  await t.test('mọi CRUD bị chặn với anon/authenticated và không cấp TRUNCATE', async () => {
    for (const role of ['anon', 'authenticated']) {
      for (const table of tables) {
        for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) {
          const result = await db.query<{ allowed: boolean }>(`select has_table_privilege($1, $2, $3) as allowed`, [role, `public.${table}`, privilege])
          assert.equal(result.rows[0].allowed, false, `${role}/${table}/${privilege}`)
        }
        await db.exec(`set role ${role}`)
        try {
          await reject(`select * from public.${table}`, [], '42501')
          await reject(`insert into public.${table} default values`, [], '42501')
          await reject(`delete from public.${table}`, [], '42501')
        } finally { await db.exec('reset role') }
      }
    }
  })

  await t.test('restrictive policy vẫn chặn khi vô tình được grant và policy allow', async () => {
    await db.exec(`begin; grant select, insert, update, delete on public.posts to authenticated;
      create policy accidental_allow on public.posts for all to authenticated using (true) with check (true);
      set local role authenticated;`)
    try {
      assert.equal((await db.query('select * from public.posts')).rows.length, 0)
      assert.equal((await db.query(`update public.posts set body = 'Không được sửa' returning id`)).rows.length, 0)
      assert.equal((await db.query('delete from public.posts returning id')).rows.length, 0)
      await reject(`insert into public.posts (author_id, body, tag, idempotency_key) values ($1, 'Giả mạo', 'CONFESSION', $2)`, [a, randomUUID()], '42501')
    } finally { await db.exec('rollback') }
  })

  await t.test('server CRUD được phép nhưng không đổi chủ sở hữu/định danh', async () => {
    await db.exec('set role service_role')
    try {
      assert.equal((await db.query('select * from public.posts where id = $1', [post])).rows.length, 1)
      await db.query(`update public.posts set status = 'PUBLISHED', published_at = now() where id = $1`, [post])
      await reject('update public.posts set author_id = $1 where id = $2', [b, post], '23514')
      await reject('update public.comments set author_id = $1 where id = $2', [b, comment], '23514')
      await reject('update public.posts set idempotency_key = $1 where id = $2', [randomUUID(), post], '23514')
      await reject('update public.profiles set id = $1 where id = $2', [randomUUID(), a], '23514')
      const id = randomUUID()
      await db.query(`insert into public.posts (id, author_id, body, tag, idempotency_key) values ($1, $2, 'Bài thử để xóa', 'HOI_GAP', $3)`, [id, a, randomUUID()])
      assert.equal((await db.query('delete from public.posts where id = $1 returning id', [id])).rows.length, 1)
    } finally { await db.exec('reset role') }
  })

  await t.test('FK, idempotency và giới hạn nội dung', async () => {
    await reject(`insert into public.posts (author_id, body, tag, idempotency_key) values ($1, 'Trùng', 'CONFESSION', $2)`, [a, key], '23505')
    await reject(`insert into public.posts (author_id, body, tag, idempotency_key) values ($1, 'Sai FK', 'CONFESSION', $2)`, [randomUUID(), randomUUID()], '23503')
    for (const body of ['', '   ', '\t\n', ' chưa trim ']) {
      await reject('update public.posts set body = $1 where id = $2', [body, post], '23514')
    }
    await reject('update public.posts set body = $1 where id = $2', ['a'.repeat(1001), post], '22001')
    await reject('update public.comments set body = $1 where id = $2', ['a'.repeat(501), comment], '22001')
    await reject(`update public.posts set tag = 'UNKNOWN' where id = $1`, [post], '23514')
    await reject('update public.posts set upvote_count = -1 where id = $1', [post], '23514')
    await reject('delete from auth.users where id = $1', [a], '23001')
  })

  await t.test('ẩn danh không lưu nickname/contact; allowlist URL không nhận hostname giả', async () => {
    await reject(`update public.posts set nickname_snapshot = 'Test-A' where id = $1`, [post], '23514')
    await reject(`update public.posts set contact_url = 'https://zalo.me/test' where id = $1`, [post], '23514')
    for (const url of ['https://facebook.com.evil.example/path', 'https://facebook.com@evil.example/path', 'http://zalo.me/test']) {
      await reject(`update public.posts set display_mode = 'NICKNAME', nickname_snapshot = 'Test-A', tag = 'TAI_LIEU', contact_url = $1 where id = $2`, [url, post], '23514')
    }
    await db.query(`update public.posts set display_mode = 'NICKNAME', nickname_snapshot = 'Test-A', tag = 'TAI_LIEU', contact_url = 'https://zalo.me/test' where id = $1`, [post])
    await db.query(`update public.posts set display_mode = 'ANONYMOUS', nickname_snapshot = null, contact_url = null where id = $1`, [post])
  })

  await t.test('vote duy nhất và bất biến user_id', async () => {
    await db.query('insert into public.post_votes (post_id, user_id) values ($1, $2)', [post, a])
    await reject('insert into public.post_votes (post_id, user_id) values ($1, $2)', [post, a], '23505')
    await reject('update public.post_votes set user_id = $1 where post_id = $2', [b, post], '23514')
  })

  await t.test('ảnh: giới hạn 2 vị trí, kích thước, MIME và path không chứa user UUID', async () => {
    const post = randomUUID()
    await db.query(`insert into public.posts(id,author_id,body,tag,display_mode,idempotency_key) values($1,$2,'Ảnh local','CONFESSION','ANONYMOUS',$3)`,[post,a,randomUUID()])
    const first = randomUUID()
    const second = randomUUID()
    for (const [id, position] of [[first, 1], [second, 2]] as const) {
      await db.query(`insert into public.post_images (id, post_id, storage_path, mime_type, size_bytes, position)
        values ($1, $2, $3, 'image/webp', 1024, $4)`, [id, post, `posts/${post}/${id}.webp`, position])
    }
    await reject('update public.post_images set position = 2 where id = $1', [first], '23514')
    await reject('update public.post_images set position = 3 where id = $1', [first], '23514')
    await reject('update public.post_images set size_bytes = 2097153 where id = $1', [first], '23514')
    await reject(`update public.post_images set mime_type = 'image/gif' where id = $1`, [first], '23514')
    const id = randomUUID()
    await reject(`insert into public.post_images (id, post_id, storage_path, mime_type, size_bytes, position)
      values ($1, $2, $3, 'image/webp', 1024, 1)`, [id, post, `posts/${a}/${id}.webp`], '23514')
  })

  await t.test('report trùng bị chặn, audit chỉ append với service_role, counter không âm', async () => {
    const report = randomUUID()
    await db.query(`insert into public.reports (id, reporter_id, target_type, target_id, reason) values ($1, $2, 'POST', $3, 'SPAM')`, [report, b, post])
    await reject(`insert into public.reports (reporter_id, target_type, target_id, reason) values ($1, 'POST', $2, 'SPAM')`, [b, post], '23505')
    await reject(`update public.reports set status = 'RESOLVED' where id = $1`, [report], '23514')
    await reject('update public.reports set reporter_id = $1 where id = $2', [a, report], '23514')
    await reject(`insert into public.rate_limit_counters (actor_id, action, window_start, count) values ($1, 'createPost', now(), -1)`, [a], '23514')
    await db.exec('set role service_role')
    try {
      const audit = randomUUID()
      await db.query(`insert into public.moderation_actions (id, admin_id, target_type, target_id, action, reason)
        values ($1, $2, 'POST', $3, 'HIDE', 'Kiểm thử SQL')`, [audit, b, post])
      await reject('delete from public.moderation_actions where id = $1', [audit], '42501')
      await reject(`update public.moderation_actions set reason = 'Sửa audit' where id = $1`, [audit], '42501')
    } finally { await db.exec('reset role') }
  })

  await t.test('catalog phát hiện thiếu UPDATE/DELETE trên từng bảng CRUD', async () => {
    const catalog = await readFile(new URL('./catalog-check.sql', import.meta.url), 'utf8')
    for (const table of tables.filter(name => name !== 'moderation_actions')) {
      for (const privilege of ['UPDATE', 'DELETE']) {
        await db.exec(`begin; revoke ${privilege} on public.${table} from service_role;`)
        try {
          await assert.rejects(db.exec(catalog), (error: unknown) => {
            assert.equal((error as { code: string }).code, 'P0001')
            assert.match((error as Error).message, /Thiếu quyền UPDATE\/DELETE server/)
            return true
          })
        } finally { await db.exec('rollback') }
      }
    }
  })

  await t.test('updated_at được cập nhật', async () => {
    await db.query(`update public.profiles set updated_at = '2000-01-01' where id = $1`, [a])
    const { rows } = await db.query<{ fresh: boolean }>(`select updated_at > '2000-01-02'::timestamptz as fresh from public.profiles where id = $1`, [a])
    assert.equal(rows[0].fresh, true)
  })

  await t.test('bảng và sequence tương lai không tự cấp quyền cho client/server/PUBLIC', async () => {
    await db.exec('create table public.future_table (id uuid)')
    await db.exec('create sequence public.future_sequence')
    for (const role of ['anon', 'authenticated', 'service_role']) {
      for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN']) {
        const result = await db.query<{ allowed: boolean }>(`select has_table_privilege($1, 'public.future_table', $2) as allowed`, [role, privilege])
        assert.equal(result.rows[0].allowed, false, `${role}/${privilege}`)
      }
      for (const privilege of ['USAGE', 'SELECT', 'UPDATE']) {
        const result = await db.query<{ allowed: boolean }>(`select has_sequence_privilege($1, 'public.future_sequence', $2) as allowed`, [role, privilege])
        assert.equal(result.rows[0].allowed, false, `${role}/sequence/${privilege}`)
      }
    }
    assert.equal((await db.query(`select 1 from pg_class c,
      lateral aclexplode(coalesce(c.relacl, acldefault(case when c.relkind = 'S' then 's'::"char" else 'r'::"char" end, c.relowner))) a
      where c.oid in ('public.future_table'::regclass, 'public.future_sequence'::regclass) and a.grantee = 0`)).rows.length, 0)
  })

  await t.test('function mới của postgres không có PUBLIC EXECUTE ở public và schema khác', async () => {
    for (const schema of ['public', 'privilege_fixture']) {
      await db.exec(`create function ${schema}.future() returns integer language sql as 'select 1'`)
      assert.equal((await db.query(`select 1 from pg_proc p,
        lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
        where p.oid = $1::regprocedure and a.grantee = 0 and a.privilege_type = 'EXECUTE'`, [`${schema}.future()`])).rows.length, 0)
      await db.exec('set role anon')
      try { await reject(`select ${schema}.future()`, [], '42501') }
      finally { await db.exec('reset role') }
    }
  })

  await t.test('function đã tồn tại giữ quyền EXECUTE', async () => {
    assert.deepEqual((await db.query(`select proacl::text as acl from pg_proc
      where oid = 'privilege_fixture.existing()'::regprocedure`)).rows, existingFunctionAcl)
    await db.exec('set role anon')
    try {
      assert.deepEqual((await db.query('select privilege_fixture.existing() as value')).rows, [{ value: 1 }])
    } finally { await db.exec('reset role') }
  })

  await t.test('function do role khác tạo giữ default privileges riêng', async () => {
    await db.exec('set role other_creator')
    try { await db.exec(`create function privilege_fixture.other_owner() returns integer language sql as 'select 2'`) }
    finally { await db.exec('reset role') }
    await db.exec('set role anon')
    try {
      assert.deepEqual((await db.query('select privilege_fixture.other_owner() as value')).rows, [{ value: 2 }])
    } finally { await db.exec('reset role') }
  })
})
