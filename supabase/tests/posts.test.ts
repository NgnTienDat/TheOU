import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { ApiError } from '../functions/social-api/shared/response.ts'
import { decodeCursor, encodeCursor } from '../functions/social-api/modules/posts/post-cursor.ts'
import { mapPost, type PostRow } from '../functions/social-api/modules/posts/post-mapper.ts'
import { a, b, cursorSecret, postFixture, publicKeys, serverKey, userEmail } from './helpers/post-fixture.ts'

const input = (overrides: Record<string,unknown> = {}) => ({ body:'  Chuyện OU offline 👋  ', tag:'CONFESSION', displayMode:'ANONYMOUS', contactUrl:null, idempotencyKey:randomUUID(), ...overrides })
const listInput = (overrides: Record<string,unknown> = {}) => ({ sort:'NEW',tag:null,cursor:null,limit:20,...overrides })
async function failure(response: Response, status: number, code: string) {
  assert.equal(response.status, status)
  const body = await response.json()
  assert.deepEqual(Object.keys(body).sort(), ['data','error','meta'])
  assert.equal(body.data, null)
  assert.equal(body.error.code, code)
  assert.equal(body.error.details, null)
  for (const value of [a,b,userEmail,serverKey,'author_id','SQL','stack']) assert.equal(JSON.stringify(body).includes(value), false)
}
async function success(response: Response) {
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.error, null)
  assert.match(body.meta.requestId, /^[\da-f-]{36}$/)
  return body.data
}

