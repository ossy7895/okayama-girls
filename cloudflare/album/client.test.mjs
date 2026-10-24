import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const html=readFileSync(new URL('../../index.html',import.meta.url),'utf8');
const start=html.indexOf('    // Public Worker URL only.');
const end=html.indexOf('    function switchTab(',start);
assert.ok(start>=0&&end>start);
const source=html.slice(start,end).replace(/const ALBUM_API_BASE = "[^"]*";/,'const ALBUM_API_BASE = "https://album.example";');

class Element {
  constructor(tag='div',doc){this.tagName=tag;this.doc=doc;this.children=[];this.listeners={};this.value='';this.files=[];this.disabled=false;this._text='';this.flags=new Set();this.isConnected=true;this.classList={add:(...names)=>names.forEach(n=>this.flags.add(n)),remove:(...names)=>names.forEach(n=>this.flags.delete(n)),contains:n=>this.flags.has(n),toggle:(name,force)=>{const on=force??!this.flags.has(name);on?this.flags.add(name):this.flags.delete(name);return on;}};}
  set textContent(value){this._text=String(value);this.children=[];}
  get textContent(){return this._text+this.children.map(c=>c.textContent).join('');}
  set innerHTML(value){throw new Error('Untrusted album content must not use innerHTML');}
  append(...nodes){this.children.push(...nodes);}
  replaceChildren(...nodes){this._text='';this.children=nodes;}
  addEventListener(name,work){(this.listeners[name]??=[]).push(work);}
  setAttribute(name,value){this[name]=value;}
  focus(){this.doc.activeElement=this;}
  pause(){this.paused=true;}
  querySelector(tag){for(const child of this.children){if(child.tagName===tag)return child;const nested=child.querySelector(tag);if(nested)return nested;}return null;}
}
function fixture(){
  const elements=new Map();const document={activeElement:null,getElementById(id){if(!elements.has(id))elements.set(id,new Element('div',document));return elements.get(id);},createElement(tag){return new Element(tag,document);}};
  const state={docs:[],folders:[],backend:true,deletionFeature:true,pendingDeletions:[],queries:[],requests:[],created:[],completed:new Set(),chunks:[],failName:'',refreshes:[],next:1};
  const user={uid:'admin',getIdToken:async force=>{state.refreshes.push(force);return 'firebase-test-token';}};
  const context={document,appScreen:document.getElementById('app-screen'),auth:{currentUser:user},currentRole:'admin',db:{},AbortController,DOMException,URL,Response,Blob,crypto,console,setTimeout:work=>queueMicrotask(work),
    collection:(db,path)=>path,orderBy:(key,direction)=>({key,direction}),where:(key,operator,value)=>({where:key,value}),limit:n=>({limit:n}),startAfter:doc=>({after:doc.id}),query:(path,...clauses)=>({path,clauses}),
    getDocs:async query=>{state.queries.push(query);const filter=query.clauses.find(c=>c.where);const docs=filter?state.docs.filter(d=>d[filter.where]===filter.value):state.docs;const after=query.clauses.find(c=>c.after)?.after;const from=after?docs.findIndex(d=>d.id===after)+1:0;const count=query.clauses.find(c=>c.limit)?.limit??24;return {docs:docs.slice(from,from+count).map(d=>({id:d.id,data:()=>d}))};},
    fetch:async(url,options)=>{
      state.requests.push({url,options});assert.equal(options.headers.Authorization,'Bearer firebase-test-token');
      const path=new URL(url).pathname,body=options.body?JSON.parse(options.body):null;
      if(path==='/folders'){
        if(!state.backend)return Response.json({error:'not_found'},{status:404});
        if(options.method==='GET')return Response.json({folders:state.folders,nextPageToken:'',features:{mediaDeletion:state.deletionFeature,folderDeletion:state.deletionFeature},pendingDeletions:state.pendingDeletions});
        const folder={...body,updateTime:'folder-v1'};state.folders.push(folder);return Response.json(folder,{status:201});
      }
      if(path.startsWith('/folders/')&&options.method==='PATCH'){const folder=state.folders.find(f=>f.id===path.split('/').pop());folder.title=body.title;return Response.json(folder);}
      if(path.endsWith('/delete-preview')){
        const id=path.split('/')[2],folder=path.startsWith('/folders/'),item=(folder?state.folders:state.docs).find(d=>d.id===id);return Response.json({id,type:folder?'folder':'media',title:item.title,updateTime:'confirmed-version',count:folder?state.docs.filter(d=>d.folderId===id&&!d.deleted).length:undefined,keepsMedia:folder});
      }
      if(options.method==='DELETE'&&path.startsWith('/media/')){const id=path.split('/')[2],item=state.docs.find(d=>d.id===id);assert.equal(body.updateTime,'confirmed-version');item.deleted=true;delete item.url;return Response.json({id,done:true});}
      if(options.method==='DELETE'&&path.startsWith('/folders/')){const id=path.split('/')[2];let returned=0;for(const item of state.docs)if(item.folderId===id){item.folderId='';returned++;}state.folders=state.folders.filter(d=>d.id!==id);return Response.json({id,done:true,returned});}
      if(path==='/media/move'){for(const id of body.ids)state.docs.find(d=>d.id===id).folderId=body.folderId;return Response.json({ids:body.ids,folderId:body.folderId});}
      if(path.startsWith('/media/')&&options.method==='PATCH'){const item=state.docs.find(d=>d.id===path.split('/').pop());Object.assign(item,body);return Response.json(item);}
      if(path==='/uploads'){
        const id='upload-'+state.next++;state.created.push({id,...body});return Response.json({id,partSize:4,partCount:Math.ceil(body.size/4)},{status:201});
      }
      const complete=path.match(/^\/uploads\/([^/]+)\/complete$/);
      if(complete){
        const upload=state.created.find(u=>u.id===complete[1]);
        if(upload.name===state.failName)return Response.json({error:'metadata_unavailable'},{status:503});
        if(!state.completed.has(upload.id)){state.completed.add(upload.id);state.docs.push({id:upload.id,title:upload.title||upload.name,source:'r2',mediaType:'image',createdAt:Date.now(),folderId:upload.folderId||''});}
        return Response.json({id:upload.id});
      }
      if(path.endsWith('/access'))return Response.json({url:'https://album.example/objects/test?signature=short-lived-ticket',expiresAt:Date.now()+900000});
      if(options.method==='DELETE')return Response.json({cancelled:true});
      return Response.json({ready:true});
    }
  };
  context.window={__ogUpdateWrites:0,__ogUpdateWrite:async work=>{context.window.__ogUpdateWrites++;try{return await work();}finally{context.window.__ogUpdateWrites--;}}};
  context.XMLHttpRequest=class{
    constructor(){this.upload={};this.headers={};}
    open(method,url){this.method=method;this.url=url;}
    setRequestHeader(name,value){this.headers[name]=value;}
    abort(){this.aborted=true;this.onabort?.();}
    send(blob){
      state.chunks.push({url:this.url,size:blob.size,updatesBlocked:context.window.__ogUpdateWrites>0});
      queueMicrotask(()=>{if(this.aborted)return;this.upload.onprogress?.({loaded:blob.size});this.status=200;this.responseText=JSON.stringify({partNumber:Number(this.url.split('/').pop()),etag:'part-'+this.url.split('/').pop()});this.onload();});
    }
  };
  vm.createContext(context);vm.runInContext(source,context);
  const element=id=>document.getElementById(id);
  return {context,state,element,click:async id=>{for(const handler of element(id).listeners.click||[])await handler();}};
}
function file(name){const blob=new Blob(['123456'],{type:'image/png'});return {name,type:'image/png',size:blob.size,lastModified:1,slice:(...args)=>blob.slice(...args)};}

