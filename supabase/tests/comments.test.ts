import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { a, b, cursorSecret, postFixture, serverKey, userEmail } from './helpers/post-fixture.ts'
import { encodeCommentCursor } from '../functions/social-api/modules/comments/comment-cursor.ts'
import { encodeCursor } from '../functions/social-api/modules/posts/post-cursor.ts'
import { signCursor } from '../functions/social-api/shared/cursor.ts'

async function ok(response: Response) { assert.equal(response.status,200); const body=await response.json(); assert.equal(body.error,null); return body.data }
async function denied(response: Response, status: number, code: string) {
  assert.equal(response.status,status); const body=await response.json(); assert.equal(body.data,null); assert.equal(body.error.code,code); assert.equal(body.error.details,null)
  for(const value of [a,b,serverKey,userEmail,'author_id','SQL','stack']) assert.equal(JSON.stringify(body).includes(value),false)
}
const keys=['authorLabel','body','createdAt','id','isMine','isOriginalPoster','postId']
test('T08 comments HTTP + SDK + PGlite — không phải Cloud concurrency', async t => {
  const f=await postFixture(); t.after(()=>f.db.close()); t.beforeEach(()=>f.reset())
  const invoke=(action:string,payload:unknown,caller:string|null=a)=>f.handler(f.request(action,payload,caller))
  const create=(postId:string,caller=a,body='Bình luận offline 👋',idempotencyKey=randomUUID())=>invoke('createComment',{postId,body,idempotencyKey},caller)
  const list=(postId:string,caller=a,cursor:string|null=null,limit=20)=>invoke('listComments',{postId,cursor,limit},caller)
  const count=async(postId:string)=>(await f.db.query<{n:number}>('select comment_count as n from posts where id=$1',[postId])).rows[0].n
  await t.test('validation body 0/1/500/501, surrogate/NUL, UUID và field thừa',async()=>{
    const p=await f.seed()
    for(const body of ['', '  ', '👋'.repeat(501), 'x\u0000y','x\uD800y','x\uDC00y']) await denied(await create(p,a,body),400,'VALIDATION_ERROR')
    for(const body of ['👋','👋'.repeat(500)]) assert.equal((await ok(await create(p,a,` ${body} `))).body,body)
    for(const changes of [{postId:'bad'},{idempotencyKey:'bad'},{body:null},{authorId:b},{userId:b},{role:'ADMIN'},{status:'VISIBLE'},{createdAt:'2026-01-01'}])
      await denied(await invoke('createComment',{postId:p,body:'offline',idempotencyKey:randomUUID(),...changes}),400,'VALIDATION_ERROR')
    for(const changes of [{limit:0},{limit:21},{limit:1.5},{cursor:''},{cursor:'x'.repeat(1025)},{authorId:a}]) await denied(await invoke('listComments',{postId:p,cursor:null,limit:20,...changes}),400,'VALIDATION_ERROR')
    await denied(await invoke('deleteComment',{commentId:randomUUID(),authorId:a}),400,'VALIDATION_ERROR')
    await denied(await f.handler(new Request(f.request('getMe',{}),{body:JSON.stringify({action:{toString:'bad'},payload:{}})})),400,'VALIDATION_ERROR')
  })
  await t.test('Auth/JWT, domain/confirmed/BANNED không bypass dù metadata ADMIN',async()=>{
    const p=await f.seed()
    for(const action of ['listComments','createComment','deleteComment']) {
      const payload=action==='listComments'?{postId:p,cursor:null,limit:20}:action==='createComment'?{postId:p,body:'offline',idempotencyKey:randomUUID()}:{commentId:randomUUID()}
      for(const caller of [null,randomUUID()]) await denied(await invoke(action,payload,caller),401,'UNAUTHENTICATED')
      for(const flag of ['outsideOu','unconfirmed'] as const) { f.state[flag]=true; await denied(await invoke(action,payload),403,'FORBIDDEN'); f.state[flag]=false }
    }
    await f.db.query("update profiles set status='BANNED' where id=$1",[a]); await denied(await create(p),403,'FORBIDDEN'); assert.equal(await count(p),0)
  })
  await t.test('parent missing/DRAFT/HIDDEN/DELETED chặn đọc/ghi, kể cả ADMIN; race trước INSERT rollback',async()=>{
    for(const status of ['DRAFT','HIDDEN','DELETED']) {
      const p=await f.seed({status}); await denied(await create(p),404,'NOT_FOUND'); await denied(await list(p),404,'NOT_FOUND'); assert.equal(await count(p),0)
    }
    await denied(await create(randomUUID()),404,'NOT_FOUND'); await denied(await list(randomUUID()),404,'NOT_FOUND')
    const p=await f.seed(); f.state.beforeCommentInsert=async()=>{await f.db.query("update posts set status='HIDDEN' where id=$1",[p])}
    await denied(await create(p),404,'NOT_FOUND'); assert.equal(await count(p),0); assert.equal((await f.db.query('select * from comments where post_id=$1',[p])).rows.length,0)
  })
  await t.test('A/B OP allowlist, isMine theo caller và không có khóa identity xuyên bài',async()=>{
    const p=await f.seed(); const other=await f.seed({mode:'NICKNAME'})
    const op=await ok(await create(p,a)); const guest=await ok(await create(p,b)); const second=await ok(await create(other,b))
    assert.equal(op.authorLabel,'Chủ bài'); assert.equal(op.isOriginalPoster,true); assert.equal(guest.authorLabel,'OUer ẩn danh'); assert.equal(guest.isOriginalPoster,false)
    f.state.now=Date.now()+5000
    for(const caller of [a,b]) {
      const page=await ok(await list(p,caller)); assert.equal(page.items.length,2)
      for(const item of page.items) { assert.deepEqual(Object.keys(item).sort(),keys); assert.equal(item.isMine,item.id===(caller===a?op.id:guest.id)); for(const value of [a,b,userEmail,serverKey,'Nickname A','authorId','status','idempotencyKey']) assert.equal(JSON.stringify(item).includes(value),false) }
    }
    assert.deepEqual(Object.keys(second).sort(),keys); assert.notEqual(guest.id,second.id); assert.equal(second.authorLabel,'OUer ẩn danh')
  })
  await t.test('concurrent cùng key, conflict body/postId, lost response và retry đã xóa không phục hồi/count drift',async()=>{
    const p=await f.seed(); const q=await f.seed(); const key=randomUUID()
    const responses=await Promise.all([create(p,a,'giống nhau',key),create(p,a,'giống nhau',key)])
    const first=await ok(responses[0]); assert.deepEqual(await ok(responses[1]),first); assert.equal(await count(p),1)
    await denied(await create(p,a,'khác',key),409,'CONFLICT'); await denied(await create(q,a,'giống nhau',key),409,'CONFLICT')
    const lost=randomUUID(); f.state.lostComment=true; await denied(await create(p,b,'mất phản hồi',lost),500,'INTERNAL_ERROR')
    await ok(await create(p,b,'mất phản hồi',lost)); assert.equal(await count(p),2)
    await ok(await invoke('deleteComment',{commentId:first.id})); await denied(await create(p,a,'giống nhau',key),409,'CONFLICT'); assert.equal(await count(p),1)
    assert.equal((await f.db.query<{status:string}>('select status from comments where id=$1',[first.id])).rows[0].status,'DELETED')
  })
  await t.test('delete đúng owner/status, retry/lost response, không ghi đè HIDDEN hoặc ADMIN bypass',async()=>{
    const p=await f.seed(); const c=await ok(await create(p));
    await f.db.query('insert into user_roles(user_id,role,granted_by) values($1,$2,$3)',[b,'ADMIN',a])
    await denied(await invoke('deleteComment',{commentId:c.id},b),404,'NOT_FOUND'); await denied(await invoke('deleteComment',{commentId:randomUUID()}),404,'NOT_FOUND')
    f.state.lostDelete=true; await denied(await invoke('deleteComment',{commentId:c.id}),500,'INTERNAL_ERROR'); assert.equal(await count(p),0)
    await ok(await invoke('deleteComment',{commentId:c.id})); assert.equal(await count(p),0)
    const concurrent=await ok(await create(p))
    await Promise.all((await Promise.all([invoke('deleteComment',{commentId:concurrent.id}),invoke('deleteComment',{commentId:concurrent.id})])).map(ok)); assert.equal(await count(p),0)
    const hidden=await ok(await create(p)); await f.db.query("update comments set status='HIDDEN' where id=$1",[hidden.id]);
    await denied(await invoke('deleteComment',{commentId:hidden.id}),404,'NOT_FOUND'); assert.equal(await count(p),0)
    const race=await ok(await create(p)); f.state.beforeCommentPatch=async()=>{await f.db.query("update comments set status='HIDDEN' where id=$1",[race.id])}
    await denied(await invoke('deleteComment',{commentId:race.id}),404,'NOT_FOUND'); assert.equal(await count(p),0)
  })
  await t.test('atomic counts khác key/concurrent deletes/status lifecycle/physical cleanup và rollback',async()=>{
    const p=await f.seed(); const created=await Promise.all(Array.from({length:10},()=>create(p)))
    const comments=await Promise.all(created.map(ok)); assert.equal(await count(p),10)
    await Promise.all(comments.slice(0,2).map(c=>invoke('deleteComment',{commentId:c.id}))); assert.equal(await count(p),8)
    await f.db.query("update comments set status='HIDDEN' where id=$1",[comments[2].id]); assert.equal(await count(p),7)
    await f.db.query("update comments set status='VISIBLE' where id=$1",[comments[2].id]); assert.equal(await count(p),8)
    await f.db.query("update comments set status='HIDDEN' where id=$1",[comments[2].id]); assert.equal(await count(p),7)
    await f.db.query("update comments set status='DELETED' where id=$1",[comments[2].id]); assert.equal(await count(p),7)
    await assert.rejects(f.db.query("update comments set status='VISIBLE' where id=$1",[comments[2].id])); assert.equal(await count(p),7)
    await f.db.exec('begin'); await f.db.query("update comments set status='DELETED' where id=$1",[comments[3].id]); await f.db.exec('rollback'); assert.equal(await count(p),7)
    await f.db.exec('begin'); await create(p); await f.db.exec('rollback'); assert.equal(await count(p),7)
    await f.db.query('update posts set comment_count=0 where id=$1',[p])
    await assert.rejects(f.db.query("update comments set status='DELETED' where id=$1",[comments[3].id]))
    assert.equal(await count(p),0)
    assert.equal((await f.db.query<{status:string}>('select status from comments where id=$1',[comments[3].id])).rows[0].status,'VISIBLE')
    await f.db.query('update posts set comment_count=7 where id=$1',[p])
    await f.db.query('delete from comments where post_id=$1',[p]); assert.equal(await count(p),0)
  })
  await t.test('pagination ASC microseconds/ties, hidden/deleted lọc, cursor signed/postId/TTL và trang cuối',async()=>{
    const p=await f.seed(); const rows=[]
    for(let i=0;i<7;i++) {
      const id=`10000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`
      await f.db.query(`insert into comments(id,post_id,author_id,body,idempotency_key,created_at) values($1,$2,$3,'offline',$4,$5)`,[id,p,a,randomUUID(),`2026-11-16T12:00:00.${i<3?'123456':'123789'}Z`]); rows.push(id)
    }
    await f.db.query("update comments set status='HIDDEN' where id=$1",[rows[1]]); await f.db.query("update comments set status='DELETED' where id=$1",[rows[4]])
    const seen=[]; let cursor:string|null=null
    do { const page=await ok(await list(p,b,cursor,2)); seen.push(...page.items.map((c:{id:string})=>c.id)); cursor=page.nextCursor; if(cursor) { assert.equal(JSON.stringify(JSON.parse(atob(cursor.split('.')[0].replace(/-/g,'+').replace(/_/g,'/')))).includes(a),false) } } while(cursor)
    assert.deepEqual(seen,rows.filter((_,i)=>![1,4].includes(i)))
    const first=await ok(await list(p,b,null,1)); const q=await f.seed(); await denied(await list(q,b,first.nextCursor),400,'VALIDATION_ERROR')
    for(const value of ['bad',first.nextCursor+'x',await signCursor({v:1,kind:'comments',postId:p,asOf:f.state.now,createdAt:'not-date',id:rows[0]},cursorSecret),await encodeCommentCursor({postId:p,asOf:f.state.now-900001,createdAt:'2026-11-16T12:00:00.123456Z',id:rows[0]},cursorSecret),await encodeCursor({sort:'NEW',tag:null,asOf:f.state.now,publishedAt:'2026-11-16T12:00:00Z',id:p,upvoteCount:0},cursorSecret)]) await denied(await list(p,a,value),400,'VALIDATION_ERROR')
    const empty=await f.seed(); assert.deepEqual(await ok(await list(empty)),{items:[],nextCursor:null})
    f.state.now+=900001; await denied(await list(p,b,first.nextCursor),400,'VALIDATION_ERROR')
  })
  await t.test('parent đổi trạng thái khi đang đọc không trả comments; DB/Auth failure an toàn',async()=>{
    let p=await f.seed(); await ok(await create(p)); f.state.afterCommentRead=async()=>{await f.db.query("update posts set status='HIDDEN' where id=$1",[p])}
    await denied(await list(p),404,'NOT_FOUND')
    p=await f.seed() // T11 không hỗ trợ restore HIDDEN; dùng parent mới để thử lỗi hạ tầng.
    for(const table of ['comments','posts']) { f.state.failTable=table; await denied(await list(p),500,'INTERNAL_ERROR') }; f.state.failTable=''
    f.state.authError=true; await denied(await list(p),500,'INTERNAL_ERROR')
  })
})

