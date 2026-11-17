import assert from 'node:assert/strict'
import { test } from 'node:test'
import { QueryClient, InfiniteQueryObserver, type InfiniteData } from '@tanstack/react-query'
import { createClient } from '@supabase/supabase-js'
import { runUpvote, upvoteKey } from '../src/features/votes/vote-mutation.ts'
import type { Page, PostPublic, UpvoteState } from '../src/shared/api/SocialApiClient.ts'
import { createSocialApi, parseSocialResponse, SocialApiError } from '../src/shared/api/social-api.ts'
import { detailKey } from '../src/features/comments/comment-query.ts'

const id=(n=1)=>`10000000-0000-4000-8000-${String(n).padStart(12,'0')}`
const post=(n=1,patch:Partial<PostPublic>={}):PostPublic=>({id:id(n),body:'Offline',tag:'CONFESSION',displayMode:'ANONYMOUS',authorLabel:'OUer ẩn danh',contactUrl:null,publishedAt:'2026-11-17T00:00:00Z',upvoteCount:0,commentCount:0,hasUpvoted:false,isMine:false,images:[],...patch})
const envelope=(data:unknown)=>({data,error:null,meta:{requestId:id(99)}})
function deferred<T>(){let resolve!:(value:T)=>void,reject!:(error:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no});return{promise,resolve,reject}}
const tick=()=>new Promise(done=>setTimeout(done,0))
const client=()=>new QueryClient({defaultOptions:{queries:{retry:false,gcTime:Infinity},mutations:{retry:false,gcTime:Infinity}}})
const key=['posts',1,'NEW',null] as const
const feed=(cache:QueryClient)=>cache.getQueryData<InfiniteData<Page<PostPublic>>>(key)!
function seed(cache:QueryClient){cache.setQueryData(key,{pages:[{items:[post(),post(2)],nextCursor:'opaque-page-2'},{items:[post(3)],nextCursor:null}],pageParams:[null,'opaque-page-2']});cache.setQueryData(detailKey(1,id()),post())}

test('T09 adapter action/desiredState/explicit JWT và exact response allowlist',async()=>{
  const calls:unknown[]=[]
  const sdk=createClient('https://offline.example.invalid','sb_publishable_offline',{auth:{persistSession:false,autoRefreshToken:false},global:{fetch:async(_url,init)=>{
    assert.equal(new Headers(init?.headers).get('authorization'),'Bearer offline-session')
    const input=JSON.parse(String(init?.body));calls.push(input);return Response.json(envelope({hasUpvoted:input.payload.desiredState,upvoteCount:Number(input.payload.desiredState)}))
  }}})
  const api=createSocialApi(sdk,'offline-session')
  for(const desiredState of [true,false])assert.deepEqual(await api.setUpvote(id(),desiredState),{hasUpvoted:desiredState,upvoteCount:Number(desiredState)})
  assert.deepEqual(calls,[true,false].map(desiredState=>({action:'toggleUpvote',payload:{postId:id(),desiredState}})))
  await assert.rejects(api.setUpvote('bad',true),SocialApiError)
  for(const data of [{hasUpvoted:'true',upvoteCount:1},{hasUpvoted:true,upvoteCount:-1},{hasUpvoted:true,upvoteCount:1.5},{hasUpvoted:true,upvoteCount:1,user_id:'private'},{hasUpvoted:true,upvoteCount:1,email:'private@ou.edu.vn'},{}])assert.throws(()=>parseSocialResponse(envelope(data),200,'toggleUpvote'),SocialApiError)
})

