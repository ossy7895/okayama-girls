// Optional browser regression: requires Playwright + Chromium. All network calls are intercepted.
const {chromium}=require('playwright'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
const ORIGIN='https://okayama.test';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=','base64');
class R2{
 objects=new Map();n=0;
 async get(key){const o=this.objects.get(key);return o?{...o,body:o.value,json:async()=>JSON.parse(o.value)}:null;}
 async put(key,value,opts={}){const prev=this.objects.get(key);if(opts.onlyIf?.etagMatches&&prev?.etag!==opts.onlyIf.etagMatches||opts.onlyIf instanceof Headers&&prev)return null;const o={value,etag:'e'+(++this.n),httpMetadata:opts.httpMetadata};this.objects.set(key,o);return o;}
 async delete(key){this.objects.delete(key);}
 async list({prefix}){return {objects:[...this.objects.keys()].filter(k=>k.startsWith(prefix)).map(key=>({key})),truncated:false};}
}
(async()=>{
 const {default:worker}=await import('../cloudflare/album/worker.mjs'),r2=new R2(),errors=[],requests=[],eventWrites=[];
 globalThis.fetch=async(url,options)=>{if(String(url).includes('accounts:lookup'))return Response.json({users:[{localId:JSON.parse(options.body).idToken}]});return Response.json({fields:{role:{stringValue:options.headers.Authorization.includes('member')?'member':'admin'}}});};
 const env={MEDIA:r2,FIREBASE_WEB_API_KEY:'mock',FIREBASE_SERVICE_ACCOUNT:'mock-configured',MEDIA_SIGNING_KEY:'mock-signing-key-of-more-than-32-characters',ALLOWED_ORIGIN:ORIGIN};
 let failNextPlaceWrite=false;
 const placeId=crypto.randomUUID(),apiBase='https://white-leaf-338b.4khrhp97z8.workers.dev';
 await worker.fetch(new Request(apiBase+'/places/'+placeId,{method:'PUT',headers:{Origin:ORIGIN,Authorization:'Bearer admin'},body:JSON.stringify({name:'検証球場',address:'岡山市 検証町1',mapUrl:'',version:'',operationId:crypto.randomUUID()})}),env);
 const sdk=`const user={uid:window.mockRole||'admin',email:'mock@example.test',getIdToken:async()=>window.mockRole||'admin'};const auth={currentUser:user};let callback;
 export const initializeApp=()=>({}),getAuth=()=>auth,getFirestore=()=>({});
 export function onAuthStateChanged(a,cb){callback=cb;setTimeout(()=>cb(a.currentUser),0);return ()=>{};}
 export const signInWithEmailAndPassword=async()=>{},signOut=async()=>{auth.currentUser=null;await callback(null);};
 const reference=(db,...parts)=>({path:parts.join('/')});export const doc=reference,collection=reference,query=r=>r,orderBy=()=>({}),where=()=>({}),limit=()=>({}),startAfter=()=>({}),arrayUnion=(...v)=>v,arrayRemove=(...v)=>v;
 const snap=(id,data)=>({id,exists:()=>true,data:()=>data});
 const future=new Date(Date.now()+86400000*10);const events=[snap('linked',{name:'ID紐付けの予定',type:'練習',date:future,place:'検証球場',placeId:'${placeId}'}),snap('legacy',{name:'旧予定',type:'練習',date:future,place:'検証球場'}),snap('missing',{name:'未登録の予定',type:'練習',date:future,place:'未登録グラウンド'})];
 export const getDoc=async r=>snap('mock',{role:window.mockRole||'admin'}),getDocs=async()=>({docs:[],forEach(){}});
 export function onSnapshot(ref,cb){let active=true;setTimeout(()=>{if(!active)return;cb(ref.path.startsWith('settings/')?{exists:()=>false,data:()=>({})}:{docs:ref.path==='events'?events:[],forEach(){}});},0);return ()=>{active=false;};}
 export const Timestamp={fromDate:d=>d,now:()=>new Date()};
 export const addDoc=async(r,data)=>{await window.recordEventWrite({kind:'add',path:r.path,data});return {id:'new-event'};},updateDoc=async(r,data)=>window.recordEventWrite({kind:'update',path:r.path,data}),setDoc=async()=>{},deleteDoc=async()=>{},runTransaction=async()=>{};`;
 const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium'});
 try{
 const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,deviceScaleFactor:1});
 await context.exposeBinding('recordEventWrite',(_,data)=>eventWrites.push(data));
 await context.route('**/*',async route=>{
   const request=route.request(),url=new URL(request.url());
   if(url.origin===ORIGIN)return route.fulfill({contentType:'text/html',body:html});
   if(url.hostname==='www.gstatic.com')return route.fulfill({contentType:'application/javascript',headers:{'Access-Control-Allow-Origin':'*'},body:sdk});
   if(url.hostname==='cdnjs.cloudflare.com')return route.fulfill({contentType:'text/css',body:''});
   if(url.origin===apiBase){
     requests.push({method:request.method(),path:url.pathname,body:request.postDataJSON()});
     if(failNextPlaceWrite&&request.method()==='PUT'){failNextPlaceWrite=false;return route.fulfill({status:503,headers:{'Access-Control-Allow-Origin':ORIGIN},json:{error:'service_unavailable'}});}
     const headers=request.headers();headers.origin=ORIGIN;
     const response=await worker.fetch(new Request(request.url(),{method:request.method(),headers,...(request.postDataBuffer()?{body:request.postDataBuffer()}:{})}),env);
     return route.fulfill({status:response.status,headers:Object.fromEntries(response.headers),body:Buffer.from(await response.arrayBuffer())});
   }
   throw Error('Unexpected request (blocked): '+request.url());
 });
 const page=await context.newPage();page.on('pageerror',e=>{errors.push(e.message);console.error('Page error:',e.message);});page.on('dialog',d=>d.accept());
 await page.goto(ORIGIN);await page.locator('#app-screen:not(.hidden)').waitFor();
 await page.locator('.nav-btn[data-tab="attendance"]').click();await page.locator('[data-event-place="linked"]').click();
 await page.locator('#place-photo-frame').waitFor();assert.equal(await page.locator('#place-photo-frame').innerText(),'写真未登録');
 assert.match(await page.locator('.place-actions a').getAttribute('href'),/google\.com\/maps\/search/);
 await page.locator('#tab-map').screenshot({path:'/tmp/okayama-map-detail.png'});
 await page.locator('#tab-map [data-tab="attendance"]').click();await page.locator('[data-event-place="legacy"]').click();await page.locator('#place-photo-frame').waitFor();
 await page.locator('[data-place-edit]').click();await page.locator('#place-name').fill('変更後の球場');await page.locator('#place-address').fill('岡山市 検証町2');
 await page.locator('#place-photo').setInputFiles({name:'mock.png',mimeType:'image/png',buffer:png});failNextPlaceWrite=true;await page.locator('#place-form button[type=submit]').click();await page.waitForFunction(()=>document.getElementById('place-editor-status').textContent.includes('再試行'));assert.equal(await page.locator('#place-name').inputValue(),'変更後の球場');await page.locator('#place-form button[type=submit]').click();
 await page.locator('#place-editor-modal').waitFor({state:'hidden'});assert.equal(requests.filter(r=>r.method==='PUT').at(-1).body.operationId,requests.filter(r=>r.method==='PUT').at(-2).body.operationId);await page.locator('#place-photo-frame img').waitFor();
 assert.ok(await page.locator('#place-photo-frame img').evaluate(img=>img.complete&&img.naturalWidth>0));
 await page.locator('#tab-map [data-tab="attendance"]').click();await page.locator('[data-event-place="linked"]').click();await page.waitForFunction(()=>document.querySelector('.place-card h3')?.textContent==='変更後の球場');
 // Existing IDs survive renames. Old unmatched text opens the map page with an explicit fallback.
 await page.locator('#tab-map [data-tab="attendance"]').click();await page.locator('[data-event-place="missing"]').click();await page.waitForFunction(()=>document.getElementById('place-status').textContent.includes('該当する登録場所'));
 assert.match(await page.locator('#place-list a').getAttribute('href'),/google\.com\/maps\/search/);
 await page.locator('#tab-map [data-tab="attendance"]').click();await page.locator('#add-event-button').click();await page.locator('#event-place-choice').selectOption(placeId);assert.equal(await page.locator('#event-place').inputValue(),'変更後の球場');
 await page.locator('#event-name').fill('模擬予定');await page.locator('#event-date').fill('2026-12-01T09:00');await page.locator('#save-event-button').click();await page.locator('#event-modal').waitFor({state:'hidden'});assert.equal(eventWrites.at(-1).data.placeId,placeId);
 await page.locator('#add-event-button').click();await page.locator('#event-place-choice').selectOption(placeId);await page.locator('#event-place').fill('直接入力');assert.equal(await page.locator('#event-place-choice').inputValue(),'');await page.locator('#cancel-event-button').click();
 await page.locator('.nav-btn[data-tab="home"]').click();await page.locator('#tab-home [data-tab="map"]').click();await page.locator('#place-add').click();await page.locator('#place-name').fill('<img src=x onerror=alert(1)>');await page.locator('#place-address').fill('検証住所');await page.locator('#place-map-url').fill('https://maps.app.goo.gl/mock');await page.locator('#place-form button[type=submit]').click();await page.locator('#place-editor-modal').waitFor({state:'hidden'});
 assert.equal(await page.locator('.place-card h3 img').count(),0);assert.equal(await page.locator('.place-card h3').innerText(),'<img src=x onerror=alert(1)>');
 assert.equal(await page.locator('.place-actions a').getAttribute('href'),'https://maps.app.goo.gl/mock');
 await page.locator('[data-place-delete]').click();await page.waitForFunction(()=>document.getElementById('place-status').textContent.includes('削除しました'));
 assert.equal((await r2.list({prefix:'map-places/'})).objects.length,2); // one live and one tombstone
 // Members can use all place actions; requests run through the actual Worker.
 await context.addInitScript(()=>window.mockRole='member');await page.reload();await page.locator('#app-screen:not(.hidden)').waitFor();await page.locator('#tab-home [data-tab="map"]').click();await page.locator('[data-place-open]').waitFor();
 assert.equal(await page.locator('#place-add').isVisible(),true);assert.equal(await page.locator('[data-place-edit]').count(),1);assert.equal(await page.locator('[data-place-delete]').count(),1);
 await page.locator('[data-place-open]').click();await page.locator('#place-photo-frame img').waitFor();await page.locator('#tab-map').screenshot({path:'/tmp/okayama-map-member.png'});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 await page.locator('[data-place-edit]').click();await page.locator('#place-name').fill('メンバーが変更した球場');await page.locator('#place-form button[type=submit]').click();await page.locator('#place-editor-modal').waitFor({state:'hidden'});assert.equal(await page.locator('.place-card h3').innerText(),'メンバーが変更した球場');
 await page.locator('#place-add').click();await page.locator('#place-name').fill('メンバー追加の場所');await page.locator('#place-address').fill('岡山市 模擬住所');await page.locator('#place-form button[type=submit]').click();await page.locator('#place-editor-modal').waitFor({state:'hidden'});assert.equal(await page.locator('.place-card h3').innerText(),'メンバー追加の場所');
 await page.locator('[data-place-delete]').click();await page.waitForFunction(()=>document.getElementById('place-status').textContent.includes('削除しました'));assert.equal(await page.locator('.place-card h3').innerText(),'メンバーが変更した球場');

 await page.locator('#logout-button').click();await page.locator('#login-screen:not(.hidden)').waitFor();assert.equal(await page.locator('#place-list').innerHTML(),'');
 assert.deepEqual(errors,[]);console.log('Browser checks passed: real HTML + Worker, mobile viewport, CRUD, original photo, Google links, ID/name navigation, event selection, member permissions, logout.');console.log(JSON.stringify({mockRequests:requests.length,eventWrites:eventWrites.length,screenshots:['/tmp/okayama-map-detail.png','/tmp/okayama-map-member.png']}));
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