test('T08 migration backfill chỉ sửa count lệch, ACL invoker và catalog không mở client',async t=>{
  const db=new PGlite(); t.after(()=>db.close())
  await db.exec('create role anon; create role authenticated; create role service_role bypassrls; create role supabase_auth_admin; create schema auth; create table auth.users(id uuid primary key)')
  for(const name of ['20261113170214_t02_schema_security.sql','20261115050213_t03_before_user_created_hook.sql','20261116141312_t06_atomic_post_publish.sql']) await db.exec(await readFile(new URL(`../migrations/${name}`,import.meta.url),'utf8'))
  const p=randomUUID(); const untouched=randomUUID()
  await db.query('insert into auth.users(id) values($1)',[a]); await db.query("insert into profiles(id,nickname) values($1,'Offline')",[a])
  await db.query(`insert into posts(id,author_id,tag,body,idempotency_key,status,published_at,comment_count) values($1,$3,'CONFESSION','offline',$4,'PUBLISHED',now(),99),($2,$3,'CONFESSION','offline',$5,'PUBLISHED',now(),0)`,[p,untouched,a,randomUUID(),randomUUID()])
  await db.query("insert into comments(post_id,author_id,body,idempotency_key) values($1,$2,'visible',$3)",[p,a,randomUUID()])
  const before=(await db.query('select updated_at::text from posts where id=$1',[untouched])).rows
  await db.exec(await readFile(new URL('../migrations/20261117024216_t08_atomic_comments.sql',import.meta.url),'utf8'))
  assert.equal((await db.query<{comment_count:number}>('select comment_count from posts where id=$1',[p])).rows[0].comment_count,1)
  assert.deepEqual((await db.query('select updated_at::text from posts where id=$1',[untouched])).rows,before)
  for(const role of ['anon','authenticated','supabase_auth_admin']) for(const fn of ['guard_comment_lifecycle','sync_comment_count']) assert.equal((await db.query<{allowed:boolean}>('select has_function_privilege($1,$2,$3) as allowed',[role,`theou_private.${fn}()`,'EXECUTE'])).rows[0].allowed,false)
  await db.exec(await readFile(new URL('./catalog-check.sql',import.meta.url),'utf8'))
})
