import test from 'node:test';
import assert from 'node:assert/strict';
import worker from './worker.mjs';
const ORIGIN='https://ossy7895.github.io';
const png=Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0]).toString('base64');
class R2 {
  objects=new Map();writes=[];removed=[];sequence=0;race=false;failCleanup=false;
  async get(key){const o=this.objects.get(key);return o?{...o,body:o.value,json:async()=>JSON.parse(o.value)}:null;}
  async put(key,value,options={}){
    const old=this.objects.get(key),condition=options.onlyIf;
    if(condition){if(this.race){this.race=false;return null;}if(condition.etagMatches&&old?.etag!==condition.etagMatches)return null;if(condition instanceof Headers&&old)return null;}
    const object={value,etag:'v'+(++this.sequence),httpMetadata:options.httpMetadata};this.objects.set(key,object);this.writes.push(key);return object;
  }
  async delete(key){if(this.failCleanup)throw Error('cleanup unavailable');this.objects.delete(key);this.removed.push(key);}
  async list({prefix,limit,cursor=''}){const keys=[...this.objects.keys()].filter(k=>k.startsWith(prefix)).sort(),start=Number(cursor)||0;return {objects:keys.slice(start,start+limit).map(key=>({key})),truncated:start+limit<keys.length,cursor:String(start+limit)};}
}
function fixture(){
  const r2=new R2(),calls=[];r2.objects.set('album-media/protected',{value:'original',etag:'protected'});r2.objects.set('fee-ledgers/protected',{value:'original',etag:'protected'});
  const env={MEDIA:r2,FIREBASE_WEB_API_KEY:'test',FIREBASE_SERVICE_ACCOUNT:'test-configured-not-a-real-secret',MEDIA_SIGNING_KEY:'test-key-with-at-least-thirty-two-characters',ALLOWED_ORIGIN:ORIGIN};
  globalThis.fetch=async(url,options)=>{
    calls.push(String(url));if(String(url).includes('accounts:lookup')){const token=JSON.parse(options.body).idToken;return ['admin','member','admin2'].includes(token)?Response.json({users:[{localId:token}]}):Response.json({}, {status:400});}
    if(/\/users\/(admin|member|admin2)$/.test(String(url)))return Response.json({fields:{role:{stringValue:String(url).endsWith('/member')?'member':'admin'}}});
    throw Error('Unexpected remote request');
  };
  const api=(path,{method='GET',body,token='admin',origin=ORIGIN}={})=>worker.fetch(new Request('https://worker.test'+path,{method,headers:{Origin:origin,...(token?{Authorization:'Bearer '+token}:{}),'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})}),env);
  const create=async(extra={})=>{const id=crypto.randomUUID(),body={name:'検証球場',address:'岡山市 検証町1',mapUrl:'',version:'',operationId:crypto.randomUUID(),...extra};const response=await api('/places/'+id,{method:'PUT',body});assert.equal(response.status,201);return {id,body,place:await response.json()};};
  const edit=(p,extra={})=>({name:p.name,address:p.address,mapUrl:p.mapUrl,version:p.version,operationId:crypto.randomUUID(),...extra});
  return {r2,api,create,edit,calls};
}
test('anonymous cannot list, read, or access a photo; members cannot write',async()=>{
  const f=fixture(),id=crypto.randomUUID();for(const path of ['/places','/places/'+id,'/places/'+id+'/photo'])assert.equal((await f.api(path,{token:''})).status,401);
  for(const method of ['PUT','DELETE'])assert.equal((await f.api('/places/'+id,{method,body:{},token:'member'})).status,403);assert.equal(f.r2.writes.length,0);
});
test('wrong origin is rejected before authentication; health advertises all existing features',async()=>{
  const f=fixture();assert.equal((await f.api('/places',{origin:'https://evil.test'})).status,403);assert.equal(f.calls.length,0);
  const h=await(await f.api('/health')).json();for(const key of ['mapPlaces','albumFolders','feeLedgerEditing'])assert.equal(h.features[key],true);
});
test('member reads private places and no new Firestore collection or credential is used',async()=>{
  const f=fixture(),{place}=await f.create();const result=await f.api('/places',{token:'member'});assert.equal(result.headers.get('Cache-Control'),'private, no-store');assert.equal((await result.json()).places[0].id,place.id);assert.ok(f.calls.every(u=>u.includes('accounts:lookup')||u.includes('/users/')));
  for(const key of ['album-media/protected','fee-ledgers/protected'])assert.equal(f.r2.objects.get(key).value,'original');
});
test('creation and edits can be safely retried after a lost response',async()=>{
  const f=fixture(),{id,body,place}=await f.create();assert.equal((await f.api('/places/'+id,{method:'PUT',body})).status,200);assert.equal(f.r2.writes.length,1);
  const change=f.edit(place,{name:'変更球場'}),a=await f.api('/places/'+id,{method:'PUT',body:change});assert.equal(a.status,200);const current=await a.json();assert.notEqual(current.version,place.version);
  assert.equal((await f.api('/places/'+id,{method:'PUT',body:change})).status,200);assert.equal(f.r2.writes.length,2);
  assert.equal((await f.api('/places/'+id,{method:'PUT',body:{...change,name:'別の内容'}})).status,409);
  assert.equal((await f.api('/places/'+id,{method:'PUT',body:change,token:'admin2'})).status,409);
});
test('stale edits, deletion versions, and conditional write races cannot overwrite a place',async()=>{
  const f=fixture(),{id,place}=await f.create();await f.api('/places/'+id,{method:'PUT',body:f.edit(place,{name:'最新'})});
  assert.equal((await f.api('/places/'+id,{method:'PUT',body:f.edit(place,{name:'古い'})})).status,409);
  assert.equal((await f.api('/places/'+id,{method:'DELETE',body:{version:place.version,operationId:crypto.randomUUID()}})).status,409);
  const latest=await(await f.api('/places/'+id)).json();f.r2.race=true;assert.equal((await f.api('/places/'+id,{method:'PUT',body:f.edit(latest)})).status,409);assert.equal((await(await f.api('/places/'+id)).json()).name,'最新');
});
test('photo bytes remain private and unmodified; metadata lists contain no photo bytes',async()=>{
  const f=fixture(),{id,place}=await f.create({photo:{type:'image/png',data:png}});assert.equal(place.hasPhoto,true);
  const response=await f.api('/places/'+id+'/photo',{token:'member'});assert.equal(response.headers.get('Content-Type'),'image/png');assert.deepEqual(Buffer.from(await response.arrayBuffer()),Buffer.from(png,'base64'));
  const list=await(await f.api('/places')).json();assert.equal(list.places[0].photoKey,undefined);assert.equal(JSON.stringify(list).includes(png),false);
});
test('editing keeps the photo; replacing and removing it only clean up the old place photo',async()=>{
  const f=fixture(),{id,place}=await f.create({photo:{type:'image/png',data:png}});const first=[...f.r2.objects.keys()].find(k=>k.startsWith('map-place-photos/'));
  let response=await f.api('/places/'+id,{method:'PUT',body:f.edit(place,{address:'住所変更'})});let current=await response.json();assert.equal(current.hasPhoto,true);assert.ok(f.r2.objects.has(first));
  response=await f.api('/places/'+id,{method:'PUT',body:f.edit(current,{photo:{type:'image/png',data:png}})});current=await response.json();assert.equal(f.r2.objects.has(first),false);
  response=await f.api('/places/'+id,{method:'PUT',body:f.edit(current,{removePhoto:true})});assert.equal((await response.json()).hasPhoto,false);assert.equal((await f.api('/places/'+id+'/photo')).status,404);
});
test('conditional photo conflict removes only the new uncommitted photo',async()=>{
  const f=fixture(),{id,place}=await f.create({photo:{type:'image/png',data:png}});const old=[...f.r2.objects.keys()].find(k=>k.startsWith('map-place-photos/'));f.r2.race=true;
  assert.equal((await f.api('/places/'+id,{method:'PUT',body:f.edit(place,{photo:{type:'image/png',data:png}})})).status,409);assert.ok(f.r2.objects.has(old));assert.equal([...f.r2.objects.keys()].filter(k=>k.startsWith('map-place-photos/')).length,1);
});
test('delete is idempotent, removes photo access, excludes list, and cannot be resurrected',async()=>{
  const f=fixture(),{id,place}=await f.create({photo:{type:'image/png',data:png}});const body={version:place.version,operationId:crypto.randomUUID()};assert.equal((await f.api('/places/'+id,{method:'DELETE',body})).status,200);assert.equal((await f.api('/places/'+id,{method:'DELETE',body})).status,200);
  assert.equal((await f.api('/places/'+id)).status,404);assert.equal((await f.api('/places/'+id+'/photo')).status,404);assert.equal((await(await f.api('/places')).json()).places.length,0);assert.equal((await f.api('/places/'+id,{method:'PUT',body:f.edit(place)})).status,410);
});
test('photo cleanup failure can resume the committed deletion without resurrecting the place',async()=>{
  const f=fixture(),{id,place}=await f.create({photo:{type:'image/png',data:png}});f.r2.failCleanup=true;
  const body={version:place.version,operationId:crypto.randomUUID()};assert.equal((await f.api('/places/'+id,{method:'DELETE',body})).status,503);assert.equal((await f.api('/places/'+id+'/photo')).status,404);f.r2.failCleanup=false;assert.equal((await f.api('/places/'+id,{method:'DELETE',body})).status,200);assert.equal([...f.r2.objects.keys()].some(k=>k.startsWith('map-place-photos/')),false);
});
test('valid map links accepted and unsafe/non-Google links rejected',async()=>{
  const f=fixture();for(const url of ['https://maps.app.goo.gl/abc','https://www.google.com/maps/search/?api=1&query=Okayama','https://www.google.co.jp/maps/place/test','https://maps.google.com/?q=test','https://goo.gl/maps/abc'])await f.create({mapUrl:url});
  for(const mapUrl of ['javascript:alert(1)','http://maps.google.com/','https://evil.test/maps','https://maps.app.goo.gl.evil.test/','https://u:p@maps.google.com/','https://google.com/search']){
    assert.equal((await f.api('/places/'+crypto.randomUUID(),{method:'PUT',body:{name:'検証',address:'住所',mapUrl,version:'',operationId:crypto.randomUUID()}})).status,400,mapUrl);
  }
});
test('invalid fields, traversal, malformed/oversized photos rejected without writing',async()=>{
  const f=fixture(),base={name:'検証',address:'住所',mapUrl:'',version:'',operationId:crypto.randomUUID()};
  for(const patch of [{name:''},{address:''},{name:'x'.repeat(121)},{address:'x'.repeat(301)},{unexpected:true},{photo:{type:'image/svg+xml',data:png}},{photo:{type:'image/png',data:btoa('not an image')}},{removePhoto:'yes'},{photo:{type:'image/png',data:png},removePhoto:true}])assert.equal((await f.api('/places/'+crypto.randomUUID(),{method:'PUT',body:{...base,...patch}})).status,400);
  assert.equal((await f.api('/places/not-a-uuid')).status,400);assert.equal(f.r2.writes.length,0);
});
test('list pagination retains all places and skips tombstones',async()=>{
  const f=fixture();for(let i=0;i<53;i++)await f.create({name:'場所'+i});const first=await(await f.api('/places')).json();assert.equal(first.places.length,50);assert.ok(first.nextCursor);const next=await(await f.api('/places?cursor='+first.nextCursor)).json();assert.equal(next.places.length,3);assert.equal(next.nextCursor,'');
});
