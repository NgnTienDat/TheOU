// Chỉ API/Auth giả lập; không đọc env thật hoặc cho request ra Cloud.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { chromium } from 'playwright-core'

const root=fileURLToPath(new URL('../',import.meta.url));const artifacts=join(root,'node_modules/.cache/theou-comments-ui');const origin='http://127.0.0.1:5190'
const prototype=await readFile(join(root,'../docs/fe-templates/TheOU-Social-UI-Redesign-V2.html'),'utf8')
const server=spawn(process.execPath,['node_modules/vite/bin/vite.js','--host','127.0.0.1','--port','5190','--strictPort'],{cwd:root,windowsHide:true,stdio:'ignore',env:{...process.env,VITE_SUPABASE_URL:'https://offline.example.invalid',VITE_SUPABASE_PUBLISHABLE_KEY:'sb_publishable_offline_ui'}})
const id=n=>`10000000-0000-4000-8000-${String(n).padStart(12,'0')}`
const user={id:id(900),email:'offline.student@ou.edu.vn',email_confirmed_at:'2026-11-01T00:00:00Z',aud:'authenticated',app_metadata:{},user_metadata:{}}
const jwt=`${Buffer.from('{"alg":"HS256"}').toString('base64url')}.${Buffer.from(JSON.stringify({sub:user.id,exp:4_000_000_000})).toString('base64url')}.offline`
const session={user,access_token:jwt,refresh_token:'offline-refresh',token_type:'bearer',expires_in:3600}
const envelope=data=>({data,error:null,meta:{requestId:id(999)}})
const fail=(code)=>({data:null,error:{code,message:'PRIVATE SQL JWT secret@ou.edu.vn',details:null},meta:{requestId:id(999)}})
const comment=n=>({id:id(n+10),postId:id(1),body:n===3?'x'.repeat(500):`Bình luận offline ${n}.\n\nCùng lắng nghe nhé.`,authorLabel:n%2?'Chủ bài':'OUer ẩn danh',isOriginalPoster:!!(n%2),isMine:n%3===0,createdAt:new Date(Date.now()-(200-n)*60_000).toISOString()})
let comments=Array.from({length:23},(_,i)=>comment(i+1));const deleted=new Set();const snapshots=new Map()
let contactUrl=null
const post=()=>({id:id(1),tag:contactUrl?'TAI_LIEU':'CONFESSION',body:'Một câu chuyện offline.\n\nBình luận một tầng, giữ riêng tư.',displayMode:contactUrl?'NICKNAME':'ANONYMOUS',authorLabel:contactUrl?'OUer snapshot':'OUer ẩn danh',contactUrl,publishedAt:'2026-11-16T12:00:00Z',upvoteCount:0,commentCount:comments.filter(c=>!deleted.has(c.id)).length,hasUpvoted:false,isMine:true,images:[]})
let postMode='ready';let listMode='long';let createMode='normal';let deleteMode='normal';let lost=false;let holdCreate=false;let releaseCreate;let releasePost;let releaseList;let releaseDelete
const createCalls=[];const deleteCalls=[];const listCalls=[];let browser;let shots=0
try{
  let ready=false
  for(let n=0;n<600;n++){try{if((await fetch(origin)).ok){ready=true;break}}catch{/* Chờ Vite. */}await new Promise(done=>setTimeout(done,50))}
  assert.equal(ready,true,'Vite mock phải sẵn sàng trước browser test')
  browser=await chromium.launch({executablePath:process.env.THEOU_BROWSER_PATH??'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',headless:true})
  const context=await browser.newContext({reducedMotion:'reduce'});const page=await context.newPage();const errors=[];page.on('pageerror',()=>errors.push('runtime error'))
  await context.route('**/*',async route=>{
    const request=route.request();const url=new URL(request.url());if(url.origin===origin&&url.pathname==='/__v2-reference.html')return route.fulfill({contentType:'text/html',body:prototype});if(url.origin===origin)return route.continue();if(url.origin!=='https://offline.example.invalid')return route.abort()
    const input=request.postDataJSON()??{};let body={};let status=200
    if(url.pathname.endsWith('/token'))body=session
    else if(url.pathname.endsWith('/user'))body=user
    else if(url.pathname.endsWith('/logout'))body={}
    else if(url.pathname.endsWith('/social-api')){
      assert.equal(request.headers().authorization,`Bearer ${jwt}`)
      if(input.action==='getMe')body=envelope({nickname:'OUer riêng tư',emailMasked:'***@ou.edu.vn',isAdmin:false})
      else if(input.action==='listPosts')body=envelope({items:[post()],nextCursor:null})
      else if(input.action==='getPost'){
        const mode=postMode;if(mode==='hold')await new Promise(done=>{releasePost=done})
        if(mode==='missing'||input.payload.postId!==id(1)){status=404;body=fail('NOT_FOUND')}
        else if(mode==='error'){status=500;body=fail('INTERNAL_ERROR')}
        else body=envelope(post())
      }else if(input.action==='listComments'){
        listCalls.push(input.payload);const mode=listMode;if(mode==='hold')await new Promise(done=>{releaseList=done})
        if(mode==='missing'){status=404;body=fail('NOT_FOUND')}
        else if(mode==='error'||(mode==='page-error'&&input.payload.cursor)){status=500;body=fail('INTERNAL_ERROR')}
        else if(mode==='cursor-error'&&input.payload.cursor){status=400;body=fail('VALIDATION_ERROR')}
        else if(mode==='privacy')body=envelope({items:[{...comment(1),authorId:user.id,email:user.email}],nextCursor:null})
        else if(mode==='empty'||mode==='hold')body=envelope({items:[],nextCursor:null})
        else {const visible=comments.filter(c=>!deleted.has(c.id));body=envelope(input.payload.cursor?{items:visible.slice(19),nextCursor:null}:{items:visible.slice(0,20),nextCursor:visible.length>20?'opaque-comments-page-2':null})}
      }else if(input.action==='createComment'){
        createCalls.push(input.payload)
        if(holdCreate)await new Promise(done=>{releaseCreate=done})
        if(createMode==='missing'){status=404;body=fail('NOT_FOUND')}
        else if(createMode==='conflict'){status=409;body=fail('CONFLICT')}
        else{
          if(!snapshots.has(input.payload.idempotencyKey)){const c={...comment(100+snapshots.size),body:input.payload.body,postId:input.payload.postId,isMine:true};snapshots.set(input.payload.idempotencyKey,c);comments.push(c)}
          if(createMode==='lost'&&!lost){lost=true;return route.abort()}
          body=envelope(snapshots.get(input.payload.idempotencyKey))
        }
      }else if(input.action==='deleteComment'){
        deleteCalls.push(input.payload.commentId)
        if(deleteMode==='hold')await new Promise(done=>{releaseDelete=done})
        if(deleteMode==='error'){status=500;body=fail('INTERNAL_ERROR')}
        else{deleted.add(input.payload.commentId);body=envelope({success:true})}
      }else assert.fail('Không có action ngoài T08 scope')
    }else assert.fail('Không cho request tới endpoint chưa mock')
    await route.fulfill({status,contentType:'application/json',body:JSON.stringify(body),headers:{'access-control-allow-origin':'*','x-supabase-api-version':'2024-01-01'}})
  })
  await mkdir(artifacts,{recursive:true})
  async function shot(name,width,theme){await page.setViewportSize({width,height:width<600?860:960});if(await page.getAttribute('html','data-theme')!==theme)await page.getByRole('button',{name:/Chuyển giao diện/}).click();if(name==='comments-long-fixed')await page.locator('.comment-card').last().scrollIntoViewIfNeeded();else await page.evaluate(()=>scrollTo(0,0));assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.screenshot({path:join(artifacts,`${name}-${width}-${theme}.png`),fullPage:false,style:'.toast{visibility:hidden}'});shots++}
  async function open(){await page.getByRole('link',{name:'Mở bài viết và bình luận',exact:true}).click();await page.getByRole('heading',{name:'Bài viết',exact:true}).waitFor()}
  async function back(){await page.getByRole('link',{name:'Bảng tin',exact:true}).click();await page.getByRole('heading',{name:'Bảng tin',exact:true}).waitFor()}
  async function reload(){await page.getByRole('button',{name:'Làm mới bình luận',exact:true}).click()}
  await page.goto(`${origin}/bai-viet/${id(1)}`);await page.waitForURL('**/dang-nhap')
  await page.getByLabel('Email trường',{exact:true}).fill(user.email);await page.getByLabel('Mật khẩu',{exact:true}).fill('Offline-password!');await page.getByRole('button',{name:'Đăng nhập',exact:true}).click();await page.getByRole('heading',{name:'Bảng tin',exact:true}).waitFor()
  // Link phủ card: native modifiers/keyboard, copy text và controls độc lập.
  const card=page.locator('.post-card').first();const detail=page.getByRole('link',{name:'Mở bài viết và bình luận',exact:true})
  assert.equal(await card.locator('a a,a button,button a').count(),0)
  await card.click({position:{x:8,y:8}});await page.waitForURL(`**/bai-viet/${id(1)}`);await back()
  await detail.focus();await page.keyboard.press('Enter');await page.waitForURL(`**/bai-viet/${id(1)}`);await back()
  for(const options of [{button:'middle'},{modifiers:['Control']}]){
    const opened=context.waitForEvent('page');await detail.click(options);const tab=await opened;await tab.waitForURL(`**/bai-viet/${id(1)}`);await tab.close();assert.equal(new URL(page.url()).pathname,'/')
  }
  const textBox=await card.locator('.post-link-text').boundingBox();assert.ok(textBox)
  await page.mouse.move(textBox.x+3,textBox.y+8);await page.mouse.down();await page.mouse.move(textBox.x+110,textBox.y+8,{steps:12});await page.mouse.up()
  assert.match(await page.evaluate(()=>getSelection()?.toString()),/Một câu/);assert.equal(new URL(page.url()).pathname,'/')
  await page.evaluate(()=>getSelection()?.removeAllRanges())
  await page.evaluate(()=>Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async value=>{window.__copiedUrl=value}}}))
  await page.getByRole('button',{name:'Sao chép liên kết bài',exact:true}).click()
  assert.equal(await page.evaluate(()=>window.__copiedUrl),`${origin}/bai-viet/${id(1)}`)
  assert.equal(new URL(page.url()).pathname,'/')
  await page.evaluate(()=>Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async()=>{throw new Error('offline clipboard denied')}}}))
  await page.getByRole('button',{name:'Sao chép liên kết bài',exact:true}).click()
  await page.getByRole('status').filter({hasText:'Không thể sao chép tự động.'}).waitFor()
  assert.equal(new URL(page.url()).pathname,'/')
  await card.evaluate(element=>{const button=document.createElement('button');button.type='button';button.textContent='Control test offline';button.onclick=()=>{button.dataset.clicked='true'};element.append(button)})
  const nested=page.getByRole('button',{name:'Control test offline',exact:true});await nested.click();assert.equal(await nested.getAttribute('data-clicked'),'true');assert.equal(new URL(page.url()).pathname,'/');await nested.evaluate(element=>element.remove())
  contactUrl='https://zalo.me/offline';await page.getByRole('button',{name:'Làm mới bảng tin',exact:true}).click()
  const external=context.waitForEvent('page');await page.getByRole('link',{name:/Liên hệ người đăng/}).click();const tab=await external;await tab.close();assert.equal(new URL(page.url()).pathname,'/')
  contactUrl=null;await page.getByRole('button',{name:'Làm mới bảng tin',exact:true}).click()
  postMode='hold';await page.goto(`${origin}/bai-viet/${id(1)}`);await page.getByText('Đang tải bài viết…',{exact:true}).waitFor()
  for(const theme of ['dark','light'])await shot('post-loading',390,theme)
  postMode='ready';listMode='hold';releasePost();await page.getByText('Đang tải bình luận…',{exact:true}).waitFor()
  for(const theme of ['dark','light'])await shot('comments-loading',390,theme)
  releaseList();await page.getByText('Chưa có bình luận nào',{exact:true}).waitFor()
  assert.equal(await page.locator('.post-thread .post-detail-link').count(),0)
  assert.equal(await page.getByRole('button',{name:'Gửi bình luận',exact:true}).count(),0)
  assert.equal(await page.locator('#comment-body').evaluate(e=>e===document.activeElement),false)
  for(const theme of ['dark','light'])await shot('comments-empty',390,theme)
  listMode='error';await reload();await page.getByText('Không tải được bình luận',{exact:true}).waitFor()
  for(const theme of ['dark','light'])await shot('comments-error',390,theme)
  listMode='long';await page.getByRole('button',{name:'Thử lại',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('.comment-card').length===20)
  assert.deepEqual(listCalls.at(-1),{postId:id(1),cursor:null,limit:20})
  assert.equal(await page.locator('.comment-card .op-label').first().textContent(),'Chủ bài')
  assert.equal(await page.locator('.comment-card .post-avatar,.comment-card a').count(),0)
  assert.doesNotMatch(await page.locator('.comments-section').innerHTML(),new RegExp(`${user.email}|${user.id}|OUer riêng tư|author_id|authorId|userMetadata`))
  assert.equal(await page.getByRole('button',{name:'Xóa bình luận của bạn',exact:true}).count(),6)
  for(const width of [360,390,768,1280])for(const theme of ['dark','light']){
    await shot('post-comments',width,theme)
    const layout=await page.evaluate(()=>{const form=document.querySelector('.comment-composer');const post=document.querySelector('.post-thread>.post-card');const content=document.querySelector('.comments-content');const title=document.querySelector('.comments-title');return{position:getComputedStyle(form).position,form:form.getBoundingClientRect().toJSON(),post:post.getBoundingClientRect().toJSON(),title:title.getBoundingClientRect().toJSON(),content:content.getBoundingClientRect().toJSON(),height:innerHeight}})
    assert.equal(layout.title.top,layout.post.bottom)
    if(width<=720){assert.equal(layout.position,'fixed');assert.equal(layout.form.bottom,layout.height-64);assert.equal(layout.form.x,0);assert.equal(layout.form.width,width);assert.equal(layout.content.top,layout.title.bottom)}
    else{assert.equal(layout.position,'static');assert.equal(layout.form.top,layout.title.bottom);assert.equal(layout.content.top,layout.form.bottom)}
  }
  const reference=await context.newPage();await reference.goto(`${origin}/__v2-reference.html#/bai-viet/p1`)
  for(const width of [360,390,768,1280])for(const theme of ['dark','light']){
    await reference.setViewportSize({width,height:width<600?860:960});await reference.evaluate(theme=>{document.documentElement.dataset.theme=theme},theme)
    await page.setViewportSize({width,height:width<600?860:960})
    if(await page.getAttribute('html','data-theme')!==theme)await page.getByRole('button',{name:/Chuyển giao diện/}).click()
    const expected=await reference.locator('#screen-detail .column').evaluate(e=>({width:e.getBoundingClientRect().width,bg:getComputedStyle(e).getPropertyValue('--bg').trim()}))
    const actual=await page.locator('.social-wrap').evaluate(e=>{const s=getComputedStyle(e);return{width:e.getBoundingClientRect().width-parseFloat(s.paddingLeft)-parseFloat(s.paddingRight),bg:s.getPropertyValue('--bg').trim()}})
    assert.deepEqual(actual,expected,`Detail V2 column/background ${width}/${theme}`)
    await reference.screenshot({path:join(artifacts,`reference-detail-${width}-${theme}.png`),fullPage:false})
  }
  await reference.close()
  listMode='page-error';await page.getByRole('button',{name:'Tải thêm bình luận',exact:true}).click();await page.getByRole('button',{name:'Thử tải thêm',exact:true}).waitFor();assert.equal(await page.locator('.comment-card').count(),20)
  listMode='long';await page.getByRole('button',{name:'Thử tải thêm',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('.comment-card').length===23)
  assert.equal(listCalls.at(-1).cursor,'opaque-comments-page-2')
  await reload();await page.waitForFunction(()=>document.querySelectorAll('.comment-card').length===20)
  listMode='cursor-error';await page.getByRole('button',{name:'Tải thêm bình luận',exact:true}).click();await page.getByRole('button',{name:'Tải lại bình luận',exact:true}).waitFor()
  listMode='long';await page.getByRole('button',{name:'Tải lại bình luận',exact:true}).click();await page.getByRole('button',{name:'Tải thêm bình luận',exact:true}).waitFor();assert.equal(listCalls.at(-1).cursor,null)
  const input=page.getByLabel('Bình luận của bạn',{exact:true})
  await input.fill('Giữ draft khi đổi breakpoint')
  const composerHandle=await page.locator('.comment-composer').elementHandle()
  await page.setViewportSize({width:390,height:860});await page.setViewportSize({width:1280,height:960})
  assert.equal(await page.locator('.comment-composer').count(),1)
  assert.equal(await composerHandle.evaluate(e=>e===document.querySelector('.comment-composer')),true)
  assert.equal(await input.inputValue(),'Giữ draft khi đổi breakpoint');await input.fill('')
  await shot('composer-collapsed',390,'dark');await shot('composer-collapsed',390,'light')
  await input.fill('Bình luận đang nhập offline');await shot('composer-typing',390,'dark')
  await input.fill('');await input.blur();await shot('comments-long-fixed',390,'dark')
  await page.locator('.comment-composer').evaluate(form=>form.requestSubmit());await page.getByText('Bình luận cần từ 1 đến 500 ký tự.',{exact:true}).waitFor();assert.equal(await input.evaluate(e=>e===document.activeElement),true)
  await input.fill('👋'.repeat(501));await page.getByText('501/500',{exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'Gửi bình luận',exact:true}).isDisabled(),true);assert.equal(createCalls.length,0)
  await input.fill('Dòng thứ nhất');await input.press('End');await input.press('Enter');await input.press('A');assert.equal(createCalls.length,0);assert.match(await input.inputValue(),/\nA$/)
  for(const width of [360,390]){
    await page.setViewportSize({width,height:600});await input.fill('Dòng ngắn')
    const collapsed=await page.locator('.comment-composer').boundingBox()
    await input.fill('Nội dung offline\n'.repeat(28))
    await page.waitForFunction(()=>document.querySelector('#comment-body').scrollHeight>document.querySelector('#comment-body').clientHeight)
    const expanded=await page.locator('.comment-composer').boundingBox();assert.ok(expanded.height>collapsed.height)
    await page.evaluate(()=>scrollTo(0,document.documentElement.scrollHeight))
    const last=await page.locator('.comment-card').last().boundingBox();assert.ok(last.y+last.height<=expanded.y)
    assert.equal(await page.locator('.comment-composer').evaluate(element=>{const r=element.getBoundingClientRect();return element.contains(document.elementFromPoint(30,r.y+10))}),true)
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true)
  }
  await page.setViewportSize({width:390,height:380});await input.fill('Bàn phím mô phỏng');await input.focus()
  const send=page.getByRole('button',{name:'Gửi bình luận',exact:true});assert.equal(await send.isVisible(),true)
  const sendBox=await send.boundingBox();assert.ok(sendBox.y>=0&&sendBox.y+sendBox.height<=380)
  await page.evaluate(()=>{Object.defineProperty(visualViewport,'height',{configurable:true,value:240});Object.defineProperty(visualViewport,'offsetTop',{configurable:true,value:20});visualViewport.dispatchEvent(new Event('resize'))})
  const keyboard=await page.locator('.comment-composer').boundingBox();assert.equal(keyboard.y+keyboard.height,260);assert.equal(await page.locator('.social-nav').isVisible(),false)
  assert.ok(await page.locator('.comment-composer').evaluate(e=>parseFloat(getComputedStyle(e).paddingBottom)>=7))
  await page.evaluate(()=>{delete visualViewport.height;delete visualViewport.offsetTop;visualViewport.dispatchEvent(new Event('resize'))})
  await input.fill('');await page.setViewportSize({width:390,height:600})
  await input.fill('  Comment retry offline 👋  ');createMode='lost';holdCreate=true
  await input.press('Control+Enter');await page.locator('.comment-composer').evaluate(form=>form.requestSubmit())
  await page.getByRole('button',{name:'Đang gửi bình luận',exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'Đang gửi bình luận',exact:true}).isDisabled(),true)
  holdCreate=false;releaseCreate()
  await page.getByRole('button',{name:'Thử gửi lại',exact:true}).waitFor();assert.equal(createCalls.length,1);assert.equal(await input.isDisabled(),true);assert.equal(await input.inputValue(),'  Comment retry offline 👋  ')
  await page.getByRole('button',{name:'Thử gửi lại',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#comment-body')?.value==='')
  assert.equal(createCalls.length,2);assert.deepEqual(createCalls[0],createCalls[1]);assert.equal(createCalls[0].body,'Comment retry offline 👋')
  await page.waitForFunction(()=>document.querySelector('.post-stats')?.textContent.includes('24 bình luận'))
  await back();await page.waitForFunction(()=>document.querySelector('.post-stats')?.textContent.includes('24 bình luận'));await open();await page.locator('.comment-card').first().waitFor()
  const remove=page.getByRole('button',{name:'Xóa bình luận của bạn',exact:true}).first()
  page.once('dialog',dialog=>dialog.dismiss());await remove.click();assert.equal(deleteCalls.length,0)
  deleteMode='error';page.once('dialog',dialog=>dialog.accept());await remove.click();await page.locator('.comments-section .form-alert').waitFor();assert.equal(await page.locator('.comment-card').count(),20)
  assert.doesNotMatch(await page.locator('.comments-section').innerText(),/PRIVATE|SQL|JWT|secret@/)
  deleteMode='hold';page.once('dialog',dialog=>dialog.accept());await remove.click();await page.waitForFunction(()=>document.querySelector('.comment-delete[aria-busy="true"]'));assert.equal(await remove.isDisabled(),true)
  releaseDelete();await page.waitForFunction(()=>document.querySelector('.post-stats')?.textContent.includes('23 bình luận'))
  await page.setViewportSize({width:390,height:600});await input.fill('Chưa gửi');await input.focus();assert.equal(await page.getByRole('button',{name:'Gửi bình luận',exact:true}).isVisible(),true)
  listMode='privacy';await reload();await page.getByText('Không tải được bình luận',{exact:true}).waitFor();assert.doesNotMatch(await page.locator('.social-wrap').innerHTML(),new RegExp(`${user.email}|${user.id}|authorId`))
  listMode='long';await page.getByRole('button',{name:'Thử lại',exact:true}).click();await page.locator('.comment-card').first().waitFor()
  listMode='missing';await reload();await page.getByRole('heading',{name:'Không tìm thấy bài viết',exact:true}).waitFor();assert.equal(await input.count(),0)
  for(const theme of ['dark','light'])await shot('post-not-found',390,theme)
  postMode='error';listMode='long';await page.goto(`${origin}/bai-viet/${id(2)}`);await page.getByRole('heading',{name:'Không tìm thấy bài viết',exact:true}).waitFor()
  await page.goto(`${origin}/bai-viet/${id(1)}`);await page.getByRole('heading',{name:'Không tải được bài viết',exact:true}).waitFor()
  postMode='ready';await page.getByRole('button',{name:'Thử lại',exact:true}).click();await page.locator('.comment-card').first().waitFor()
  const theme=await page.getAttribute('html','data-theme');await back();assert.equal(await page.getAttribute('html','data-theme'),theme)
  await page.getByRole('link',{name:'Cá nhân',exact:true}).click();await page.getByRole('button',{name:'Đăng xuất',exact:true}).click();await page.waitForURL('**/dang-nhap');assert.equal(await page.locator('.comment-card').count(),0)
  assert.deepEqual(errors,[])
  console.log(`PASS: Comments browser offline — ${shots} screenshots; whole-card link/keyboard/modifiers/text selection/controls, thread desktop/fixed mobile, composer resize/validation/replay, OP/privacy/pagination/delete/count/Auth/theme. Không gọi Cloud.`)
  console.log('Ảnh dữ liệu giả: frontend/node_modules/.cache/theou-comments-ui/ (gitignored).')
}finally{releaseCreate?.();releasePost?.();releaseList?.();releaseDelete?.();await browser?.close();server.kill()}
