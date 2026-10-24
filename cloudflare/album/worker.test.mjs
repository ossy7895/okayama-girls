import test from 'node:test';
import assert from 'node:assert/strict';
import worker, {PART_BYTES,MAX_IMAGE_BYTES,parseRange,fileSignatureMatches} from './worker.mjs';

const ORIGIN='https://ossy7895.github.io';
const png=new Uint8Array([137,80,78,71,13,10,26,10,0,0,0,0]);
const pair=await crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);
const pem=Buffer.from(await crypto.subtle.exportKey('pkcs8',pair.privateKey)).toString('base64');
const account=JSON.stringify({type:'service_account',project_id:'okayama-girls',client_email:'album-test@okayama-girls.iam.gserviceaccount.com',private_key:`-----BEGIN PRIVATE KEY-----\n${pem}\n-----END PRIVATE KEY-----`});

class MemoryR2 {
  objects=new Map(); uploads=new Map();
  async put(key,value,options={}) {
    const data=typeof value==='string'?new TextEncoder().encode(value):new Uint8Array(value);
    this.objects.set(key,{data,httpMetadata:options.httpMetadata||{},customMetadata:options.customMetadata||{}});
    return this.head(key);
  }
  async head(key) {
    const value=this.objects.get(key);return value?{size:value.data.length,httpMetadata:value.httpMetadata,customMetadata:value.customMetadata}:null;
  }
  async get(key,options={}) {
    const value=this.objects.get(key);if(!value)return null;
    const range=options?.range;
    const data=range?value.data.slice(range.offset,range.offset+range.length):value.data;
    return {...await this.head(key),body:new Blob([data]).stream(),json:async()=>JSON.parse(new TextDecoder().decode(data))};
  }
  async delete(key){this.objects.delete(key);}
  async createMultipartUpload(key,options){const id=crypto.randomUUID();this.uploads.set(id,{key,options,parts:new Map()});return this.resumeMultipartUpload(key,id);}
  resumeMultipartUpload(key,id){
    const upload=this.uploads.get(id);
    return {uploadId:id,
      uploadPart:async(number,data)=>{assert.equal(upload.key,key);const etag='etag-'+number;upload.parts.set(number,{data:new Uint8Array(data),etag});return {partNumber:number,etag};},
      abort:async()=>{assert.ok(upload);this.uploads.delete(id);},
      complete:async(parts)=>{
        assert.equal(upload.key,key);
        for(const p of parts)assert.equal(upload.parts.get(p.partNumber).etag,p.etag);
        const length=parts.reduce((sum,p)=>sum+upload.parts.get(p.partNumber).data.length,0),data=new Uint8Array(length);let offset=0;
        for(const p of parts){const bytes=upload.parts.get(p.partNumber).data;data.set(bytes,offset);offset+=bytes.length;}
        await this.put(key,data,upload.options);this.uploads.delete(id);return this.head(key);
      }
    };
  }
}
function fixture(){
  const docs=new Map([['legacy-photo',{fields:{title:{stringValue:'既存写真'},url:{stringValue:'data:image/jpeg;base64,EXISTING'},createdAt:{integerValue:'100'}}}]]);
  let version=1;const stamp=document=>({...document,updateTime:'version-'+version++});
  for(const [id,document] of docs)docs.set(id,stamp(document));
  const folders=new Map(),state={docs,folders,metadataFails:false,writes:[],calls:[],updateDenied:false,listDenied:false,patches:[]};
  const env={MEDIA:new MemoryR2(),FIREBASE_PROJECT_ID:'okayama-girls',FIREBASE_WEB_API_KEY:'public-test-key',FIREBASE_SERVICE_ACCOUNT:account,MEDIA_SIGNING_KEY:'test-only-signing-key-with-at-least-32-characters',ALLOWED_ORIGIN:ORIGIN};
  state.fetch=async(url,options={})=>{
    state.calls.push(String(url));const target=new URL(url);
    if(target.hostname==='identitytoolkit.googleapis.com'){
      const token=JSON.parse(options.body).idToken;
      return ['admin','admin2','member','stranger'].includes(token)?Response.json({users:[{localId:token}]}):Response.json({error:{}},{status:400});
    }
    if(target.pathname.endsWith('/users/admin'))return Response.json({fields:{role:{stringValue:'admin'}}});
    if(target.pathname.endsWith('/users/admin2'))return Response.json({fields:{role:{stringValue:'admin'}}});
    if(target.pathname.endsWith('/users/member'))return Response.json({fields:{role:{stringValue:'member'}}});
    if(target.pathname.endsWith('/users/stranger'))return Response.json({fields:{role:{stringValue:'other'}}});
    if(target.hostname==='oauth2.googleapis.com'){
      const assertion=new URLSearchParams(options.body).get('assertion');const [header,payload,signature]=assertion.split('.');
      assert.equal(JSON.parse(Buffer.from(payload,'base64url')).aud,'https://oauth2.googleapis.com/token');
      assert.ok(await crypto.subtle.verify('RSASSA-PKCS1-v1_5',pair.publicKey,Buffer.from(signature,'base64url'),new TextEncoder().encode(header+'.'+payload)));
      return Response.json({access_token:'server-token',expires_in:3600});
    }
    if(target.pathname.endsWith('/documents/album')&&options.method==='POST'){
      assert.equal(options.headers.Authorization,'Bearer server-token');
      const id=target.searchParams.get('documentId');
      if(state.metadataFails)return Response.json({error:{}},{status:503});
      if(docs.has(id))return Response.json({error:{}},{status:409});
      const data=stamp(JSON.parse(options.body));docs.set(id,data);state.writes.push(id);return Response.json(data);
    }
    if(target.pathname.endsWith('/documents/albumFolders')&&options.method==='POST'){
      assert.equal(options.headers.Authorization,'Bearer server-token');const id=target.searchParams.get('documentId');
      if(folders.has(id))return Response.json({error:{}},{status:409});
      const data=stamp({...JSON.parse(options.body),name:'projects/okayama-girls/databases/(default)/documents/albumFolders/'+id});folders.set(id,data);return Response.json(data);
    }
    if(target.pathname.endsWith('/documents/albumFolders')&&(!options.method||options.method==='GET')){
      assert.equal(options.headers.Authorization,'Bearer server-token');if(state.listDenied)return Response.json({error:{}},{status:403});
      return Response.json({documents:[...folders.values()]});
    }
    const folderId=target.pathname.match(/\/documents\/albumFolders\/([^/]+)$/)?.[1];
    const mediaId=target.pathname.match(/\/documents\/album\/([^/]+)$/)?.[1];
    if((folderId||mediaId)&&options.method==='PATCH'){
      assert.equal(options.headers.Authorization,'Bearer server-token');if(state.updateDenied)return Response.json({error:{}},{status:403});
      const map=folderId?folders:docs,id=decodeURIComponent(folderId||mediaId),document=map.get(id);if(!document)return Response.json({}, {status:404});
      if(document.updateTime!==target.searchParams.get('currentDocument.updateTime'))return Response.json({}, {status:412});
      const fields=JSON.parse(options.body).fields,masks=target.searchParams.getAll('updateMask.fieldPaths');
      assert.deepEqual(Object.keys(fields).sort(),masks.sort());assert.ok(masks.every(key=>['title','folderId','updatedAt','updatedBy'].includes(key)));
      const updated=stamp({...document,fields:{...document.fields,...fields}});map.set(id,updated);state.patches.push({id,masks});return Response.json(updated);
    }
    if(target.pathname.endsWith('/documents:commit')){
      assert.equal(options.headers.Authorization,'Bearer server-token');if(state.updateDenied)return Response.json({error:{}},{status:403});
      const writes=JSON.parse(options.body).writes;
      for(const write of writes){const id=write.update.name.split('/').pop();assert.deepEqual(write.updateMask.fieldPaths.sort(),['folderId','updatedAt','updatedBy'].sort());if(docs.get(id)?.updateTime!==write.currentDocument.updateTime)return Response.json({}, {status:412});}
      for(const write of writes){const id=write.update.name.split('/').pop(),document=docs.get(id);docs.set(id,stamp({...document,fields:{...document.fields,...write.update.fields}}));}
      return Response.json({writeResults:writes.map(()=>({updateTime:'committed'}))});
    }
    if(folderId)return folders.has(folderId)?Response.json(folders.get(folderId)):Response.json({}, {status:404});
    const id=target.pathname.match(/\/documents\/album\/([^/]+)$/)?.[1];
    if(id)return docs.has(id)?Response.json(docs.get(id)):Response.json({error:{}},{status:404});
    throw new Error('Unexpected external request: '+url);
  };
  return {env,state};
}
async function runFixture(work){const f=fixture(),previous=globalThis.fetch;globalThis.fetch=f.state.fetch;try{return await work(f);}finally{globalThis.fetch=previous;}}
const api=(env,path,{token='admin',method='POST',body,origin=ORIGIN,headers={}}={})=>worker.fetch(new Request('https://album.example'+path,{method,headers:{...(token?{Authorization:'Bearer '+token}:{}),...(origin?{Origin:origin}:{}),'Content-Type':body instanceof Uint8Array?'application/octet-stream':'application/json',...headers},body:body===undefined?undefined:body instanceof Uint8Array?body:JSON.stringify(body)}),env);
async function start(env,options={}){const response=await api(env,'/uploads',{body:{name:'写真.png',title:'練習',size:png.length,type:'image/png',...options}});assert.equal(response.status,201);return response.json();}
async function put(env,upload,number=1,data=png){const response=await api(env,`/uploads/${upload.id}/parts/${number}`,{method:'PUT',body:data});assert.equal(response.status,200);return response.json();}
async function finish(env,upload,parts){return api(env,`/uploads/${upload.id}/complete`,{body:{parts}});}