test('T06 HTTP handler + SDK + PostgreSQL tạm — không phải Supabase Cloud', async t => {
  const f = await postFixture()
  t.after(() => f.db.close())
  t.beforeEach(() => f.reset())
  const invoke = (action: string, payload: unknown, caller: string | null = a) => f.handler(f.request(action,payload,caller))
  const create = async (payload = input(), caller = a) => await success(await invoke('createPost',payload,caller)) as { postId: string; status: string }

  await t.test('create validation Unicode/5 tags/mode/contact và luôn draft, không ghi field của client', async () => {
    for (const tag of ['CONFESSION','REVIEW_MON','TAI_LIEU','TIM_TRO','HOI_GAP']) {
      const created = await create(input({ tag }))
      assert.deepEqual(Object.keys(created).sort(), ['postId','status'])
      assert.equal(created.status, 'DRAFT')
      const row = (await f.db.query<Record<string,unknown>>('select * from posts where id=$1', [created.postId])).rows[0]
      assert.equal(row.body, 'Chuyện OU offline 👋')
      assert.equal(row.nickname_snapshot, null)
      assert.equal(row.contact_url, null)
      assert.equal(row.author_id, a)
      assert.equal(row.status, 'DRAFT')
      assert.equal(row.published_at, null)
    }
    await create(input({ body: '👋'.repeat(1000) }))
    await create(input({ displayMode:'NICKNAME',tag:'TAI_LIEU',contactUrl:'https://FACEBOOK.COM:443/offline?x=1' }))
    for (const host of ['zalo.me','facebook.com','www.facebook.com','m.facebook.com','m.me']) await create(input({ displayMode:'NICKNAME',tag:'TIM_TRO',contactUrl:`https://${host}/offline` }))
  })

  await t.test('idempotency race cùng key/cùng payload và key khác author; payload khác conflict, không overwrite', async () => {
    const payload = input()
    const responses = await Promise.all([invoke('createPost',payload),invoke('createPost',payload)])
    const [first, second] = await Promise.all(responses.map(success))
    assert.deepEqual(first,second)
    assert.equal((await f.db.query<Record<string,unknown>>('select count(*)::integer as n from posts')).rows[0].n, 1)
    for (const changes of [{ body:'Khác' },{ tag:'HOI_GAP' },{ displayMode:'NICKNAME' }]) await failure(await invoke('createPost',{...payload,...changes}),409,'CONFLICT')
    const other = await create(payload,b)
    assert.notEqual(other.postId,first.postId)
    assert.equal((await f.db.query<Record<string,unknown>>('select body from posts where id=$1',[first.postId])).rows[0].body, 'Chuyện OU offline 👋')
    await invoke('publishPost',{postId:first.postId})
    assert.deepEqual(await create(payload),first, 'replay ACK không đổi status bài đã published')
    assert.equal((await f.db.query<Record<string,unknown>>('select status from posts where id=$1',[first.postId])).rows[0].status,'PUBLISHED')
    const race = input()
    const conflicting = await Promise.all([invoke('createPost',race),invoke('createPost',{...race,body:'Request thứ hai'})])
    assert.deepEqual(conflicting.map(response=>response.status).sort(),[200,409])
  })

  await t.test('A/B anonymous privacy: draft không đọc; A/B đọc published đúng isMine, votes từ DB chính chủ', async () => {
    const draft = await create()
    for (const caller of [a,b]) await failure(await invoke('getPost',{postId:draft.postId},caller),404,'NOT_FOUND')
    assert.deepEqual(await success(await invoke('listPosts',listInput(),b)),{items:[],nextCursor:null})
    const published = await success(await invoke('publishPost',{postId:draft.postId}))
    assert.equal(published.isMine,true)
    await f.db.query<Record<string,unknown>>('insert into post_votes(post_id,user_id) values($1,$2)',[draft.postId,b])
    f.state.now += 5000
    for (const caller of [a,b]) {
      const post = await success(await invoke('getPost',{postId:draft.postId},caller))
      assert.deepEqual(Object.keys(post).sort(),publicKeys)
      assert.equal(post.authorLabel,'OUer ẩn danh')
      assert.equal(post.isMine,caller===a)
      assert.equal(post.hasUpvoted,caller===b)
      assert.deepEqual(post.images,[])
      assert.equal(post.contactUrl,null)
      for(const value of [a,b,userEmail,serverKey,'Nickname A','author_id','authorId','idempotency_key','storage_path','user_metadata']) assert.equal(JSON.stringify(post).includes(value),false)
    }
    const feed = await success(await invoke('listPosts',listInput(),b))
    assert.equal(feed.items[0].id,draft.postId)
    assert.equal(feed.items[0].isMine,false)
    const another = await create()
    const second = await success(await invoke('publishPost',{postId:another.postId}))
    assert.equal(second.authorLabel,published.authorLabel)
    assert.notEqual(second.id,published.id)
    assert.deepEqual(Object.keys(second).sort(),publicKeys)
  })

  await t.test('atomic publish, nickname snapshot tại DB và retry/concurrent không đổi thời gian', async () => {
    const draft = await create(input({ displayMode:'NICKNAME' }))
    await f.db.query<Record<string,unknown>>('update profiles set nickname=$1 where id=$2',['Nickname lúc publish',a])
    const result = await Promise.all([invoke('publishPost',{postId:draft.postId}),invoke('publishPost',{postId:draft.postId})])
    const [first,second] = await Promise.all(result.map(success))
    assert.equal(first.authorLabel,'Nickname lúc publish')
    assert.equal(second.publishedAt,first.publishedAt)
    await f.db.query<Record<string,unknown>>('update profiles set nickname=$1 where id=$2',['Nickname sau publish',a])
    const again = await success(await invoke('publishPost',{postId:draft.postId}))
    assert.equal(again.authorLabel,first.authorLabel)
    assert.equal(again.publishedAt,first.publishedAt)
    assert.deepEqual((await f.db.query<Record<string,unknown>>('select nickname_snapshot,status from posts where id=$1',[draft.postId])).rows,
      [{nickname_snapshot:'Nickname lúc publish',status:'PUBLISHED'}])
  })

  await t.test('ownership/status: B không publish A; HIDDEN/DELETED không publish/read; BANNED bị chặn', async () => {
    const draft = await create()
    await failure(await invoke('publishPost',{postId:draft.postId},b),404,'NOT_FOUND')
    await failure(await invoke('publishPost',{postId:randomUUID()}),404,'NOT_FOUND')
    for (const status of ['HIDDEN','DELETED']) {
      const id = await f.seed({status})
      await failure(await invoke('publishPost',{postId:id}),409,'CONFLICT')
      await failure(await invoke('getPost',{postId:id}),404,'NOT_FOUND')
    }
    await f.db.query<Record<string,unknown>>("update profiles set status='BANNED' where id=$1",[a])
    for (const [action,payload] of [['createPost',input()],['publishPost',{postId:draft.postId}],['listPosts',listInput()],['getPost',{postId:draft.postId}]] as const)
      await failure(await invoke(action,payload),403,'FORBIDDEN')
    assert.equal((await f.db.query<Record<string,unknown>>('select status from profiles where id=$1',[a])).rows[0].status,'BANNED')
  })

  await t.test('trigger chặn ban giữa guard/publish, không publish bài có ảnh; helper không mở RPC/client grants', async () => {
    const draft = await create()
    f.state.beforePatch = async () => { await f.db.query<Record<string,unknown>>("update profiles set status='BANNED' where id=$1",[a]) }
    await failure(await invoke('publishPost',{postId:draft.postId}),403,'FORBIDDEN')
    assert.equal((await f.db.query<Record<string,unknown>>('select status from posts where id=$1',[draft.postId])).rows[0].status,'DRAFT')
    f.state.beforePatch = null
    await f.db.query<Record<string,unknown>>("update profiles set status='ACTIVE' where id=$1",[a])
    const image = randomUUID()
    await f.db.query<Record<string,unknown>>(`insert into post_images(id,post_id,storage_path,mime_type,size_bytes,position)
      values($1,$2,$3,'image/png',10,1)`,[image,draft.postId,`posts/${draft.postId}/${image}.png`])
    await failure(await invoke('publishPost',{postId:draft.postId}),409,'CONFLICT')
    await f.db.exec('reset role')
    await f.db.exec(await readFile(new URL('./catalog-check.sql',import.meta.url),'utf8'))
    for (const role of ['anon','authenticated','supabase_auth_admin']) {
      assert.equal((await f.db.query<Record<string,unknown>>('select has_function_privilege($1,$2,\'execute\') as allowed',[role,'theou_private.prepare_post_publish()'])).rows[0].allowed,false)
    }
    for (const role of ['anon','authenticated']) {
      await f.db.exec(`set role ${role}`)
      await assert.rejects(f.db.query<Record<string,unknown>>('select * from posts'),(error:unknown)=>(error as {code:string}).code==='42501')
      await assert.rejects(f.db.query<Record<string,unknown>>('select theou_private.prepare_post_publish()'),(error:unknown)=>(error as {code:string}).code==='42501')
      await f.db.exec('reset role')
    }
    assert.equal((await f.db.query<Record<string,unknown>>("select has_function_privilege('service_role','theou_private.prepare_post_publish()','execute') as allowed")).rows[0].allowed,true)
    assert.equal((await f.db.query<Record<string,unknown>>("select prosecdef,proconfig from pg_proc where oid='theou_private.prepare_post_publish()'::regprocedure")).rows[0].prosecdef,false)
    await f.db.exec('set role service_role')
  })

  await t.test('NEW keyset nhiều trang, tie timestamp/id, tag, empty/final, cursor gắn sort/tag không rò author', async () => {
    const ids = []
    for(let i=0;i<7;i++) ids.push(await f.seed({id:`10000000-0000-4000-8000-${String(i).padStart(12,'0')}`,time:new Date(f.state.now-1000).toISOString(),tag:i===6?'HOI_GAP':'CONFESSION'}))
    await f.seed({status:'DRAFT'}); await f.seed({status:'HIDDEN'}); await f.seed({status:'DELETED'})
    const seen: string[]=[]
    let cursor: string|null=null
    do {
      const page = await success(await invoke('listPosts',listInput({cursor,limit:2}),b))
      assert.ok(page.items.length<=2)
      seen.push(...page.items.map((post:{id:string})=>post.id))
      cursor=page.nextCursor
      if(cursor) {
        const payload=atob(cursor.split('.')[0].replace(/-/g,'+').replace(/_/g,'/'))
        for(const value of [a,b,'author','email','Nickname']) assert.equal(payload.includes(value),false)
        await failure(await invoke('listPosts',listInput({cursor,sort:'HOT'})),400,'VALIDATION_ERROR')
        await failure(await invoke('listPosts',listInput({cursor,tag:'HOI_GAP'})),400,'VALIDATION_ERROR')
      }
    } while(cursor)
    assert.deepEqual(seen,ids.reverse())
    assert.equal(new Set(seen).size,7)
    const tagged=await success(await invoke('listPosts',listInput({tag:'HOI_GAP'})))
    assert.equal(tagged.items.length,1)
    assert.deepEqual(await success(await invoke('listPosts',listInput({tag:'TAI_LIEU'}))),{items:[],nextCursor:null})
    const page=await success(await invoke('listPosts',listInput({limit:1})))
    const tampered=page.nextCursor.slice(0,-3)+'abc'
    await failure(await invoke('listPosts',listInput({cursor:tampered})),400,'VALIDATION_ERROR')
    f.state.now+=901_000
    await failure(await invoke('listPosts',listInput({cursor:page.nextCursor})),400,'VALIDATION_ERROR')
  })

  await t.test('HOT 24h/order/count + microseconds; vote thay đổi có thể lặp, không giả snapshot consistency', async () => {
    const base = new Date(f.state.now-1000).toISOString().slice(0,19)
    const old=await f.seed({time:new Date(f.state.now-86_400_001).toISOString(),count:99})
    const low=await f.seed({time:base+'.123455Z',count:2})
    const high=await f.seed({time:base+'.123456Z',count:2})
    const top=await f.seed({time:new Date(f.state.now-2000).toISOString(),count:3})
    const first=await success(await invoke('listPosts',listInput({sort:'HOT',limit:1})))
    assert.equal(first.items[0].id,top)
    const second=await success(await invoke('listPosts',listInput({sort:'HOT',limit:1,cursor:first.nextCursor})))
    assert.equal(second.items[0].id,high)
    const third=await success(await invoke('listPosts',listInput({sort:'HOT',limit:1,cursor:second.nextCursor})))
    assert.equal(third.items[0].id,low)
    assert.equal(third.nextCursor,null)
    assert.notEqual(third.items[0].id,old)
    await f.db.query<Record<string,unknown>>('update posts set upvote_count=0 where id=$1',[top])
    const changed=await success(await invoke('listPosts',listInput({sort:'HOT',cursor:second.nextCursor})))
    assert.ok(changed.items.some((post:{id:string})=>post.id===top),'bài giảm vote có thể xuất hiện lại sau cursor')
  })

  await t.test('trang tối đa 20; cursor vẫn dùng được khi anchor bị ẩn, không kéo bài mới vào lượt cũ', async () => {
    for(let i=0;i<23;i++) await f.seed({time:new Date(f.state.now-1000-i).toISOString()})
    const first=await success(await invoke('listPosts',listInput()))
    assert.equal(first.items.length,20)
    assert.ok(first.nextCursor)
    await f.db.query<Record<string,unknown>>("update posts set status='HIDDEN' where id=$1",[first.items[19].id])
    const future=await f.seed({time:new Date(f.state.now+1).toISOString()})
    f.state.now+=10
    const next=await success(await invoke('listPosts',listInput({cursor:first.nextCursor})))
    assert.equal(next.items.length,3)
    assert.equal(next.nextCursor,null)
    for(const item of next.items) {
      assert.notEqual(item.id,future)
      assert.equal(first.items.some((seen:{id:string})=>seen.id===item.id),false)
    }
  })

  await t.test('Auth/DB failure và timeout/retry sau server đã insert không rò SQL hoặc tạo trùng', async () => {
    const payload=input()
    f.state.lostCreate=true
    await failure(await invoke('createPost',payload),500,'INTERNAL_ERROR')
    const retry=await create(payload)
    assert.equal((await f.db.query<Record<string,unknown>>('select count(*)::integer n from posts')).rows[0].n,1)
    assert.deepEqual(await create(payload),retry)
    for(const table of ['posts','post_votes']) {
      await invoke('publishPost',{postId:retry.postId})
      f.state.failTable=table
      await failure(await invoke('getPost',{postId:retry.postId}),500,'INTERNAL_ERROR')
      f.state.failTable=''
    }
    f.state.authError=true
    await failure(await invoke('createPost',input()),500,'INTERNAL_ERROR')
    f.state.authError=false
    await failure(await f.handler(f.request('createPost',input(),a,{},AbortSignal.abort())),500,'INTERNAL_ERROR')
    f.state.secret=''
    await failure(await invoke('listPosts',listInput()),500,'INTERNAL_ERROR')
  })

  await t.test('input/JWT giả, metadata ADMIN, oversize/malformed và contact hostname spoof không vượt guard', async () => {
    const invalid=[{body:''},{body:' \n\t '},{body:'a'.repeat(1001)},{body:'x\u0000x'},{body:'\ud800'},
      {tag:'UNKNOWN'},{displayMode:'PUBLIC'},{displayMode:{toString:'NICKNAME'}},{idempotencyKey:'bad'},
      {authorId:b},{userId:b},{nicknameSnapshot:'Nickname bị lộ'},{status:'PUBLISHED'},{upvoteCount:99}]
    for(const value of invalid) await failure(await invoke('createPost',input(value)),400,'VALIDATION_ERROR')
    for(const url of ['http://zalo.me/a','https://facebook.com.evil.invalid/a','https://facebook.com@evil.invalid/a','https://evil.invalid/facebook.com','https://user:pass@facebook.com/a','https://facebook.com:444/a','https://face\nbook.com/a'])
      await failure(await invoke('createPost',input({displayMode:'NICKNAME',tag:'TAI_LIEU',contactUrl:url})),400,'VALIDATION_ERROR')
    await failure(await invoke('createPost',input({contactUrl:'https://zalo.me/a'})),400,'VALIDATION_ERROR')
    await failure(await invoke('createPost',input({displayMode:'NICKNAME',contactUrl:'https://zalo.me/a'})),400,'VALIDATION_ERROR')
    for(const value of [{limit:0},{limit:21},{limit:'20'},{sort:'OLD'},{sort:{toString:'NEW'}},{tag:'bad'},{cursor:'x'.repeat(1025)},{cursor:'not-a-cursor'}])
      await failure(await invoke('listPosts',listInput(value)),400,'VALIDATION_ERROR')
    for(const action of ['createPost','listPosts','publishPost','getPost']) {
      const payload=action==='createPost'?input():action==='listPosts'?listInput():{postId:randomUUID()}
      await failure(await invoke(action,payload,null),401,'UNAUTHENTICATED')
      await failure(await f.handler(f.request(action,payload,a,{authorization:'Bearer invalid.jwt.signature'})),401,'UNAUTHENTICATED')
    }
    for(const property of ['outsideOu','unconfirmed'] as const) {
      f.state[property]=true
      await failure(await invoke('createPost',input()),403,'FORBIDDEN')
      f.state[property]=false
    }
    for(const body of ['{',' '.repeat(16385),JSON.stringify({action:'getMe',payload:{},role:'ADMIN'})])
      await failure(await f.handler(new Request('https://offline.example.invalid',{method:'POST',headers:{'content-type':'application/json'},body})),400,'VALIDATION_ERROR')
    await failure(await invoke('deletePost',{postId:randomUUID()}),400,'VALIDATION_ERROR')
  })
})

