import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
import { createClient } from '@supabase/supabase-js'
import { createSocialApiHandler } from '../../functions/social-api/handler.ts'
import { postColumns } from '../../functions/social-api/modules/posts/post-mapper.ts'

export const a = '00000000-0000-4000-8000-000000000001'
export const b = '00000000-0000-4000-8000-000000000002'
export const cursorSecret = 'offline_only_cursor_signing_key_not_a_real_secret_1234567890'
export const userEmail = 'offline.student@ou.edu.vn'
export const serverKey = 'offline-service-key-must-not-leak'
export const publicKeys = ['authorLabel','body','commentCount','contactUrl','displayMode','hasUpvoted','id','images','isMine','publishedAt','tag','upvoteCount']
const origin = 'http://localhost:5173'
const token = (id: string) => `eyJhbGciOiJFUzI1NiJ9.${btoa(id)}.offline`

// Dịch duy nhất query PostgREST của action thành SQL có tham số; mọi write chạy thật trên PGlite.
export async function postFixture() {
  const db = new PGlite()
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create role supabase_auth_admin; create schema auth; create table auth.users(id uuid primary key);
    grant usage on schema public to anon, authenticated, service_role;`)
  for (const name of (await readdir(new URL('../../migrations/', import.meta.url))).filter(name => name.endsWith('.sql')).sort()) {
    await db.exec(await readFile(new URL(`../../migrations/${name}`, import.meta.url), 'utf8'))
  }
  await db.query('insert into auth.users(id) values ($1),($2)', [a, b])
  await db.query(`insert into public.profiles(id,nickname) values ($1,'Nickname A'),($2,'Nickname B')`, [a, b])
  await db.exec('set role service_role')
  const state = { now: Date.now(), authError: false, outsideOu: false, unconfirmed: false,
    failTable: '', lostCreate: false, lostComment: false, lostDelete: false, secret: cursorSecret, beforePatch: null as null | (() => Promise<void>), beforeCommentInsert: null as null | (() => Promise<void>), beforeCommentPatch: null as null | (() => Promise<void>), afterCommentRead: null as null | (() => Promise<void>) }
  const votes = { beforeWrite: null as null | (() => Promise<void>), afterWrite: null as null | (() => Promise<void>), lost: false, malformed: false }
  const calls: { method: string; table: string; query: string }[] = []
  const error = () => Response.json({ code: 'XX000', message: `${serverKey} ${userEmail} SQL stack` }, { status: 503 })
  function filter(url: URL, name: string) { return url.searchParams.get(name)?.replace(/^eq\./, '') }
  const fetchMock: typeof fetch = async (input, init) => {
    const url = new URL(String(input))
    assert.equal(url.origin, 'https://offline.example.invalid')
    const headers = new Headers(init?.headers)
    if (url.pathname === '/auth/v1/user') {
      assert.equal(headers.get('apikey'), 'sb_publishable_offline')
      if (state.authError) return error()
      const id = [a, b].find(id => headers.get('authorization') === `Bearer ${token(id)}`)
      return id ? Response.json({ id, email: state.outsideOu ? 'offline@example.invalid' : userEmail,
        email_confirmed_at: state.unconfirmed ? null : '2026-11-01T00:00:00Z',
        user_metadata: { role: 'ADMIN', authorId: a, status: 'ACTIVE' } })
        : Response.json({ code: 'bad_jwt', msg: 'Invalid JWT' }, { status: 401, headers: { 'x-supabase-api-version': '2024-01-01' } })
    }
    assert.equal(headers.get('apikey'), serverKey)
    assert.equal(headers.get('authorization'), `Bearer ${serverKey}`)
    const table = url.pathname.replace('/rest/v1/', '')
    const method = init?.method ?? 'GET'
    calls.push({ method, table, query: url.search })
    if (state.failTable === table) return error()
    if (init?.signal?.aborted) throw new DOMException('Offline timeout', 'AbortError')
    const data = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null
    try {
      if (table === 'profiles') {
        assert.equal(method, 'GET')
        assert.equal(url.searchParams.get('select'), 'nickname,status')
        return Response.json((await db.query('select nickname,status from profiles where id=$1', [filter(url, 'id')])).rows)
      }
      if (table === 'user_roles') {
        assert.equal(method, 'GET')
        return Response.json((await db.query('select role from user_roles where user_id=$1 and role=$2', [filter(url, 'user_id'), filter(url, 'role')])).rows)
      }
      if (table === 'post_votes') {
        if (method === 'POST' || method === 'DELETE') {
          if (votes.beforeWrite) await votes.beforeWrite()
          if (method === 'POST') {
            assert.deepEqual(Object.keys(data!).sort(), ['post_id','user_id'])
            assert.equal(url.searchParams.get('on_conflict'), 'post_id,user_id')
            assert.match(headers.get('prefer') ?? '', /resolution=ignore-duplicates/)
            await db.query('insert into post_votes(post_id,user_id) values($1,$2) on conflict(post_id,user_id) do nothing', [data!.post_id,data!.user_id])
          } else {
            assert.ok(filter(url, 'post_id')); assert.ok(filter(url, 'user_id'))
            await db.query('delete from post_votes where post_id=$1 and user_id=$2', [filter(url,'post_id'),filter(url,'user_id')])
          }
          if (votes.afterWrite) await votes.afterWrite()
          if (votes.lost) { votes.lost = false; return error() }
          return new Response(null, {status: method === 'POST' ? 201 : 204})
        }
        assert.equal(method, 'GET')
        assert.equal(url.searchParams.get('select'), 'post_id')
        const ids = url.searchParams.get('post_id')!.slice(4, -1).split(',')
        return Response.json((await db.query('select post_id from post_votes where user_id=$1 and post_id=any($2::uuid[])', [filter(url, 'user_id'), ids])).rows)
      }
      if (table === 'comments') {
        if (method === 'POST') {
          assert.equal(url.searchParams.get('on_conflict'), 'author_id,idempotency_key')
          assert.match(headers.get('prefer') ?? '', /resolution=ignore-duplicates/)
          assert.deepEqual(Object.keys(data!).sort(), ['author_id','body','idempotency_key','post_id'])
          if (state.beforeCommentInsert) await state.beforeCommentInsert()
          await db.query(`insert into comments(post_id,author_id,body,idempotency_key) values($1,$2,$3,$4) on conflict(author_id,idempotency_key) do nothing`, [data!.post_id,data!.author_id,data!.body,data!.idempotency_key])
          if (state.lostComment) { state.lostComment = false; return error() }
          return new Response(null, { status: 201 })
        }
        if (method === 'PATCH') {
          assert.deepEqual(data, { status: 'DELETED' }); assert.equal(filter(url, 'status'), 'VISIBLE'); assert.ok(filter(url, 'author_id'))
          if (state.beforeCommentPatch) await state.beforeCommentPatch()
          const result = await db.query(`update comments set status='DELETED' where id=$1 and author_id=$2 and status='VISIBLE' returning id`, [filter(url, 'id'),filter(url, 'author_id')])
          if (state.lostDelete) { state.lostDelete = false; return error() }
          return Response.json(result.rows)
        }
        assert.equal(method, 'GET')
        const params: unknown[] = []; const where: string[] = []
        for (const name of ['id','post_id','author_id','idempotency_key','status']) if (filter(url, name)) { params.push(filter(url, name)); where.push(`${name}=$${params.length}`) }
        const upper = url.searchParams.get('created_at')
        if (upper) { assert.match(upper, /^lte\./); params.push(upper.slice(4)); where.push(`created_at<=$${params.length}::timestamptz`) }
        const or = url.searchParams.get('or')
        if (or) {
          const time = /created_at\.gt\.([^,)]+)/.exec(or)![1]; const id = /id\.gt\.([\da-f-]+)/.exec(or)![1]
          assert.equal(or, `(created_at.gt.${time},and(created_at.eq.${time},id.gt.${id}))`)
          params.push(time, id); where.push(`(created_at,id)>($${params.length-1}::timestamptz,$${params.length}::uuid)`)
        }
        const order = url.searchParams.get('order'); if (order) assert.equal(order, 'created_at.asc,id.asc')
        const limit = url.searchParams.get('limit'); if (limit) assert.ok(Number(limit) >= 2 && Number(limit) <= 21)
        const select = url.searchParams.get('select')!
        assert.ok(['id,post_id,author_id,body,status,created_at','id,post_id,status','status'].includes(select))
        const rows = (await db.query<Record<string,unknown>>(`select ${select.replace('created_at','created_at::text')} from comments ${where.length ? 'where '+where.join(' and ') : ''} ${order ? 'order by created_at asc,id asc' : ''} ${limit ? 'limit '+Number(limit) : ''}`, params)).rows
        if (state.afterCommentRead) { const hook = state.afterCommentRead; state.afterCommentRead = null; await hook() }
        return Response.json(rows.map(row => row.created_at ? { ...row, created_at: iso(row.created_at as string).replace(/Z$/, '+00:00') } : row))
      }
      assert.equal(table, 'posts')
      if (method === 'GET' && url.searchParams.get('select') === 'upvote_count,post_votes(user_id)') {
        assert.equal(filter(url,'status'),'PUBLISHED')
        assert.ok(filter(url,'post_votes.user_id'))
        if (votes.malformed) return Response.json([{upvote_count:-1,post_votes:[]}])
        return Response.json((await db.query(`select p.upvote_count,
          coalesce((select jsonb_agg(jsonb_build_object('user_id',v.user_id)) from post_votes v where v.post_id=p.id and v.user_id=$2),'[]'::jsonb) as post_votes
          from posts p where p.id=$1 and p.status='PUBLISHED'`,[filter(url,'id'),filter(url,'post_votes.user_id')])).rows)
      }
      if (method === 'POST') {
        assert.equal(url.searchParams.get('on_conflict'), 'author_id,idempotency_key')
        assert.match(headers.get('prefer') ?? '', /resolution=ignore-duplicates/)
        assert.deepEqual(Object.keys(data!).sort(), ['author_id','body','contact_url','display_mode','idempotency_key','nickname_snapshot','tag'])
        await db.query(`insert into posts(author_id,body,tag,display_mode,nickname_snapshot,contact_url,idempotency_key)
          values($1,$2,$3,$4,$5,$6,$7) on conflict(author_id,idempotency_key) do nothing`,
          [data!.author_id,data!.body,data!.tag,data!.display_mode,data!.nickname_snapshot,data!.contact_url,data!.idempotency_key])
        if (state.lostCreate) { state.lostCreate = false; return error() }
        return new Response(null, { status: 201 })
      }
      const columns = `p.id,p.author_id,p.tag,p.body,p.display_mode,p.nickname_snapshot,p.contact_url,p.status,
        p.published_at::text,p.upvote_count,p.comment_count,
        jsonb_build_array(jsonb_build_object('count',(select count(*) from post_images where post_id=p.id))) as post_images`
      if (method === 'PATCH') {
        assert.deepEqual(data, { status: 'PUBLISHED' })
        assert.equal(filter(url, 'status'), 'DRAFT')
        assert.ok(filter(url, 'author_id'))
        assert.equal(url.searchParams.get('select'), postColumns)
        if (state.beforePatch) await state.beforePatch()
        const result = await db.query<Record<string,unknown>>(`with p as (update posts set status='PUBLISHED'
          where id=$1 and author_id=$2 and status='DRAFT' returning *) select ${columns} from p`, [filter(url, 'id'),filter(url, 'author_id')])
        // PostgreSQL ::text dùng dấu cách; PostgREST dùng ISO 8601 và giữ microseconds.
        return Response.json(result.rows.map(row => ({ ...row, published_at: iso(row.published_at as string) })))
      }
      assert.equal(method, 'GET')
      const params: unknown[] = []
      const where: string[] = []
      const add = (sql: string, value: unknown) => { params.push(value); where.push(sql.replace('?', `$${params.length}`)) }
      for (const name of ['id','author_id','idempotency_key','status','tag']) if (filter(url, name)) add(`p.${name}=?`, filter(url, name))
      for (const value of url.searchParams.getAll('published_at')) {
        assert.match(value, /^(lte|gte)\./)
        add(`p.published_at${value.startsWith('lte.') ? '<=' : '>='}?::timestamptz`, value.slice(4))
      }
      const or = url.searchParams.get('or')
      if (or) {
        const time = /published_at\.lt\.([^,)]+)/.exec(or)![1]
        const id = /id\.lt\.([\da-f-]+)/.exec(or)![1]
        const count = /upvote_count\.lt\.(\d+)/.exec(or)?.[1]
        const expected = count === undefined
          ? `(published_at.lt.${time},and(published_at.eq.${time},id.lt.${id}))`
          : `(upvote_count.lt.${count},and(upvote_count.eq.${count},published_at.lt.${time}),and(upvote_count.eq.${count},published_at.eq.${time},id.lt.${id}))`
        assert.equal(or, expected)
        const offset = params.length
        if (count !== undefined) params.push(Number(count))
        params.push(time, id)
        where.push(count === undefined ? `(p.published_at,p.id)<($${offset+1}::timestamptz,$${offset+2}::uuid)`
          : `(p.upvote_count,p.published_at,p.id)<($${offset+1}::integer,$${offset+2}::timestamptz,$${offset+3}::uuid)`)
      }
      const select = url.searchParams.get('select')
      assert.ok(select === postColumns || select === 'id,body,tag,display_mode,contact_url' || select === 'id,author_id')
      const order = url.searchParams.get('order')
      if (order) assert.ok(['published_at.desc,id.desc','upvote_count.desc,published_at.desc,id.desc'].includes(order))
      const limit = url.searchParams.get('limit')
      if (limit) assert.ok(Number.isInteger(Number(limit)) && Number(limit) >= 2 && Number(limit) <= 21)
      const result = await db.query<Record<string,unknown>>(`select ${select === postColumns ? columns : select === 'id,author_id' ? 'p.id,p.author_id' : 'p.id,p.body,p.tag,p.display_mode,p.contact_url'} from posts p
        ${where.length ? `where ${where.join(' and ')}` : ''}
        ${order ? `order by ${order.split(',').map(value => 'p.'+value.replace('.', ' ')).join(',')}` : ''} ${limit ? `limit ${Number(limit)}` : ''}`, params)
      return Response.json(result.rows.map(row => row.published_at ? { ...row, published_at: iso(row.published_at as string) } : row))
    } catch (cause) {
      if (cause instanceof assert.AssertionError) throw cause
      const code = (cause as { code?: string }).code
      if (!code) throw cause
      return Response.json({ code, message: 'offline SQL detail must never escape' }, { status: code === '42501' ? 403 : 400 })
    }
  }
  const client = (key: string) => createClient('https://offline.example.invalid', key, {
    global: { fetch: fetchMock }, auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  })
  const handler = createSocialApiHandler({ createAuthClient: () => client('sb_publishable_offline'),
    createAdminClient: () => client(serverKey), allowedOrigins: [origin], readCursorSecret: () => state.secret, now: () => state.now })
  return {
    db, state, calls, votes, handler,
    request(action: string, payload: unknown, caller: string | null = a, extra: Record<string,string> = {}, signal?: AbortSignal) {
      return new Request('https://offline.example.invalid/functions/v1/social-api', { method: 'POST',
        headers: { 'content-type':'application/json', origin, ...(caller ? { authorization:`Bearer ${token(caller)}` } : {}), ...extra },
        body: JSON.stringify({ action, payload }), signal })
    },
    async reset() {
      await db.exec(`delete from comments; delete from post_votes; delete from post_images; delete from posts; delete from user_roles;
        update profiles set status='ACTIVE',nickname=case when id='${a}' then 'Nickname A' else 'Nickname B' end;`)
      Object.assign(state, { now: Date.now(), authError:false, outsideOu:false, unconfirmed:false, failTable:'', lostCreate:false, lostComment:false, lostDelete:false, secret:cursorSecret, beforePatch:null, beforeCommentInsert:null, beforeCommentPatch:null, afterCommentRead:null })
      calls.length = 0
      Object.assign(votes, {beforeWrite:null,afterWrite:null,lost:false,malformed:false})
    },
    async seed(values: { author?: string; status?: string; mode?: string; tag?: string; count?: number; time?: string; id?: string } = {}) {
      const id = values.id ?? randomUUID()
      await db.query(`insert into posts(id,author_id,body,tag,display_mode,nickname_snapshot,status,published_at,upvote_count,idempotency_key)
        values($1,$2,'Nội dung offline',$3,$4,$5,$6,$7,$8,$9)`, [id,values.author??a,values.tag??'CONFESSION',values.mode??'ANONYMOUS',
          values.mode === 'NICKNAME' ? 'Snapshot thật' : null,values.status??'PUBLISHED',values.status === 'DRAFT' ? null : values.time??new Date(state.now-1000).toISOString(),values.count??0,randomUUID()])
      return id
    },
  }
}
function iso(value: string) { return value.replace(' ', 'T').replace(/\+00$/, 'Z') }