test('authentication and role checks reject anonymous, invalid, member and unknown-role writes',()=>runFixture(async({env,state})=>{
  for(const [token,status] of [[null,401],['invalid',401],['member',403],['stranger',403]])assert.equal((await api(env,'/uploads',{token,body:{}})).status,status);
  assert.equal(env.MEDIA.objects.size,0);assert.equal(state.writes.length,0);
}));
test('unapproved origins and absent configuration fail closed',()=>runFixture(async({env})=>{
  const response=await api(env,'/uploads',{origin:'https://other.example',body:{}});assert.equal(response.status,403);assert.equal(response.headers.get('Access-Control-Allow-Origin'),null);
  assert.equal((await api({...env,FIREBASE_SERVICE_ACCOUNT:''},'/health',{method:'GET',token:null})).status,503);
  const preflight=await api(env,'/uploads',{method:'OPTIONS',token:null});assert.equal(preflight.status,204);assert.equal(preflight.headers.get('Access-Control-Allow-Origin'),ORIGIN);
}));
test('another administrator cannot resume, finish or abort somebody else\'s upload',()=>runFixture(async({env})=>{
  const upload=await start(env);
  for(const [path,method,body] of [[`/uploads/${upload.id}/parts/1`,'PUT',png],[`/uploads/${upload.id}/complete`,'POST',{parts:[]}],[`/uploads/${upload.id}`,'DELETE',undefined]])assert.equal((await api(env,path,{token:'admin2',method,body})).status,403);
  assert.equal(env.MEDIA.uploads.size,1);assert.equal(env.MEDIA.objects.size,1);
}));
test('file type, maximum size, content signature and multipart length are checked server-side',()=>runFixture(async({env})=>{
  assert.equal((await api(env,'/uploads',{body:{name:'bad.svg',title:'',type:'image/svg+xml',size:20}})).status,415);
  assert.equal((await api(env,'/uploads',{body:{name:'big.png',title:'',type:'image/png',size:MAX_IMAGE_BYTES+1}})).status,413);
  const upload=await start(env);
  assert.equal((await api(env,`/uploads/${upload.id}/parts/1`,{method:'PUT',body:new Uint8Array(png.length)})).status,415);
  assert.equal((await api(env,`/uploads/${upload.id}/parts/1`,{method:'PUT',body:png.slice(0,8)})).status,400);
  assert.equal((await api(env,`/uploads/${upload.id}`,{method:'DELETE'})).status,200);
  assert.equal(env.MEDIA.uploads.size,0);assert.equal(env.MEDIA.objects.size,0);
}));
test('uploads add new metadata once, leave legacy photos untouched, and reject completed-media deletion',()=>runFixture(async({env,state})=>{
  const legacy=JSON.stringify(state.docs.get('legacy-photo'));const upload=await start(env),part=await put(env,upload);
  assert.equal((await finish(env,upload,[part])).status,200);
  assert.equal((await finish(env,upload,[part])).status,200);
  const fields=state.docs.get(upload.id).fields;
  assert.equal(fields.objectKey.stringValue,'album-media/'+upload.id);assert.equal(fields.source.stringValue,'r2');assert.equal(fields.uploadedBy.stringValue,'admin');assert.equal(fields.size.integerValue,String(png.length));
  assert.equal(state.writes.length,1);assert.equal(JSON.stringify(state.docs.get('legacy-photo')),legacy);
  assert.equal((await api(env,`/uploads/${upload.id}`,{method:'DELETE'})).status,409);
  assert.ok(await env.MEDIA.head('album-media/'+upload.id));
}));
test('metadata outages retain the completed media and allow a safe completion retry',()=>runFixture(async({env,state})=>{
  const upload=await start(env),part=await put(env,upload);state.metadataFails=true;
  assert.equal((await finish(env,upload,[part])).status,503);assert.ok(await env.MEDIA.head('album-media/'+upload.id));assert.equal(state.docs.size,1);
  state.metadataFails=false;assert.equal((await finish(env,upload,[part])).status,200);assert.equal(state.docs.size,2);assert.equal(state.writes.length,1);
}));
test('members can obtain expiring media tickets; unsigned, tampered and expired URLs are rejected',()=>runFixture(async({env})=>{
  const upload=await start(env),part=await put(env,upload);await finish(env,upload,[part]);
  assert.equal((await api(env,`/media/${upload.id}/access`,{token:null})).status,401);
  const response=await api(env,`/media/${upload.id}/access`,{token:'member'});assert.equal(response.status,200);const ticket=await response.json(),url=new URL(ticket.url);
  const full=await worker.fetch(new Request(url),env);assert.equal(full.status,200);assert.equal(full.headers.get('Cache-Control'),'private, no-store');assert.deepEqual(new Uint8Array(await full.arrayBuffer()),png);
  const range=await worker.fetch(new Request(url,{headers:{Range:'bytes=0-3'}}),env);assert.equal(range.status,206);assert.equal(range.headers.get('Content-Range'),'bytes 0-3/'+png.length);assert.equal((await range.arrayBuffer()).byteLength,4);
  const invalid=await worker.fetch(new Request(url,{headers:{Range:'bytes=999-'}}),env);assert.equal(invalid.status,416);assert.equal(invalid.headers.get('Content-Range'),'bytes */'+png.length);
  assert.equal((await worker.fetch(new Request(url,{method:'HEAD'}),env)).headers.get('Content-Length'),String(png.length));
  const forged=new URL(url);forged.searchParams.set('signature','tampered');assert.equal((await worker.fetch(new Request(forged),env)).status,403);
  const expired=new URL(url);expired.searchParams.set('expires','1');assert.equal((await worker.fetch(new Request(expired),env)).status,403);
  assert.equal((await api(env,'/media/legacy-photo/access',{token:'member'})).status,404);
}));
test('large videos use uniform chunks and cannot complete with omitted or duplicate parts',()=>runFixture(async({env,state})=>{
  const first=new Uint8Array(PART_BYTES);first.set([0,0,0,24,102,116,121,112,105,115,111,109]);
  const upload=await start(env,{name:'試合.mp4',type:'video/mp4',size:PART_BYTES+1});
  const p1=await put(env,upload,1,first),p2=await put(env,upload,2,new Uint8Array([0]));
  assert.equal((await finish(env,upload,[p1])).status,400);assert.equal((await finish(env,upload,[p1,p1])).status,400);
  assert.equal((await finish(env,upload,[p1,p2])).status,200);assert.equal(state.docs.get(upload.id).fields.mediaType.stringValue,'video');
}));
test('range parser and allowed signatures handle suffix ranges and reject active formats',()=>{
  assert.deepEqual(parseRange('bytes=-3',10),{offset:7,length:3});assert.deepEqual(parseRange('bytes=3-',10),{offset:3,length:7});
  assert.throws(()=>parseRange('bytes=0-1,3-4',10));assert.throws(()=>parseRange('bytes=-0',10));
  assert.equal(fileSignatureMatches('image/png',png),true);assert.equal(fileSignatureMatches('image/svg+xml',new TextEncoder().encode('<svg/>')),false);
});
test('folder creation/listing/renaming is role checked and idempotent without delete access',()=>runFixture(async({env,state})=>{
  const id=crypto.randomUUID();
  assert.equal((await api(env,'/folders',{token:'member',body:{id,title:'練習'}})).status,403);
  assert.equal((await api(env,'/folders',{token:null,method:'GET'})).status,401);
  assert.equal((await api(env,'/folders',{body:{id,title:'練習'}})).status,201);
  assert.equal((await api(env,'/folders',{body:{id,title:'練習'}})).status,200);assert.equal(state.folders.size,1);
  const list=await api(env,'/folders',{method:'GET',token:'member'});assert.equal(list.status,200);assert.equal((await list.json()).folders[0].title,'練習');
  const old=state.folders.get(id).updateTime;
  assert.equal((await api(env,'/folders/'+id,{method:'PATCH',body:{title:'大会',updateTime:old}})).status,200);
  assert.equal(state.folders.get(id).fields.title.stringValue,'大会');
  assert.equal((await api(env,'/folders/'+id,{method:'PATCH',body:{title:'競合',updateTime:old}})).status,409);
  assert.equal((await api(env,'/folders/'+id,{method:'DELETE'})).status,404);
}));
test('legacy photo titles and folder membership can change both ways without changing the photo or its timestamp',()=>runFixture(async({env,state})=>{
  const id=crypto.randomUUID();await api(env,'/folders',{body:{id,title:'大会'}});
  const original=structuredClone(state.docs.get('legacy-photo').fields);
  assert.equal((await api(env,'/media/legacy-photo',{token:'member',method:'PATCH',body:{title:'不可',folderId:id}})).status,403);
  assert.equal((await api(env,'/media/legacy-photo',{method:'PATCH',body:{title:'集合写真',folderId:id}})).status,200);
  let fields=state.docs.get('legacy-photo').fields;assert.equal(fields.title.stringValue,'集合写真');assert.equal(fields.folderId.stringValue,id);
  assert.deepEqual(fields.url,original.url);assert.deepEqual(fields.createdAt,original.createdAt);
  assert.equal((await api(env,'/media/legacy-photo',{method:'PATCH',body:{folderId:''}})).status,200);
  fields=state.docs.get('legacy-photo').fields;assert.equal(fields.folderId.stringValue,'');assert.equal(fields.title.stringValue,'集合写真');assert.deepEqual(fields.url,original.url);
  for(const body of [{url:'bad'},{source:'bad'},{objectKey:'bad'},{title:''},{folderId:'../bad'}])assert.equal((await api(env,'/media/legacy-photo',{method:'PATCH',body})).status,400);
  assert.equal((await api(env,'/media/missing',{method:'PATCH',body:{title:'missing'}})).status,404);
  assert.equal(env.MEDIA.objects.size,0);
}));
test('bulk moves are atomic per batch, preserve titles, reject duplicates and support returning to photos',()=>runFixture(async({env,state})=>{
  const id=crypto.randomUUID();await api(env,'/folders',{body:{id,title:'まとめ'}});
  state.docs.set('second',{fields:{title:{stringValue:'別写真'},url:{stringValue:'keep'}},updateTime:'second-1'});
  assert.equal((await api(env,'/media/move',{token:'member',body:{ids:['legacy-photo'],folderId:id}})).status,403);
  assert.equal((await api(env,'/media/move',{body:{ids:['legacy-photo','missing'],folderId:id}})).status,404);assert.equal(state.docs.get('legacy-photo').fields.folderId,undefined);
  assert.equal((await api(env,'/media/move',{body:{ids:['legacy-photo','legacy-photo'],folderId:id}})).status,400);
  assert.equal((await api(env,'/media/move',{body:{ids:['legacy-photo','second'],folderId:id}})).status,200);
  assert.equal(state.docs.get('second').fields.title.stringValue,'別写真');assert.equal(state.docs.get('legacy-photo').fields.folderId.stringValue,id);
  assert.equal((await api(env,'/media/move',{body:{ids:['legacy-photo','second'],folderId:''}})).status,200);assert.equal(state.docs.get('second').fields.folderId.stringValue,'');
}));
test('upload destinations are validated before creating R2 objects; new IAM failures are actionable',()=>runFixture(async({env,state})=>{
  assert.equal((await api(env,'/uploads',{body:{name:'x.png',title:'',size:png.length,type:'image/png',folderId:crypto.randomUUID()}})).status,404);assert.equal(env.MEDIA.objects.size,0);
  const id=crypto.randomUUID();await api(env,'/folders',{body:{id,title:'保存先'}});const upload=await start(env,{folderId:id});await finish(env,upload,[await put(env,upload)]);assert.equal(state.docs.get(upload.id).fields.folderId.stringValue,id);
  state.updateDenied=true;const denied=await api(env,'/media/legacy-photo',{method:'PATCH',body:{title:'編集'}});assert.equal(denied.status,503);assert.equal((await denied.json()).error,'metadata_permissions_required');
  state.listDenied=true;assert.equal((await api(env,'/folders',{method:'GET'})).status,503);
}));