test('cursor HMAC: tamper/claims/filter/TTL/length/secret; signed payload không chứa identity', async () => {
  const now=Date.parse('2026-11-16T12:00:00Z')
  const claims={sort:'NEW' as const,tag:null,asOf:now,publishedAt:'2026-11-16T11:59:59.123456Z',id:randomUUID(),upvoteCount:0}
  const input={sort:'NEW' as const,tag:null,cursor:null,limit:20}
  const cursor=await encodeCursor(claims,cursorSecret)
  assert.deepEqual(await decodeCursor(cursor,input,cursorSecret,now),{v:1,...claims})
  for(const value of ['bad','x'.repeat(1025),cursor.slice(0,-1)+'!',cursor.replace(/^./,cursor[0]==='a'?'b':'a')])
    await assert.rejects(decodeCursor(value,input,cursorSecret,now),ApiError)
  await assert.rejects(decodeCursor(cursor,{...input,sort:'HOT'},cursorSecret,now),ApiError)
  await assert.rejects(decodeCursor(cursor,input,cursorSecret,now+901_000),ApiError)
  for(const changes of [{id:a+',status.eq.DRAFT'},{publishedAt:'bad'},{upvoteCount:-1},{asOf:now+61_000},{authorId:a}]) {
    const invalid=await encodeCursor({...claims,...changes},cursorSecret)
    await assert.rejects(decodeCursor(invalid,input,cursorSecret,now),ApiError)
  }
  await assert.rejects(encodeCursor(claims,''),error=>error instanceof ApiError&&error.code==='INTERNAL_ERROR')
})

