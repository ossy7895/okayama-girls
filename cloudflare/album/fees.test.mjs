import test from 'node:test';
import assert from 'node:assert/strict';
import worker from './worker.mjs';
const ORIGIN='https://ossy7895.github.io',prefix='fee-ledgers/';
const pair=await crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);
const pem=Buffer.from(await crypto.subtle.exportKey('pkcs8',pair.privateKey)).toString('base64');
const account=JSON.stringify({type:'service_account',project_id:'okayama-girls',client_email:'fees-test@okayama-girls.iam.gserviceaccount.com',private_key:`-----BEGIN PRIVATE KEY-----\n${pem}\n-----END PRIVATE KEY-----`});
class LedgerR2 {
 objects=new Map();writes=[];sequence=0;failPut=false;race=false;
 async get(key){const object=this.objects.get(key);return object?{etag:object.etag,json:async()=>JSON.parse(object.value)}:null;}
 async put(key,value,options){
  if(this.failPut)throw Error('mock outage');
  const current=this.objects.get(key),condition=options.onlyIf;
  if(this.race){this.race=false;return null;}
  if(condition.etagMatches&&current?.etag!==condition.etagMatches)return null;
  if(condition instanceof Headers){assert.equal(condition.get('If-None-Match'),'*');if(current)return null;}
  assert.ok(key.startsWith(prefix));assert.equal(options.httpMetadata.contentType,'application/json');
  const next={value:String(value),etag:'etag-'+(++this.sequence)};this.objects.set(key,next);this.writes.push(key);return next;
 }
 async list({prefix:filter,limit,cursor=''}){assert.equal(filter,prefix);const all=[...this.objects.keys()].filter(key=>key.startsWith(filter)).sort(),offset=Number(cursor)||0;return {objects:all.slice(offset,offset+limit).map(key=>({key})),truncated:offset+limit<all.length,cursor:String(offset+limit)};}
}
function fixture(){
 const r2=new LedgerR2(),calls=[];r2.objects.set('album-media/protected',{value:'unchanged photo',etag:'protected'});
 const env={MEDIA:r2,FIREBASE_WEB_API_KEY:'test-public-key',FIREBASE_SERVICE_ACCOUNT:account,MEDIA_SIGNING_KEY:'a-test-signing-key-with-more-than-32-chars',ALLOWED_ORIGIN:ORIGIN};
 globalThis.fetch=async(url,options={})=>{
  calls.push(String(url));const u=new URL(url);
  if(u.hostname==='identitytoolkit.googleapis.com'){const token=JSON.parse(options.body).idToken;return ['admin','admin2','member'].includes(token)?Response.json({users:[{localId:token}]}):Response.json({}, {status:400});}
  if(/\/users\/(admin|admin2|member)$/.test(u.pathname)){const role=u.pathname.endsWith('/member')?'member':'admin';return Response.json({fields:{role:{stringValue:role}}});}
  if(u.hostname==='oauth2.googleapis.com')return Response.json({access_token:'fee-server-token',expires_in:3600});
  if(u.pathname.includes('/members/')){assert.equal(options.headers.Authorization,'Bearer fee-server-token');const id=u.pathname.split('/').at(-1);return id.startsWith('p')?Response.json({fields:{name:{stringValue:'検証選手 '+id}}}):Response.json({}, {status:404});}
  throw Error('unexpected external request: '+url);
 };
 const api=(path,body,{token='admin',method=body?'POST':'GET',origin=ORIGIN}={})=>worker.fetch(new Request('https://worker.test'+path,{method,headers:{Origin:origin,...(token?{Authorization:'Bearer '+token}:{}),'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})}),env);
 const create=async(extra={})=>{const body={id:crypto.randomUUID(),title:'検証月謝',amount:3000,dueDate:'2026-11-30',memberIds:['p1','p2'],...extra};const response=await api('/fees',body);assert.equal(response.status,201);return {body,ledger:await response.json()};};
 const payment=(ledger,extra={})=>({id:crypto.randomUUID(),memberId:'p1',amount:1000,paidOn:'2026-11-01',method:'現金',memo:'検証',version:ledger.version,...extra});
 return {r2,calls,api,create,payment};
}
test('fee API authenticates every read/write on the server; member and anonymous see nothing',async()=>{
 const f=fixture();for(const path of ['/fees','/fees/'+crypto.randomUUID()+'/payments'])for(const token of ['member','', 'expired']){const response=await f.api(path,path==='/fees'?undefined:{},{token});assert.equal(response.status,token==='member'?403:401);}assert.equal(f.r2.writes.length,0);assert.equal(f.calls.some(url=>url.includes('oauth2')),false);
});
test('wrong Origin is rejected before any authentication or storage access',async()=>{const f=fixture();assert.equal((await f.api('/fees',undefined,{origin:'https://evil.test'})).status,403);assert.equal(f.calls.length,0);});
test('health reports the fee capability with the existing album capabilities',async()=>{const f=fixture(),response=await f.api('/health',undefined,{token:''});const data=await response.json();assert.equal(data.features.feeLedger,true);assert.equal(data.features.mediaDeletion,true);});
test('create uses a private prefix, server member names and conditional creation; album bytes stay identical',async()=>{
 const f=fixture(),{ledger}=await f.create();assert.equal(ledger.members[0].name,'検証選手 p1');assert.equal(ledger.members.length,2);assert.deepEqual(ledger.payments,[]);assert.ok(ledger.version);assert.equal(f.r2.objects.get('album-media/protected').value,'unchanged photo');assert.deepEqual(f.r2.writes,[prefix+ledger.id+'.json']);
 const response=await f.api('/fees');assert.equal(response.headers.get('Cache-Control'),'private, no-store');assert.equal((await response.json()).ledgers.length,1);
});
test('creation retry after a lost response returns the same ledger, never a second charge',async()=>{const f=fixture(),{body,ledger}=await f.create();const retry=await f.api('/fees',body);assert.equal(retry.status,200);assert.equal((await retry.json()).id,ledger.id);assert.equal(f.r2.writes.length,1);assert.equal((await f.api('/fees',{...body,title:'異なる請求'})).status,409);});
test('a different administrator cannot reuse another administrator’s creation ID',async()=>{const f=fixture(),{body}=await f.create();assert.equal((await f.api('/fees',body,{token:'admin2'})).status,409);});
test('reject invalid amounts, real calendar dates, duplicate/missing members, foreign fields and path IDs',async()=>{
 const f=fixture(),base={id:crypto.randomUUID(),title:'検証',amount:3000,dueDate:'2026-11-30',memberIds:['p1']};
 for(const patch of [{amount:0},{amount:-1},{amount:1.2},{amount:'3000'},{amount:10000001},{dueDate:'2026-02-30'},{dueDate:'2026-13-01'},{memberIds:[]},{memberIds:['p1','p1']},{memberIds:['missing']},{memberIds:['../users']},{id:'../../other'},{unexpected:'injected'},{title:''},{title:'x'.repeat(121)}])assert.equal((await f.api('/fees',{...base,...patch})).status,400,JSON.stringify(patch));
 assert.equal(f.r2.writes.length,0);
});
test('partial/full payments compute the correct remaining amount; overpayment is rejected',async()=>{
 const f=fixture(),{ledger}=await f.create();const a=await f.api('/fees/'+ledger.id+'/payments',f.payment(ledger));assert.equal(a.status,200);const next=await a.json();assert.equal(next.payments[0].recordedBy,'admin');
 assert.equal((await f.api('/fees/'+ledger.id+'/payments',f.payment(next,{amount:2001}))).status,400);
 const b=await f.api('/fees/'+ledger.id+'/payments',f.payment(next,{amount:2000}));assert.equal(b.status,200);assert.equal((await b.json()).payments.reduce((n,p)=>n+p.amount,0),3000);
});
test('payment retry is idempotent across an intervening update; altered reuse conflicts',async()=>{
 const f=fixture(),{ledger}=await f.create(),body=f.payment(ledger);const first=await f.api('/fees/'+ledger.id+'/payments',body);assert.equal(first.status,200);const next=await first.json();
 await f.api('/fees/'+ledger.id+'/payments',f.payment(next,{memberId:'p2'}));const response=await f.api('/fees/'+ledger.id+'/payments',body);assert.equal(response.status,200);assert.equal((await response.json()).payments.length,2);assert.equal((await f.api('/fees/'+ledger.id+'/payments',{...body,amount:1200})).status,409);
});
test('stale versions and conditional-write races cannot overwrite a newer receipt',async()=>{
 const f=fixture(),{ledger}=await f.create();await f.api('/fees/'+ledger.id+'/payments',f.payment(ledger));assert.equal((await f.api('/fees/'+ledger.id+'/payments',f.payment(ledger,{memberId:'p2'}))).status,409);
 const current=(await (await f.api('/fees')).json()).ledgers[0];f.r2.race=true;assert.equal((await f.api('/fees/'+ledger.id+'/payments',f.payment(current,{memberId:'p2'}))).status,409);assert.equal((await (await f.api('/fees')).json()).ledgers[0].payments.length,1);
});
test('voiding retains amount/date/actor and reason; repeated cancellation does not create a new record',async()=>{
 const f=fixture(),{ledger}=await f.create(),body=f.payment(ledger);const current=await (await f.api('/fees/'+ledger.id+'/payments',body)).json();
 const response=await f.api('/fees/'+ledger.id+'/voids',{id:body.id,reason:'金額の入力訂正',version:current.version});assert.equal(response.status,200);const result=await response.json();assert.equal(result.payments.length,1);assert.equal(result.payments[0].amount,1000);assert.equal(result.payments[0].voidReason,'金額の入力訂正');assert.equal(result.payments[0].voidedBy,'admin');
 const retry=await f.api('/fees/'+ledger.id+'/voids',{id:body.id,reason:'金額の入力訂正',version:current.version});assert.equal(retry.status,200);
 const replacement=await f.api('/fees/'+ledger.id+'/payments',f.payment(result,{amount:3000}));assert.equal(replacement.status,200);assert.equal((await replacement.json()).payments.length,2);
});
test('closing preserves debts/history and blocks receipt changes until reopened',async()=>{
 const f=fixture(),{ledger}=await f.create();const closed=await (await f.api('/fees/'+ledger.id+'/status',{closed:true,version:ledger.version})).json();assert.equal(closed.closed,true);assert.equal(closed.amount,3000);assert.equal(closed.members.length,2);assert.equal((await f.api('/fees/'+ledger.id+'/payments',f.payment(closed))).status,409);
 const reopened=await (await f.api('/fees/'+ledger.id+'/status',{closed:false,version:closed.version})).json();assert.equal(reopened.closed,false);assert.equal((await f.api('/fees/'+ledger.id+'/payments',f.payment(reopened))).status,200);
});
test('invalid payment member/method/date/memo and cancellation reasons are rejected without writes',async()=>{
 const f=fixture(),{ledger}=await f.create(),n=f.r2.writes.length;
 for(const patch of [{memberId:'not-member'},{method:'cardtoken'},{paidOn:'2026-02-30'},{memo:'x'.repeat(301)},{amount:0},{role:'admin'}])assert.equal((await f.api('/fees/'+ledger.id+'/payments',f.payment(ledger,patch))).status,400);
 assert.equal((await f.api('/fees/'+ledger.id+'/voids',{id:crypto.randomUUID(),reason:'',version:ledger.version})).status,400);assert.equal(f.r2.writes.length,n);
});
test('storage failures retain the original ledger and report failure instead of success',async()=>{const f=fixture(),{ledger}=await f.create(),original=f.r2.objects.get(prefix+ledger.id+'.json').value;f.r2.failPut=true;assert.equal((await f.api('/fees/'+ledger.id+'/payments',f.payment(ledger))).status,500);assert.equal(f.r2.objects.get(prefix+ledger.id+'.json').value,original);});
test('list pagination cannot include album objects; direct album tickets cannot expose fee JSON',async()=>{
 const f=fixture();for(let i=0;i<27;i++)await f.create({title:'検証 '+i});const a=await (await f.api('/fees')).json();assert.equal(a.ledgers.length,25);assert.ok(a.nextCursor);const b=await (await f.api('/fees?cursor='+a.nextCursor)).json();assert.equal(b.ledgers.length,2);assert.equal(b.nextCursor,'');
 const id=a.ledgers[0].id;const response=await f.api('/objects/'+id,undefined,{token:'member'});assert.notEqual(response.status,200);assert.equal(f.r2.objects.get('album-media/protected').value,'unchanged photo');
});
test('editing capability is advertised by health and ledger list',async()=>{const f=fixture();assert.equal((await (await f.api('/health')).json()).features.feeLedgerEditing,true);assert.equal((await (await f.api('/fees')).json()).features.feeLedgerEditing,true);});
test('a member or anonymous user cannot delete ledgers or change payment state',async()=>{const f=fixture(),{ledger}=await f.create(),writes=f.r2.writes.length;for(const token of ['member','']){assert.equal((await f.api('/fees/'+ledger.id,{version:ledger.version},{method:'DELETE',token})).status,token?403:401);assert.equal((await f.api('/fees/'+ledger.id+'/member-state',{id:crypto.randomUUID(),memberId:'p1',paid:true,paidOn:'2026-11-01',version:ledger.version},{token})).status,token?403:401);}assert.equal(f.r2.writes.length,writes);});
const stateRequest=(ledger,extra={})=>({id:crypto.randomUUID(),memberId:'p1',paid:true,paidOn:'2026-11-01',version:ledger.version,...extra});
test('unpaid state tap records the full balance with server audit metadata',async()=>{const f=fixture(),{ledger}=await f.create(),response=await f.api('/fees/'+ledger.id+'/member-state',stateRequest(ledger));assert.equal(response.status,200);const next=await response.json();assert.equal(next.payments.length,1);assert.equal(next.payments[0].amount,3000);assert.equal(next.payments[0].paidOn,'2026-11-01');assert.equal(next.payments[0].method,'その他');assert.equal(next.payments[0].recordedBy,'admin');assert.equal(next.stateChanges[0].paid,true);assert.equal(next.members[1].memberId,'p2');});
test('partial state tap adds only the remaining amount and preserves earlier receipts',async()=>{const f=fixture(),{ledger}=await f.create(),partial=await (await f.api('/fees/'+ledger.id+'/payments',f.payment(ledger))).json(),next=await (await f.api('/fees/'+ledger.id+'/member-state',stateRequest(partial))).json();assert.deepEqual(next.payments.map(p=>p.amount),[1000,2000]);assert.equal(next.payments[0].voidedAt,undefined);assert.equal(next.payments.reduce((n,p)=>n+p.amount,0),3000);});
test('paid state tap atomically voids all receipts of only the selected member and keeps their history',async()=>{
 const f=fixture(),{ledger}=await f.create();let next=await (await f.api('/fees/'+ledger.id+'/payments',f.payment(ledger))).json();next=await (await f.api('/fees/'+ledger.id+'/payments',f.payment(next,{amount:2000}))).json();next=await (await f.api('/fees/'+ledger.id+'/payments',f.payment(next,{memberId:'p2',amount:3000}))).json();
 const response=await f.api('/fees/'+ledger.id+'/member-state',stateRequest(next,{paid:false}));assert.equal(response.status,200);next=await response.json();assert.equal(next.payments.length,3);assert.ok(next.payments.slice(0,2).every(p=>p.voidedAt&&p.voidedBy==='admin'&&p.voidReason.includes('未入金')));assert.equal(next.payments[2].voidedAt,undefined);assert.deepEqual(next.payments.map(p=>p.amount),[1000,2000,3000]);assert.equal(next.stateChanges[0].paid,false);
});
test('lost-response retries for either state do not flip a later change or re-register a receipt',async()=>{
 const f=fixture(),{ledger}=await f.create(),paid=stateRequest(ledger);let next=await (await f.api('/fees/'+ledger.id+'/member-state',paid)).json();const unpaid=stateRequest(next,{paid:false});next=await (await f.api('/fees/'+ledger.id+'/member-state',unpaid)).json();const replayPaid=await (await f.api('/fees/'+ledger.id+'/member-state',paid)).json();assert.equal(replayPaid.payments.length,1);assert.ok(replayPaid.payments[0].voidedAt);
 next=await (await f.api('/fees/'+ledger.id+'/member-state',stateRequest(next))).json();const replayUnpaid=await (await f.api('/fees/'+ledger.id+'/member-state',unpaid)).json();assert.equal(replayUnpaid.payments.length,2);assert.equal(replayUnpaid.payments[1].voidedAt,undefined);assert.equal(replayUnpaid.stateChanges.length,3);
});
test('state change ID collisions, malformed states and nonexistent members do not write',async()=>{
 const f=fixture(),{ledger}=await f.create(),body=stateRequest(ledger),next=await (await f.api('/fees/'+ledger.id+'/member-state',body)).json(),writes=f.r2.writes.length;
 for(const change of [{...body,paid:false},{...body,memberId:'p2'},{...body,paidOn:'2026-11-02'}])assert.equal((await f.api('/fees/'+ledger.id+'/member-state',change)).status,409);
 for(const change of [{paid:'true'},{memberId:'unknown'},{paidOn:'2026-02-30'},{id:'not-uuid'},{amount:1}])assert.equal((await f.api('/fees/'+ledger.id+'/member-state',stateRequest(next,change))).status,400);assert.equal(f.r2.writes.length,writes);
});
test('closed ledgers reject state edits, while stale versions and ETag races cannot overwrite receipts',async()=>{
 const f=fixture(),{ledger}=await f.create(),closed=await (await f.api('/fees/'+ledger.id+'/status',{closed:true,version:ledger.version})).json();assert.equal((await f.api('/fees/'+ledger.id+'/member-state',stateRequest(closed))).status,409);
 const reopened=await (await f.api('/fees/'+ledger.id+'/status',{closed:false,version:closed.version})).json();assert.equal((await f.api('/fees/'+ledger.id+'/member-state',stateRequest(ledger))).status,409);f.r2.race=true;assert.equal((await f.api('/fees/'+ledger.id+'/member-state',stateRequest(reopened))).status,409);assert.equal((await (await f.api('/fees')).json()).ledgers[0].payments.length,0);
});
test('state storage failure leaves receipts and state history unchanged',async()=>{const f=fixture(),{ledger}=await f.create(),key=prefix+ledger.id+'.json',before=f.r2.objects.get(key).value;f.r2.failPut=true;assert.equal((await f.api('/fees/'+ledger.id+'/member-state',stateRequest(ledger))).status,500);assert.equal(f.r2.objects.get(key).value,before);});
test('deleting a paid ledger hides it from list/totals and retains the audit record without touching album objects',async()=>{
 const f=fixture(),{ledger}=await f.create(),paid=await (await f.api('/fees/'+ledger.id+'/payments',f.payment(ledger,{amount:3000}))).json(),response=await f.api('/fees/'+ledger.id,{version:paid.version},{method:'DELETE'});assert.equal(response.status,200);const deleted=await response.json();assert.ok(deleted.deletedAt);assert.equal(deleted.deletedBy,'admin');assert.equal(deleted.payments[0].amount,3000);assert.equal((await (await f.api('/fees')).json()).ledgers.length,0);assert.ok(f.r2.objects.has(prefix+ledger.id+'.json'));assert.equal(f.r2.objects.get('album-media/protected').value,'unchanged photo');
});
test('delete retry is idempotent and old creation/payment/toggle operations cannot resurrect a deleted ledger',async()=>{
 const f=fixture(),{ledger,body}=await f.create(),request={version:ledger.version},response=await f.api('/fees/'+ledger.id,request,{method:'DELETE'});assert.equal(response.status,200);const writes=f.r2.writes.length;assert.equal((await f.api('/fees/'+ledger.id,request,{method:'DELETE'})).status,200);
 assert.equal((await f.api('/fees',body)).status,410);assert.equal((await f.api('/fees/'+ledger.id+'/payments',f.payment(ledger))).status,410);assert.equal((await f.api('/fees/'+ledger.id+'/member-state',stateRequest(ledger))).status,410);assert.equal((await f.api('/fees/'+ledger.id+'/status',{closed:true,version:ledger.version})).status,410);assert.equal(f.r2.writes.length,writes);
});
test('stale deletion and racing deletion are rejected; storage errors keep the ledger visible',async()=>{
 const f=fixture(),{ledger}=await f.create(),next=await (await f.api('/fees/'+ledger.id+'/payments',f.payment(ledger))).json();assert.equal((await f.api('/fees/'+ledger.id,{version:ledger.version},{method:'DELETE'})).status,409);f.r2.race=true;assert.equal((await f.api('/fees/'+ledger.id,{version:next.version},{method:'DELETE'})).status,409);f.r2.failPut=true;assert.equal((await f.api('/fees/'+ledger.id,{version:next.version},{method:'DELETE'})).status,500);assert.equal((await (await f.api('/fees')).json()).ledgers.length,1);
});
test('a page containing only deleted ledgers keeps its next cursor so later active ledgers remain reachable',async()=>{const f=fixture();for(let i=0;i<26;i++)await f.create();const first=await (await f.api('/fees')).json();for(const ledger of first.ledgers)assert.equal((await f.api('/fees/'+ledger.id,{version:ledger.version},{method:'DELETE'})).status,200);const empty=await (await f.api('/fees')).json();assert.equal(empty.ledgers.length,0);assert.ok(empty.nextCursor);assert.equal((await (await f.api('/fees?cursor='+empty.nextCursor)).json()).ledgers.length,1);});
