import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { test } from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { a, b, postFixture, serverKey, userEmail } from './helpers/post-fixture.ts'

async function ok(response: Response) {
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.error, null)
  assert.deepEqual(Object.keys(body.data).sort(), ['hasUpvoted','upvoteCount'])
  assert.equal(typeof body.data.hasUpvoted, 'boolean')
  assert.ok(Number.isSafeInteger(body.data.upvoteCount) && body.data.upvoteCount >= 0)
  for (const value of [a,b,serverKey,userEmail,'user_id','author_id','metadata']) assert.ok(!JSON.stringify(body).includes(value))
  return body.data as {hasUpvoted:boolean;upvoteCount:number}
}
async function denied(response: Response, status: number, code: string) {
  assert.equal(response.status,status)
  const body=await response.json();assert.equal(body.data,null);assert.equal(body.error.code,code);assert.equal(body.error.details,null)
  for(const value of [a,b,serverKey,userEmail,'SQL','stack','user_id']) assert.ok(!JSON.stringify(body).includes(value))
}
test('T09 HTTP/SDK/SQL local — PGlite không chứng minh contention PostgreSQL Cloud',async t=>{
  const f=await postFixture();t.after(()=>f.db.close());t.beforeEach(()=>f.reset())
  const vote=(postId:string,desiredState:boolean,caller:string|null=a)=>f.handler(f.request('toggleUpvote',{postId,desiredState},caller))
  const invariant=async(postId:string)=>{
    const {rows}=await f.db.query<{upvote_count:number;n:number}>(`select upvote_count,(select count(*)::integer from post_votes where post_id=p.id) as n from posts p where p.id=$1`,[postId])
    assert.equal(rows[0].upvote_count,rows[0].n);return rows[0].n
  }
  await t.test('desiredState idempotent true/true/false/false/true, self vote hợp lệ',async()=>{
    const p=await f.seed()
    for(const desired of [true,true,false,false,true]){
      assert.deepEqual(await ok(await vote(p,desired)),{hasUpvoted:desired,upvoteCount:Number(desired)})
      assert.equal(await invariant(p),Number(desired))
    }
  })
  await t.test('validation boolean thực/UUID/required/extra fields và identity spoof',async()=>{
    const p=await f.seed()
    for(const desiredState of [null,undefined,'true','false',1,0,{},[]])await denied(await f.handler(f.request('toggleUpvote',{postId:p,desiredState})),400,'VALIDATION_ERROR')
    for(const postId of ['',null,'not-uuid'])await denied(await f.handler(f.request('toggleUpvote',{postId,desiredState:true})),400,'VALIDATION_ERROR')
    for(const field of ['userId','authorId','count','status','role','idempotencyKey'])await denied(await f.handler(f.request('toggleUpvote',{postId:p,desiredState:true,[field]:b})),400,'VALIDATION_ERROR')
    assert.equal(await invariant(p),0)
  })
  await t.test('JWT missing/invalid/expired, ngoài OU/unconfirmed/BANNED và metadata giả không bypass',async()=>{
    const p=await f.seed()
    for(const caller of [null,randomUUID()])await denied(await vote(p,true,caller),401,'UNAUTHENTICATED')
    await denied(await f.handler(f.request('toggleUpvote',{postId:p,desiredState:true},a,{authorization:'Bearer expired-offline-jwt'})),401,'UNAUTHENTICATED')
    for(const flag of ['outsideOu','unconfirmed'] as const){f.state[flag]=true;await denied(await vote(p,true),403,'FORBIDDEN');f.state[flag]=false}
    await f.db.query("update profiles set status='BANNED' where id=$1",[a]);await denied(await vote(p,true),403,'FORBIDDEN');assert.equal(await invariant(p),0)
  })
  await t.test('missing/DRAFT/HIDDEN/DELETED trả cùng NOT_FOUND cho cả desiredState, kể cả ADMIN',async()=>{
    await f.db.query("insert into user_roles(user_id,role) values($1,'ADMIN')",[a])
    for(const status of ['DRAFT','HIDDEN','DELETED']){
      const p=await f.seed({status});for(const desired of [true,false])await denied(await vote(p,desired),404,'NOT_FOUND');assert.equal(await invariant(p),0)
    }
    await denied(await vote(randomUUID(),true),404,'NOT_FOUND')
  })
  await t.test('concurrent true/false cùng user và các user khác nhau, PK/count không nhân đôi',async()=>{
    const p=await f.seed()
    for(const desired of [true,false]){
      const results=await Promise.all(Array.from({length:10},()=>vote(p,desired)))
      for(const response of results)await ok(response)
      assert.equal(await invariant(p),Number(desired))
    }
    await Promise.all([vote(p,true,a),vote(p,true,b)]).then(values=>Promise.all(values.map(ok)))
    assert.equal(await invariant(p),2)
    await Promise.all([vote(p,false,a),vote(p,true,b)]).then(values=>Promise.all(values.map(ok)))
    assert.equal(await invariant(p),1)
    await Promise.all([vote(p,true,a),vote(p,false,a),vote(p,true,a)]).then(values=>Promise.all(values.map(ok)))
    assert.ok([1,2].includes(await invariant(p)))
  })
  await t.test('lost ACK insert/delete retry giữ desiredState, không tăng/trừ lần hai',async()=>{
    const p=await f.seed()
    for(const desired of [true,false]){
      f.votes.lost=true;await denied(await vote(p,desired),500,'INTERNAL_ERROR')
      assert.equal(await invariant(p),Number(desired))
      assert.deepEqual(await ok(await vote(p,desired)),{hasUpvoted:desired,upvoteCount:Number(desired)})
    }
  })
  await t.test('parent đổi trạng thái trước INSERT: trigger rollback; replay không trả hidden state',async()=>{
    for(const status of ['HIDDEN','DELETED']){
      const p=await f.seed()
      f.votes.beforeWrite=async()=>{f.votes.beforeWrite=null;await f.db.query('update posts set status=$1 where id=$2',[status,p])}
      await denied(await vote(p,true),404,'NOT_FOUND');assert.equal(await invariant(p),0)
    }
    const p=await f.seed();await ok(await vote(p,true))
    f.votes.beforeWrite=async()=>{f.votes.beforeWrite=null;await f.db.query("update posts set status='HIDDEN' where id=$1",[p])}
    await denied(await vote(p,true),404,'NOT_FOUND');assert.equal(await invariant(p),1)
  })
  await t.test('response đọc trạng thái thực sau mutation, không tự trả desiredState hoặc cached count',async()=>{
    const p=await f.seed()
    f.votes.afterWrite=async()=>{f.votes.afterWrite=null;await f.db.query('delete from post_votes where post_id=$1 and user_id=$2',[p,a])}
    assert.deepEqual(await ok(await vote(p,true)),{hasUpvoted:false,upvoteCount:0});assert.equal(await invariant(p),0)
  })
  await t.test('A/B PostPublic có hasUpvoted riêng, count chung; DTO không identity',async()=>{
    const p=await f.seed();await ok(await vote(p,true))
    for(const action of ['getPost','listPosts'])for(const caller of [a,b]){
      const response=await f.handler(f.request(action,action==='getPost'?{postId:p}:{sort:'NEW',tag:null,cursor:null,limit:20},caller))
      assert.equal(response.status,200);const raw=await response.json();const post=action==='getPost'?raw.data:raw.data.items[0]
      assert.equal(post.hasUpvoted,caller===a);assert.equal(post.upvoteCount,1)
      for(const field of ['user_id','author_id','email','metadata','post_votes'])assert.ok(!JSON.stringify(post).includes(field))
    }
  })
  await t.test('DB/Auth/network/malformed snapshot failures chỉ trả lỗi an toàn',async()=>{
    const p=await f.seed()
    for(const table of ['posts','post_votes']){f.state.failTable=table;await denied(await vote(p,true),500,'INTERNAL_ERROR');f.state.failTable=''}
    f.state.authError=true;await denied(await vote(p,true),500,'INTERNAL_ERROR');f.state.authError=false
    f.votes.malformed=true;await denied(await vote(p,true),500,'INTERNAL_ERROR');f.votes.malformed=false
    await denied(await f.handler(f.request('toggleUpvote',{postId:p,desiredState:true},a,{},AbortSignal.abort())),500,'INTERNAL_ERROR')
    assert.equal(await invariant(p),0)
  })
  await t.test('trigger error sau tăng count rollback cả vote/count; transaction rollback và CHECK không âm',async()=>{
    const p=await f.seed()
    await f.db.exec(`reset role;create function theou_private.test_vote_abort() returns trigger language plpgsql as $$begin raise exception 'offline abort';end;$$;
      create trigger zz_vote_abort after insert on post_votes for each row execute function theou_private.test_vote_abort();set role service_role;`)
    await denied(await vote(p,true),500,'INTERNAL_ERROR');assert.equal(await invariant(p),0)
    await f.db.exec('reset role;drop trigger zz_vote_abort on post_votes;drop function theou_private.test_vote_abort();set role service_role;')
    await f.db.exec('begin');await f.db.query('insert into post_votes(post_id,user_id) values($1,$2)',[p,a]);await f.db.exec('rollback');assert.equal(await invariant(p),0)
    await ok(await vote(p,true));await f.db.query('update posts set upvote_count=0 where id=$1',[p])
    await denied(await vote(p,false),500,'INTERNAL_ERROR')
    assert.equal((await f.db.query('select 1 from post_votes where post_id=$1',[p])).rows.length,1)
    await f.db.query('update posts set upvote_count=1 where id=$1',[p]);assert.equal(await invariant(p),1)
  })
  await t.test('client deny table/function; service_role helper invoker/search_path và không RPC public',async()=>{
    const p=await f.seed()
    const {rows}=await f.db.query<{prosecdef:boolean;proconfig:string[]}>(`select prosecdef,proconfig from pg_proc where oid='theou_private.sync_upvote_count()'::regprocedure`)
    assert.equal(rows[0].prosecdef,false);assert.deepEqual(rows[0].proconfig,['search_path=""'])
    for(const role of ['anon','authenticated']){
      await f.db.exec(`reset role;set role ${role}`)
      for(const sql of ['select * from post_votes',`insert into post_votes(post_id,user_id) values('${p}','${a}')`,'delete from post_votes','select theou_private.sync_upvote_count()'])await assert.rejects(f.db.exec(sql),error=>(error as {code:string}).code==='42501')
    }
    await f.db.exec('reset role;set role service_role');assert.equal(await invariant(p),0)
  })
})