test('optimistic Feed/Detail, serialize cùng post giữa views, reconcile server, giữ cursor/NEW order/post khác',async()=>{
  const cache=client();seed(cache);const pending=deferred<UpvoteState>();let calls=0
  const api={setUpvote:async()=>{calls++;return pending.promise}}
  const first=runUpvote(cache,api,1,{postId:id(),desiredState:true},()=>true,()=>assert.fail())
  await tick();assert.equal(feed(cache).pages[0].items[0].upvoteCount,1);assert.equal(cache.getQueryData<PostPublic>(detailKey(1,id()))?.hasUpvoted,true)
  await runUpvote(cache,api,1,{postId:id(),desiredState:false},()=>true,()=>assert.fail());assert.equal(calls,1)
  cache.setQueryData<InfiniteData<Page<PostPublic>>>(key,data=>({...data!,pages:data!.pages.map(page=>({...page,items:page.items.map(p=>p.id===id(2)?{...p,commentCount:9}:p)}))}))
  pending.resolve({hasUpvoted:true,upvoteCount:8});await first
  assert.equal(feed(cache).pages[0].items[0].upvoteCount,8);assert.equal(feed(cache).pages[0].items[1].commentCount,9)
  assert.deepEqual(feed(cache).pages.flatMap(p=>p.items.map(p=>p.id)),[id(),id(2),id(3)]);assert.deepEqual(feed(cache).pageParams,[null,'opaque-page-2']);assert.equal(feed(cache).pages[0].nextCursor,'opaque-page-2')
  assert.equal(cache.getQueryData<PostPublic>(detailKey(1,id()))?.upvoteCount,8);assert.equal(cache.getQueryState(key)?.isInvalidated,true);cache.clear()
})
test('lỗi rollback riêng target, retry lost ACK cùng desiredState không đảo vote',async()=>{
  const cache=client();seed(cache);let server=false;let fail=true;const inputs:boolean[]=[]
  const api={setUpvote:async(_id:string,desired:boolean)=>{inputs.push(desired);server=desired;if(fail){fail=false;throw new SocialApiError('INTERNAL_ERROR')}return{hasUpvoted:server,upvoteCount:Number(server)}}}
  await runUpvote(cache,api,1,{postId:id(),desiredState:true},()=>true,()=>{})
  assert.equal(feed(cache).pages[0].items[0].hasUpvoted,false)
  const failed=cache.getMutationCache().find({mutationKey:upvoteKey(1,id()),exact:true})!
  assert.equal(failed.state.status,'error');assert.deepEqual(failed.state.variables,{postId:id(),desiredState:true})
  await runUpvote(cache,api,1,failed.state.variables as {postId:string;desiredState:boolean},()=>true,()=>assert.fail())
  assert.deepEqual(inputs,[true,true]);assert.equal(feed(cache).pages[0].items[0].upvoteCount,1)
  await runUpvote(cache,api,1,{postId:id(),desiredState:false},()=>true,()=>assert.fail());assert.equal(feed(cache).pages[0].items[0].upvoteCount,0);cache.clear()
})
test('refetch mới giống optimistic (structural sharing) không bị rollback bởi lỗi cũ',async()=>{
  const cache=client();seed(cache);const pending=deferred<UpvoteState>()
  const run=runUpvote(cache,{setUpvote:()=>pending.promise},1,{postId:id(),desiredState:true},()=>true,()=>{})
  await tick();const optimistic=feed(cache)
  await cache.fetchQuery({queryKey:key,queryFn:async()=>structuredClone(optimistic)})
  assert.equal(feed(cache),optimistic)
  pending.reject(new SocialApiError('INTERNAL_ERROR'));await run
  assert.equal(feed(cache).pages[0].items[0].hasUpvoted,true);assert.equal(cache.getQueryData<PostPublic>(detailKey(1,id()))?.hasUpvoted,false);cache.clear()
})
test('manual cache update mới không bị success/rollback cũ ghi đè',async()=>{
  for(const success of [false,true]){
    const cache=client();seed(cache);const pending=deferred<UpvoteState>()
    const run=runUpvote(cache,{setUpvote:()=>pending.promise},1,{postId:id(),desiredState:true},()=>true,()=>{})
    await tick();cache.setQueryData(key,{pages:[{items:[post(1,{upvoteCount:9,hasUpvoted:false,commentCount:4})],nextCursor:null}],pageParams:[null]})
    if(success)pending.resolve({hasUpvoted:true,upvoteCount:1});else pending.reject(new SocialApiError('INTERNAL_ERROR'))
    await run;assert.equal(feed(cache).pages[0].items[0].upvoteCount,9);assert.equal(feed(cache).pages[0].items[0].commentCount,4);cache.clear()
  }
})
test('hai post pending độc lập, một success/một lỗi không rollback chéo',async()=>{
  const cache=client();seed(cache);const a=deferred<UpvoteState>(),b=deferred<UpvoteState>()
  const api={setUpvote:(postId:string)=>postId===id()?a.promise:b.promise}
  const first=runUpvote(cache,api,1,{postId:id(),desiredState:true},()=>true,()=>{})
  const second=runUpvote(cache,api,1,{postId:id(2),desiredState:true},()=>true,()=>{})
  await tick();assert.deepEqual(feed(cache).pages[0].items.map(p=>p.hasUpvoted),[true,true])
  a.resolve({hasUpvoted:true,upvoteCount:3});await first;assert.equal(feed(cache).pages[0].items[1].hasUpvoted,true)
  b.reject(new SocialApiError('INTERNAL_ERROR'));await second;assert.deepEqual(feed(cache).pages[0].items.map(p=>p.upvoteCount),[3,0]);cache.clear()
})
test('logout/account switch và response lỗi/success muộn không sửa/reject phiên mới',async()=>{
  for(const success of [false,true]){
    const cache=client();seed(cache);const pending=deferred<UpvoteState>();let current=true
    const run=runUpvote(cache,{setUpvote:()=>pending.promise},1,{postId:id(),desiredState:true},()=>current,()=>assert.fail('stale reject'))
    await tick();current=false;cache.clear();cache.setQueryData(['posts',2,'NEW',null],{pages:[{items:[post(1,{upvoteCount:7})],nextCursor:null}],pageParams:[null]})
    if(success)pending.resolve({hasUpvoted:true,upvoteCount:1});else pending.reject(new SocialApiError('UNAUTHENTICATED'))
    await run;assert.equal(cache.getQueryData(key),undefined);assert.equal(cache.getQueryData<InfiniteData<Page<PostPublic>>>(['posts',2,'NEW',null])?.pages[0].items[0].upvoteCount,7);cache.clear()
  }
})
test('HOT giữ thứ tự optimistic, sau settle reset cursor null và lấy sort từ server',async()=>{
  const cache=client();const cursors:(string|null)[]=[];let voted=false
  const observer=new InfiniteQueryObserver(cache,{queryKey:['posts',1,'HOT',null],initialPageParam:null as string|null,retry:false,queryFn:async({pageParam})=>{cursors.push(pageParam);return{items:voted?[post(2),post(1,{hasUpvoted:true,upvoteCount:1})]:[post(),post(2)],nextCursor:pageParam?null:'hot-old-cursor'}},getNextPageParam:(p:Page<PostPublic>)=>p.nextCursor??undefined})
  const stop=observer.subscribe(()=>{});await observer.refetch();await observer.fetchNextPage()
  const pending=deferred<UpvoteState>();const run=runUpvote(cache,{setUpvote:()=>pending.promise},1,{postId:id(),desiredState:true},()=>true,()=>{})
  await tick();assert.equal(observer.getCurrentResult().data?.pages[0].items[0].id,id())
  voted=true;pending.resolve({hasUpvoted:true,upvoteCount:1});await run
  assert.deepEqual(cursors,[null,'hot-old-cursor',null]);assert.equal(observer.getCurrentResult().data?.pages.length,1);assert.equal(observer.getCurrentResult().data?.pages[0].items[0].id,id(2));stop();cache.clear()
})
test('count không âm và lỗi raw được lọc trước vào mutation cache/reject/UI',async()=>{
  const cache=client();seed(cache);cache.setQueryData(detailKey(1,id()),post(1,{hasUpvoted:true,upvoteCount:0}));let rejected:unknown
  await runUpvote(cache,{setUpvote:async()=>{throw new Error('PRIVATE SQL JWT email@ou.edu.vn')}},1,{postId:id(),desiredState:false},()=>true,error=>{rejected=error})
  assert.ok(rejected instanceof SocialApiError);assert.doesNotMatch((rejected as Error).message,/PRIVATE|SQL|JWT|email@/);assert.equal(cache.getQueryData<PostPublic>(detailKey(1,id()))?.upvoteCount,0);cache.clear()
})