test('upload controls follow the logged-in administrator role',()=>{
  const {context,element}=fixture();context.configureAlbumRole();assert.equal(element('album-upload-panel').classList.contains('hidden'),false);
  context.currentRole='member';context.configureAlbumRole();assert.equal(element('album-upload-panel').classList.contains('hidden'),true);assert.equal(element('album-upload-button').disabled,true);
  context.currentRole='admin';context.auth.currentUser=null;context.configureAlbumRole();assert.equal(element('album-upload-panel').classList.contains('hidden'),true);
});
test('gallery pagination retains existing data and renders document text without HTML injection',async()=>{
  const {context,state,element}=fixture();state.docs=Array.from({length:25},(_,i)=>({id:'photo-'+i,title:i===0?'<img onerror=alert(1)>':'写真'+i,url:'data:image/jpeg;base64,/9j/AA==',createdAt:100-i}));
  await context.loadAlbum();assert.equal(element('album-gallery').children.length,24);assert.equal(element('album-load-more').classList.contains('hidden'),false);
  assert.ok(element('album-gallery').children[0].textContent.includes('<img onerror=alert(1)>'));
  await context.loadAlbum(true);assert.equal(element('album-gallery').children.length,25);assert.equal(element('album-load-more').classList.contains('hidden'),true);assert.equal(state.docs.length,25);
  assert.equal(context.legacyAlbumUrl('javascript:alert(1)'),'');assert.equal(context.legacyAlbumUrl('data:image/svg+xml;base64,AA=='),'');
});
test('a late gallery response after logout cannot reinsert private photos',async()=>{
  const {context,element}=fixture();let resolve;
  context.getDocs=()=>new Promise(done=>{resolve=done;});
  const loading=context.loadAlbum();for(let i=0;i<10&&!resolve;i++)await new Promise(setImmediate);assert.ok(resolve);context.auth.currentUser=null;context.resetAlbum();
  resolve({docs:[{id:'private',data:()=>({title:'private'})}]});await loading;assert.equal(element('album-gallery').children.length,0);
});
test('photo and folder tabs are exclusive even when the first page consists entirely of folder items',async()=>{
  const {context,state,element}=fixture();state.folders=[{id:'folder-a',title:'練習'}];
  state.docs=Array.from({length:30},(_,i)=>({id:'grouped-'+i,title:'フォルダ写真'+i,folderId:'folder-a',createdAt:100-i}));
  state.docs.push({id:'loose',title:'単体写真',url:'data:image/jpeg;base64,/9j/AA==',createdAt:1});
  await context.loadAlbum();assert.equal(element('album-gallery').children.length,1);assert.ok(element('album-gallery').textContent.includes('単体写真'));assert.ok(!element('album-gallery').textContent.includes('フォルダ写真'));
  await context.setAlbumView('folders','folder-a');assert.equal(element('album-gallery').children.length,24);assert.ok(!element('album-gallery').textContent.includes('単体写真'));
  await context.loadAlbum(true);assert.equal(element('album-gallery').children.length,30);
  await context.setAlbumView('photos');assert.equal(element('album-gallery').children.length,1);
});
test('title and destination edits move a legacy photo into a folder, between folders, and back without duplication',async()=>{
  const {context,state,element}=fixture();state.folders=[{id:'a',title:'練習'},{id:'b',title:'大会'}];const url='data:image/jpeg;base64,/9j/AA==';state.docs=[{id:'legacy',title:'元のタイトル',url,createdAt:1}];
  await context.loadAlbum();context.openAlbumEditor('item',state.docs[0],element('edit'));
  element('album-editor-title').value='変更したタイトル';element('album-editor-folder').value='a';await context.saveAlbumEditor();assert.equal(element('album-gallery').children.length,0);assert.equal(state.docs[0].title,'変更したタイトル');
  await context.setAlbumView('folders','a');assert.equal(element('album-gallery').children.length,1);
  context.openAlbumEditor('item',state.docs[0],element('edit'));element('album-editor-folder').value='b';await context.saveAlbumEditor();assert.equal(element('album-gallery').children.length,0);
  await context.setAlbumView('folders','b');assert.equal(element('album-gallery').children.length,1);
  context.openAlbumEditor('item',state.docs[0],element('edit'));element('album-editor-folder').value='';await context.saveAlbumEditor();assert.equal(element('album-gallery').children.length,0);
  await context.setAlbumView('photos');assert.equal(element('album-gallery').children.length,1);assert.equal(state.docs.length,1);assert.equal(state.docs[0].url,url);assert.equal(state.docs[0].createdAt,1);
});
test('folders can be created and renamed; members see folders without editing controls',async()=>{
  const {context,state,element}=fixture();await context.setAlbumView('folders');context.openAlbumEditor('create',null,element('create'));element('album-editor-title').value='新しいフォルダ';await context.saveAlbumEditor();assert.equal(state.folders.length,1);
  context.openAlbumEditor('folder',state.folders[0],element('rename'));element('album-editor-title').value='変更後';await context.saveAlbumEditor();assert.equal(state.folders[0].title,'変更後');assert.ok(element('album-folder-list').textContent.includes('変更後'));
  context.currentRole='member';await context.setAlbumView('folders');assert.equal(element('album-create-folder').classList.contains('hidden'),true);assert.equal(element('album-folder-list').children[0].children.length,1);
  context.openAlbumEditor('create',null,element('create'));assert.equal(element('album-editor-modal').classList.contains('hidden'),true);
});
test('multiple selected photos move as a batch and disappear from the ungrouped tab',async()=>{
  const {context,state,element,click}=fixture();state.folders=[{id:'a',title:'まとめ'}];state.docs=[{id:'one',title:'一枚目'},{id:'two',title:'二枚目'}];await context.loadAlbum();
  for(const card of element('album-gallery').children){const box=card.children[1];box.checked=true;for(const handler of box.listeners.change)handler();}
  await click('album-move-selected');element('album-editor-folder').value='a';await context.saveAlbumEditor();assert.equal(element('album-gallery').children.length,0);assert.ok(state.docs.every(d=>d.folderId==='a'));
  assert.equal(state.requests.filter(r=>r.url.endsWith('/media/move')).length,1);
});
test('an older Worker keeps legacy viewing available and hides unsupported editing instead of making fake changes',async()=>{
  const {context,state,element}=fixture();state.backend=false;state.docs=[{id:'old',title:'既存写真'}];await context.loadAlbum();assert.equal(element('album-gallery').children.length,1);assert.equal(element('album-gallery').children[0].children.length,1);assert.equal(element('album-selection-bar').classList.contains('hidden'),true);assert.ok(element('album-feature-status').textContent.includes('サーバー更新待ち'));
});
test('photos and videos are viewed with header-authenticated ticket requests, not Firebase tokens in URLs',async()=>{
  const {context,state,element}=fixture();const button=element('example-card');
  await context.openAlbumMedia({id:'new-photo',source:'r2',title:'練習',mediaType:'image'},button);
  assert.equal(context.appScreen.inert,true);assert.equal(element('album-viewer-content').children[0].tagName,'img');
  assert.equal(state.requests[0].options.headers.Authorization,'Bearer firebase-test-token');assert.ok(!state.requests[0].url.includes('firebase-test-token'));
  context.closeAlbumViewer();assert.equal(context.appScreen.inert,false);assert.equal(element('album-viewer-content').children.length,0);
  await context.openAlbumMedia({id:'new-video',source:'r2',title:'試合',mediaType:'video'},button);assert.equal(element('album-viewer-content').children[0].controls,true);
});
test('file batches are chunked with progress while the existing automatic-update guard is held',async()=>{
  const {context,state,element,click}=fixture();element('album-upload-files').files=[file('練習.png')];
  await click('album-upload-button');assert.deepEqual(state.chunks.map(c=>c.size),[4,2]);assert.ok(state.chunks.every(c=>c.updatesBlocked));assert.equal(context.window.__ogUpdateWrites,0);
  assert.equal(state.completed.size,1);assert.equal(element('album-upload-status').textContent,'1件のアップロードが完了しました。');assert.equal(element('album-upload-progress').value,100);
});
test('metadata failures retry completion without reuploading successful files or finished media',async()=>{
  const {state,element,click}=fixture();element('album-upload-files').files=[file('first.png'),file('second.png')];state.failName='second.png';
  await click('album-upload-button');assert.equal(state.created.length,2);assert.equal(state.completed.size,1);assert.equal(state.chunks.length,4);
  state.failName='';await click('album-upload-button');assert.equal(state.created.length,2);assert.equal(state.completed.size,2);assert.equal(state.chunks.length,4);
});
test('unsupported or oversize files never reach the API',async()=>{
  const {state,element,click}=fixture();element('album-upload-files').files=[{...file('bad.svg'),type:'image/svg+xml'}];
  await click('album-upload-button');assert.equal(state.requests.length,0);assert.ok(element('album-upload-status').textContent.includes('対応していない'));
  element('album-upload-files').files=[{...file('big.png'),size:26*1024**2}];await click('album-upload-button');assert.equal(state.requests.length,0);
});