test('mapper chỉ allowlist, ảnh không có không được giả tạo, snapshot khác profile và private fields không serialize', () => {
  const row: PostRow & Record<string,unknown>={id:randomUUID(),author_id:a,body:'Nội dung',tag:'CONFESSION',display_mode:'ANONYMOUS',
    nickname_snapshot:null,contact_url:null,status:'PUBLISHED',published_at:'2026-11-16T12:00:00.123456+00:00',upvote_count:0,comment_count:0,post_images:[],
    email:userEmail,user_metadata:{secret:serverKey},storage_path:'private/path',created_at:'private'}
  const post=mapPost(row,b,false)
  assert.deepEqual(Object.keys(post).sort(),publicKeys)
  for(const value of [a,userEmail,serverKey,'private/path','author_id','user_metadata']) assert.equal(JSON.stringify(post).includes(value),false)
  assert.equal(post.publishedAt,'2026-11-16T12:00:00.123456Z')
  assert.throws(()=>mapPost({...row,post_images:null as unknown as PostRow['post_images']},b,false),ApiError)
  assert.throws(()=>mapPost({...row,nickname_snapshot:'Bí mật'},b,false),ApiError)
  assert.throws(()=>mapPost({...row,status:'DRAFT'},b,false),ApiError)
  assert.throws(()=>mapPost({...row,upvote_count:-1},b,false),ApiError)
})