test('T09 migration backfill chỉ sửa count lệch, giữ dữ liệu/ACL/migrations cũ',async t=>{
  const db=new PGlite();t.after(()=>db.close())
  await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create role supabase_auth_admin;create schema auth;create table auth.users(id uuid primary key);')
  const names=(await readdir(new URL('../migrations/',import.meta.url))).filter(n=>n.endsWith('.sql')).sort()
  const migration=names.find(n=>n.endsWith('_t09_atomic_upvotes.sql'))!
  for(const name of names.filter(n=>n!==migration))await db.exec(await readFile(new URL(`../migrations/${name}`,import.meta.url),'utf8'))
  const p=randomUUID(),q=randomUUID()
  await db.query('insert into auth.users(id) values($1)',[a])
  await db.query("insert into profiles(id,nickname) values($1,'Offline')",[a])
  for(const id of [p,q])await db.query("insert into posts(id,author_id,body,tag,idempotency_key,status,published_at) values($1,$2,'offline','CONFESSION',$3,'PUBLISHED',now())",[id,a,randomUUID()])
  await db.query('insert into post_votes(post_id,user_id) values($1,$2)',[p,a])
  await db.query("update posts set updated_at='2020-01-01' where id=$1",[q])
  const before=(await db.query('select to_jsonb(p) as row from posts p where id=$1',[q])).rows
  await db.exec(await readFile(new URL(`../migrations/${migration}`,import.meta.url),'utf8'))
  assert.equal((await db.query<{n:number}>('select upvote_count as n from posts where id=$1',[p])).rows[0].n,1)
  assert.deepEqual((await db.query('select to_jsonb(p) as row from posts p where id=$1',[q])).rows,before)
  assert.equal((await db.query('select * from post_votes')).rows.length,1)
})