test('media deletion opens a named confirmation, cancel does not delete, and confirmed deletion refreshes the gallery',async()=>{
  const {context,state,element}=fixture();state.docs=[{id:'one',title:'削除対象',url:'data:image/jpeg;base64,/9j/AA=='},{id:'two',title:'保持する写真'}];await context.loadAlbum();
  await context.openAlbumDeletion('media',state.docs[0],element('remove'));assert.equal(context.appScreen.inert,true);assert.equal(element('album-delete-name').textContent,'削除対象');assert.ok(element('album-delete-description').textContent.includes('元に戻せません'));assert.equal(state.requests.filter(r=>r.options.method==='DELETE').length,0);
  context.closeAlbumDeletion();assert.equal(context.appScreen.inert,false);assert.equal(state.docs[0].deleted,undefined);
  await context.openAlbumDeletion('media',state.docs[0],element('remove'));await context.confirmAlbumDeletion();assert.equal(state.docs[0].deleted,true);assert.equal(state.docs[1].deleted,undefined);assert.equal(element('album-gallery').children.length,1);assert.ok(element('album-gallery').textContent.includes('保持する写真'));
});
test('folder deletion clearly preserves media and returns the existing records to the photos tab',async()=>{
  const {context,state,element}=fixture();state.folders=[{id:'a',title:'削除するフォルダ'}];state.docs=[{id:'one',title:'残す写真',folderId:'a',url:'keep'}];await context.setAlbumView('folders','a');
  await context.openAlbumDeletion('folder',state.folders[0],element('remove'));assert.ok(element('album-delete-description').textContent.includes('削除せず'));assert.ok(element('album-delete-description').textContent.includes('1件'));assert.equal(element('album-delete-confirm').textContent,'フォルダだけ削除する');
  await context.confirmAlbumDeletion();assert.equal(state.folders.length,0);assert.equal(state.docs.length,1);assert.equal(state.docs[0].url,'keep');assert.equal(state.docs[0].folderId,'');assert.equal(state.docs[0].deleted,undefined);assert.equal(element('album-gallery').children.length,1);
});
test('deletion is hidden for members and unavailable until the server advertises support',async()=>{
  const {context,state,element}=fixture();state.docs=[{id:'one',title:'既存写真'}];state.deletionFeature=false;await context.loadAlbum();assert.ok(element('album-deletion-status').textContent.includes('サーバー更新待ち'));await context.openAlbumDeletion('media',state.docs[0],element('remove'));assert.equal(state.requests.some(r=>r.url.includes('delete-preview')),false);
  context.currentRole='member';state.deletionFeature=true;await context.loadAlbum();assert.equal(element('album-gallery').children[0].children.length,1);assert.equal(element('album-pending-deletions').classList.contains('hidden'),true);await context.openAlbumDeletion('media',state.docs[0],element('remove'));assert.equal(state.requests.some(r=>r.url.includes('delete-preview')),false);
});
test('deleted rows are skipped during pagination, and media with a removed folder remains visible in photos',async()=>{
  const {context,state,element}=fixture();state.docs=Array.from({length:25},(_,i)=>({id:'gone-'+i,title:'削除済み',deleted:true}));state.docs.push({id:'remaining',title:'フォルダがなくても残る',folderId:'removed-folder'});await context.loadAlbum();assert.equal(element('album-gallery').children.length,1);assert.ok(element('album-gallery').textContent.includes('フォルダがなくても残る'));assert.ok(!element('album-gallery').textContent.includes('削除済み'));
});
test('a deletion preview arriving after logout cannot enable deletion or expose its title',async()=>{
  const {context,state,element}=fixture();state.docs=[{id:'one',title:'private'}];await context.loadAlbum();let resolve;
  context.fetch=()=>new Promise(done=>{resolve=done;});const opening=context.openAlbumDeletion('media',state.docs[0],element('remove'));for(let i=0;i<10&&!resolve;i++)await new Promise(setImmediate);assert.ok(resolve);context.auth.currentUser=null;context.resetAlbum();resolve(Response.json({id:'one',title:'late private title',updateTime:'v1'}));await opening;assert.equal(element('album-delete-modal').classList.contains('hidden'),true);assert.ok(!element('album-delete-name').textContent.includes('late private title'));assert.equal(element('album-delete-confirm').disabled,true);
});
