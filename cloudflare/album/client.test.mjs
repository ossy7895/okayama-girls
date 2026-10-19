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
  const state={docs:[],queries:[],requests:[],created:[],completed:new Set(),chunks:[],failName:'',refreshes:[],next:1};
  const user={uid:'admin',getIdToken:async force=>{state.refreshes.push(force);return 'firebase-test-token';}};
  const context={document,appScreen:document.getElementById('app-screen'),auth:{currentUser:user},currentRole:'admin',db:{},AbortController,DOMException,URL,Response,Blob,console,setTimeout:work=>queueMicrotask(work),
    collection:(db,path)=>path,orderBy:(key,direction)=>({key,direction}),limit:n=>({limit:n}),startAfter:doc=>({after:doc.id}),query:(path,...clauses)=>({path,clauses}),
    getDocs:async query=>{state.queries.push(query);const after=query.clauses.find(c=>c.after)?.after;const from=after?state.docs.findIndex(d=>d.id===after)+1:0;const count=query.clauses.find(c=>c.limit)?.limit??24;return {docs:state.docs.slice(from,from+count).map(d=>({id:d.id,data:()=>d}))};},
    fetch:async(url,options)=>{
      state.requests.push({url,options});assert.equal(options.headers.Authorization,'Bearer firebase-test-token');
      const path=new URL(url).pathname,body=options.body?JSON.parse(options.body):null;
      if(path==='/uploads'){
        const id='upload-'+state.next++;state.created.push({id,...body});return Response.json({id,partSize:4,partCount:Math.ceil(body.size/4)},{status:201});
      }
      const complete=path.match(/^\/uploads\/([^/]+)\/complete$/);
      if(complete){
        const upload=state.created.find(u=>u.id===complete[1]);
        if(upload.name===state.failName)return Response.json({error:'metadata_unavailable'},{status:503});
        if(!state.completed.has(upload.id)){state.completed.add(upload.id);state.docs.push({id:upload.id,title:upload.title||upload.name,source:'r2',mediaType:'image',createdAt:Date.now()});}
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
  const loading=context.loadAlbum();context.auth.currentUser=null;context.resetAlbum();
  resolve({docs:[{id:'private',data:()=>({title:'private'})}]});await loading;assert.equal(element('album-gallery').children.length,0);
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
