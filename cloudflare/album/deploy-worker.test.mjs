import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {deployWorker} from './deploy-worker.mjs';
const code=await readFile(new URL('./worker.mjs',import.meta.url),'utf8');
const SOURCE='c6e58d7b-1111-4111-8111-111111111111',NEXT='12345678-2222-4222-8222-222222222222',OTHER='aaaaaaaa-3333-4333-8333-333333333333';
const BASE=['albumFolders','metadataEditing','mediaDeletion','folderDeletion','feeLedger','feeLedgerEditing'],ALL=[...BASE,'mapPlaces','mapPlacesSharedEditing'];
function fixture(options={}){
 const calls=[],logs=[];let active=SOURCE,reads=0,healthReads=0,created=false;
 const token='mock-build-token',secret='mock-existing-value-never-to-be-printed';
 const success=result=>Response.json({success:true,result});
 const fetcher=async(input,init={})=>{
   const url=new URL(input),body=init.body?JSON.parse(init.body):undefined,method=init.method||'GET';calls.push({url,method,body});
   if(url.hostname==='white-leaf-338b.4khrhp97z8.workers.dev'){
     assert.equal(new Headers(init.headers).has('Authorization'),false);assert.equal(url.pathname,'/health');healthReads++;
     if(options.badBaseline&&!created)return Response.json({ready:false},{status:503});
     const features=created&&!options.badFinal&&healthReads>(options.healthDelay||0)?ALL:BASE;
     return Response.json({ready:true,features:Object.fromEntries(features.map(k=>[k,true]))});
   }
   assert.equal(url.origin,'https://api.cloudflare.com');assert.equal(new Headers(init.headers).get('Authorization'),'Bearer '+token);assert.equal(init.redirect,'error');
   if(options.apiForbidden)return Response.json({success:false,errors:[{code:10000,message:secret}]},{status:403});
   if(url.pathname.endsWith('/scripts/white-leaf-338b/deployments')&&method==='GET'){
     reads++;if(options.changeBeforeUpload&&reads===2)active=OTHER;if(options.changeAfterUpload&&created)active=OTHER;
     const versions=options.split?[{version_id:SOURCE,percentage:50},{version_id:OTHER,percentage:50}]:[{version_id:active,percentage:100}];return success({deployments:[{versions}]});
   }
   if(url.pathname.endsWith('/workers/white-leaf-338b/versions')&&method==='POST'){
     assert.equal(url.searchParams.get('deploy'),'true');
     if(options.inheritMissing)return Response.json({success:false,errors:[{code:10057,message:secret}]},{status:400});
     created=true;active=NEXT;return success({id:options.invalidResult?'invalid':NEXT,bindings:[{name:'EXAMPLE',type:'plain_text',text:secret}]});
   }
   if(url.pathname.endsWith('/scripts/white-leaf-338b/deployments')&&method==='POST'){active=body.versions[0].version_id;return success({id:'restored'});}
   throw Error('Unexpected request; secret values and storage data must never be requested');
 };
 const run=patch=>deployWorker({fetcher,token,code,delay:async()=>{},log:m=>logs.push(m),...patch});
 return {calls,logs,run,secret,get active(){return active;}};
}
test('deploy inherits all existing binding names from the active version, never from latest upload',async()=>{
 const f=fixture(),result=await f.run();assert.equal(result.versionId,NEXT);assert.equal(result.inheritedFrom,SOURCE);
 const upload=f.calls.find(c=>c.method==='POST');assert.match(upload.url.pathname,/\/workers\/workers\/white-leaf-338b\/versions$/);
 assert.deepEqual(upload.body.bindings.map(b=>b.name),['MEDIA','FIREBASE_PROJECT_ID','FIREBASE_WEB_API_KEY','ALLOWED_ORIGIN','FIREBASE_SERVICE_ACCOUNT','MEDIA_SIGNING_KEY']);
 for(const binding of upload.body.bindings)assert.deepEqual(Object.keys(binding).sort(),['name','type','version_id']);assert.ok(upload.body.bindings.every(b=>b.type==='inherit'&&b.version_id===SOURCE));
 assert.equal(Buffer.from(upload.body.modules[0].content_base64,'base64').toString(),code);assert.equal(upload.body.assets,undefined);assert.equal(f.active,NEXT);
 assert.equal(JSON.stringify(f.logs).includes(f.secret),false);assert.equal(JSON.stringify(f.logs).includes('mock-build-token'),false);assert.equal(JSON.stringify(result).includes(f.secret),false);
});
test('missing build credentials prevent every network call',async()=>{const f=fixture();await assert.rejects(f.run({token:''}),/デプロイ認証/);assert.equal(f.calls.length,0);});
test('wrong local source prevents every network call',async()=>{const f=fixture();await assert.rejects(f.run({code:'export default {}'}),/ソース/);assert.equal(f.calls.length,0);});
test('failed baseline health prevents any authenticated API call or write',async()=>{const f=fixture({badBaseline:true});await assert.rejects(f.run(),/公開を中止/);assert.equal(f.calls.length,1);});
test('API errors are reduced to HTTP status and numeric code without exposing reflected values',async()=>{const f=fixture({apiForbidden:true});await assert.rejects(f.run(),e=>e.message.includes('403')&&!e.message.includes(f.secret));assert.equal(f.calls.filter(c=>c.method==='POST').length,0);});
test('split traffic cannot select an ambiguous binding source',async()=>{const f=fixture({split:true});await assert.rejects(f.run(),/1つに特定/);assert.equal(f.calls.filter(c=>c.method==='POST').length,0);});
test('an intervening deployment aborts before uploading',async()=>{const f=fixture({changeBeforeUpload:true});await assert.rejects(f.run(),/公開版が変わり/);assert.equal(f.calls.filter(c=>c.method==='POST').length,0);});
test('inherit failure cannot fall back to blank or freshly generated credentials',async()=>{const f=fixture({inheritMissing:true});await assert.rejects(f.run(),/10057/);assert.equal(f.active,SOURCE);assert.equal(f.calls.filter(c=>c.method==='POST').length,1);});
test('post-deployment readiness is retried before reporting success',async()=>{const f=fixture({healthDelay:3});await f.run();assert.ok(f.calls.filter(c=>c.url.pathname==='/health').length>=4);});
test('failed final readiness restores the previous deployment, never data resources',async()=>{const f=fixture({badFinal:true});await assert.rejects(f.run(),/切り戻しました/);assert.equal(f.active,SOURCE);const writes=f.calls.filter(c=>c.method==='POST');assert.equal(writes.length,2);assert.deepEqual(writes[1].body.versions,[{version_id:SOURCE,percentage:100}]);});
test('another operator’s intervening deployment is not overwritten by automatic rollback',async()=>{const f=fixture({badFinal:true,changeAfterUpload:true});await assert.rejects(f.run(),/自動切り戻しは行っていません/);assert.equal(f.active,OTHER);assert.equal(f.calls.filter(c=>c.method==='POST').length,1);});
test('unverifiable mutation results are reported without blindly retrying or rolling back',async()=>{const f=fixture({invalidResult:true});await assert.rejects(f.run(),/バージョンID/);assert.equal(f.calls.filter(c=>c.method==='POST').length,1);});
