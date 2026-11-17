import assert from 'node:assert/strict'
import { test } from 'node:test'
import { QueryClient, InfiniteQueryObserver, QueryObserver } from '@tanstack/react-query'
import type { CommentPublic, CreateCommentInput, Page } from '../src/shared/api/SocialApiClient.ts'
import { commentBodyError, createCommentSubmission } from '../src/features/comments/comment-submission.ts'
import { commentsKey, commentOptions, detailKey, detailOptions, refreshComments, uniqueComments } from '../src/features/comments/comment-query.ts'
import { SocialApiError } from '../src/shared/api/social-api.ts'
import { deferred, post } from './post-fixture.ts'

const comment=(n=1):CommentPublic=>({id:post(n).id,postId:post().id,body:'Bình luận offline 👋',authorLabel:'Chủ bài',isOriginalPoster:true,isMine:true,createdAt:'2026-11-16T12:00:00.123456Z'})
const cache=()=>new QueryClient({defaultOptions:{queries:{retry:false,gcTime:0}}})
test('Comment validation 0/1/500/501 Unicode, trim, NUL/lone surrogate',()=>{
  for(const n of [0,1,500,501]) assert.equal(!!commentBodyError(` ${'👋'.repeat(n)} `),n===0||n>500)
  for(const body of ['x\u0000y','x\uD800y','x\uDC00y'])assert.ok(commentBodyError(body))
})
test('Comment submit validation/double click, chỉ success sau API CommentPublic',async()=>{
  const response=deferred<CommentPublic>();let calls=0;let keys=0
  const model=createCommentSubmission({createComment:async()=>{calls++;return response.promise}},post().id,()=>true,()=>{},()=>{keys++;return post(2).id})
  await model.submit('');assert.equal(keys,0)
  const request=model.submit('offline');await model.submit('offline')
  assert.equal(calls,1);assert.equal(model.getSnapshot().busy,true);response.resolve(comment());assert.deepEqual(await request,comment());assert.equal(model.getSnapshot().locked,false)
})
test('Mất response/server/conflict giữ snapshot/key; success lần sau cấp key mới, không lộ raw error',async()=>{
  const inputs:CreateCommentInput[]=[];let key=1
  const model=createCommentSubmission({createComment:async input=>{inputs.push({...input});if(inputs.length===1)throw new Error('private SQL JWT');return comment()}},post().id,()=>true,()=>{},()=>post(++key).id)
  await model.submit('  offline 👋  ');assert.equal(model.getSnapshot().locked,true);assert.doesNotMatch(model.getSnapshot().error,/private|SQL|JWT/)
  await model.submit('Body mới không được dùng');assert.deepEqual(inputs[0],inputs[1]);assert.equal(inputs[0].body,'offline 👋')
  await model.submit('Yêu cầu mới');assert.notEqual(inputs[2].idempotencyKey,inputs[1].idempotencyKey)
  for(const code of ['CONFLICT','VALIDATION_ERROR'] as const){const failed=createCommentSubmission({createComment:async()=>{throw new SocialApiError(code)}},post().id,()=>true,()=>{});await failed.submit('offline');assert.equal(failed.getSnapshot().error,new SocialApiError(code).message);assert.equal(failed.getSnapshot().locked,true)}
})
test('Create response/lỗi tới muộn sau unmount/session change không cập nhật hoặc reject phiên mới',async()=>{
  for(const fail of [false,true]){
    const pending=deferred<CommentPublic>();let current=true
    const model=createCommentSubmission({createComment:async()=>pending.promise},post().id,()=>current,()=>assert.fail('stale reject'))
    const request=model.submit('offline');current=false
    if(fail)pending.reject(new SocialApiError('UNAUTHENTICATED'));else pending.resolve(comment())
    assert.equal(await request,undefined)
  }
})
test('Comment keyset query params/dedupe/trang cuối và không request next page song song',async()=>{
  const client=cache();const calls:unknown[]=[];const pending=deferred<Page<CommentPublic>>()
  const options=commentOptions({listComments:async input=>{calls.push(input);return input.cursor?pending.promise:{items:[comment(1),comment(2)],nextCursor:'opaque-comments'}}},1,post().id,()=>true,()=>{})
  const observer=new InfiniteQueryObserver(client,options);const stop=observer.subscribe(()=>{});await observer.refetch()
  assert.deepEqual(calls[0],{postId:post().id,cursor:null,limit:20})
  const first=observer.fetchNextPage({cancelRefetch:false});const second=observer.fetchNextPage({cancelRefetch:false})
  pending.resolve({items:[comment(2),comment(3)],nextCursor:null});await Promise.all([first,second])
  assert.equal(calls.length,2);assert.deepEqual(uniqueComments(observer.getCurrentResult().data?.pages).map(c=>c.id),[comment(1).id,comment(2).id,comment(3).id]);assert.equal(observer.getCurrentResult().hasNextPage,false)
  stop();client.clear()
})
test('Sau write reset comments cursor null, detail/feed count refetch từ server, không tự cộng count',async()=>{
  const client=cache();const cursors:(string|null)[]=[];let n=0
  const comments=new InfiniteQueryObserver(client,commentOptions({listComments:async input=>{cursors.push(input.cursor);return{items:[comment()],nextCursor:input.cursor?null:'old'}}},1,post().id,()=>true,()=>{}))
  const detail=new QueryObserver(client,detailOptions({getPost:async()=>({...post(),commentCount:n})},1,post().id,()=>true,()=>{}))
  const stops=[comments.subscribe(()=>{}),detail.subscribe(()=>{})];await comments.refetch();await detail.refetch();await comments.fetchNextPage()
  client.setQueryData(['posts',1,'NEW',null],{pages:[{items:[post()]}]});n=3
  await refreshComments(client,1,post().id)
  assert.deepEqual(cursors,[null,'old',null]);assert.equal(detail.getCurrentResult().data?.commentCount,3);assert.equal(client.getQueryState(['posts',1,'NEW',null])?.isInvalidated,true)
  stops.forEach(stop=>stop());client.clear()
})
test('Cursor lỗi giữ trang cũ, reset null; NOT_FOUND và Auth errors không giả empty',async()=>{
  const client=cache();const observer=new InfiniteQueryObserver(client,commentOptions({listComments:async input=>{if(input.cursor)throw new SocialApiError('VALIDATION_ERROR');return{items:[comment()],nextCursor:'expired'}}},1,post().id,()=>true,()=>{}))
  const stop=observer.subscribe(()=>{});await observer.refetch();await observer.fetchNextPage();assert.equal(observer.getCurrentResult().isFetchNextPageError,true);assert.equal(observer.getCurrentResult().data?.pages.length,1)
  await client.resetQueries({queryKey:commentsKey(1,post().id),exact:true});assert.equal(observer.getCurrentResult().isError,false);stop();client.clear()
  for(const code of ['NOT_FOUND','FORBIDDEN','UNAUTHENTICATED'] as const){let rejected:unknown;await assert.rejects(client.fetchQuery(detailOptions({getPost:async()=>{throw new SocialApiError(code)}},1,post().id,()=>true,error=>{rejected=error})));assert.ok(rejected instanceof SocialApiError);assert.equal(rejected.code,code);client.clear()}
})
test('Query scope/postId isolation: logout clear, response/error tới muộn không vào tài khoản mới',async()=>{
  const client=cache();const pending=deferred<Page<CommentPublic>>();let current=true
  const old=client.fetchInfiniteQuery(commentOptions({listComments:async()=>pending.promise},1,post().id,()=>current,()=>assert.fail('stale rejection'))).catch(()=>undefined)
  current=false;await client.cancelQueries();client.clear()
  await client.fetchInfiniteQuery(commentOptions({listComments:async()=>({items:[comment(3)],nextCursor:null})},2,post().id,()=>true,()=>{}))
  pending.reject(new SocialApiError('UNAUTHENTICATED'));await old
  assert.equal(client.getQueryData(commentsKey(1,post().id)),undefined)
  assert.notDeepEqual(commentsKey(2,post().id),commentsKey(2,post(2).id));assert.notDeepEqual(detailKey(1,post().id),detailKey(2,post().id));client.clear()
})
