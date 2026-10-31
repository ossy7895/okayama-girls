// Deploy the existing API while inheriting bindings from the actively deployed
// version. Secret values are never requested, printed, or supplied by this file.
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';

const ACCOUNT='3bd542e7bae0098bc3ca9b221ed575b3', NAME='white-leaf-338b';
const API=`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers`;
const HEALTH='https://white-leaf-338b.4khrhp97z8.workers.dev/health';
const BINDINGS=['MEDIA','FIREBASE_PROJECT_ID','FIREBASE_WEB_API_KEY','ALLOWED_ORIGIN','FIREBASE_SERVICE_ACCOUNT','MEDIA_SIGNING_KEY'];
const BASE_FEATURES=['albumFolders','metadataEditing','mediaDeletion','folderDeletion','feeLedger','feeLedgerEditing'];
const ALL_FEATURES=[...BASE_FEATURES,'mapPlaces','mapPlacesSharedEditing'];
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function deployWorker({fetcher=globalThis.fetch,token=process.env.CLOUDFLARE_API_TOKEN,code,delay=ms=>new Promise(r=>setTimeout(r,ms)),log=()=>{}}={}){
  if(typeof token!=='string'||!token)throw Error('Workers Buildsのデプロイ認証が利用できません。トークンをチャットへ送らず、Buildsの認証設定を確認してください。');
  code=code??await readFile(new URL('./worker.mjs',import.meta.url),'utf8');
  const entry=await readFile(new URL('./worker-entry.mjs',import.meta.url),'utf8');
  if(!code.includes('mapPlacesSharedEditing:true')||!code.includes('export default'))throw Error('地図対応のWorkerソースが見つかりません。公開していません。');
  async function api(path,{method='GET',body}={}){
    let response;try{response=await fetcher(API+path,{method,redirect:'error',signal:AbortSignal.timeout(30000),headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});}catch{throw Error('Cloudflare APIとの通信に失敗しました。');}
    let data;try{data=await response.json();}catch{throw Error(`Cloudflare APIがJSON以外を返しました（HTTP ${response.status}）。`);}
    if(!response.ok||data.success!==true){const codes=(data.errors||[]).map(e=>e.code).filter(Number.isInteger).join(',');throw Error(`Cloudflare APIが操作を拒否しました（HTTP ${response.status}${codes?', code '+codes:''}）。`);}
    // Only metadata selected by the caller is used. Never log raw API replies.
    return data.result;
  }
  async function health(features){
    try{const url=new URL(HEALTH);url.searchParams.set('deployCheck',String(Date.now()));const response=await fetcher(url.href,{method:'GET',redirect:'error',signal:AbortSignal.timeout(15000),headers:{'Cache-Control':'no-cache'}});const data=await response.json();return response.ok&&data.ready===true&&features.every(k=>data.features?.[k]===true);}catch{return false;}
  }
  async function activeVersion(){
    const result=await api(`/scripts/${NAME}/deployments?per_page=1`);const versions=result?.deployments?.[0]?.versions;
    if(!Array.isArray(versions)||versions.length!==1||versions[0].percentage!==100||!UUID.test(versions[0].version_id||''))throw Error('公開中の版を1つに特定できません。公開していません。');
    return versions[0].version_id;
  }
  if(!await health(BASE_FEATURES))throw Error('既存APIの設定チェックが正常ではないため、公開を中止しました。');
  const source=await activeVersion();log('現在公開中の版から、設定名を指定してCloudflare内部で引き継ぎます: '+source);
  if(await activeVersion()!==source)throw Error('確認中に公開版が変わりました。公開していません。');
  // This endpoint explicitly accepts a source version ID for inherit bindings.
  // The older /scripts/.../versions endpoint only inherits from latest upload.
  const created=await api(`/workers/${NAME}/versions?deploy=true`,{method:'POST',body:{
    main_module:'worker-entry.mjs',compatibility_date:'2026-10-19',
    annotations:{'workers/message':'OKAYAMA Girls v9.83 API; inherit active runtime bindings'},
    bindings:BINDINGS.map(name=>({name,type:'inherit',version_id:source})),
    modules:[
      {name:'worker-entry.mjs',content_type:'application/javascript+module',content_base64:Buffer.from(entry,'utf8').toString('base64')},
      {name:'worker.mjs',content_type:'application/javascript+module',content_base64:Buffer.from(code,'utf8').toString('base64')}
    ]
  }});
  if(!UUID.test(created?.id||''))throw Error('公開結果のバージョンIDを確認できません。手動で公開状態を確認してください。');
  const versionId=created.id;
  for(let attempt=0;attempt<12;attempt++){
    if(attempt)await delay(3000);
    if(await health(ALL_FEATURES)){
      if(await activeVersion()!==versionId)throw Error('公開後に別の版へ切り替わっています。公開状態を確認してください。');
      log('公開と全8機能の設定チェックが成功しました: '+versionId);return {workerName:NAME,versionId,inheritedFrom:source};
    }
  }
  // Restore only our own deployment; never overwrite another operator's work.
  if(await activeVersion()!==versionId)throw Error('設定チェックに失敗し、公開版も変わっています。自動切り戻しは行っていません。');
  await api(`/scripts/${NAME}/deployments`,{method:'POST',body:{strategy:'percentage',versions:[{version_id:source,percentage:100}],annotations:{'workers/message':'Restore previous active API after readiness check failed'}}});
  throw Error('最新APIの設定チェックに失敗したため、直前の正常な公開版へ切り戻しました。');
}

if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url){
  deployWorker({log:message=>console.log(message)}).catch(error=>{console.error(error.message);process.exitCode=1;});
}
