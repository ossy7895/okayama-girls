// Private album API. R2 access uses a binding; Firebase credentials stay in
// Worker secrets. Ordinary edits preserve media; confirmed deletions remove it.
export const PART_BYTES = 8 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
export const MAX_VIDEO_BYTES = 2 * 1024 * 1024 * 1024;
const SESSION_MS = 24 * 60 * 60 * 1000;
const TICKET_SECONDS = 900;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TYPES = new Set(['image/jpeg','image/png','image/webp','image/gif','image/avif','image/heic','image/heif','video/mp4','video/webm','video/quicktime']);
const encoder = new TextEncoder();
let googleToken;

class ApiError extends Error {
  constructor(status, code) { super(code); this.status = status; }
}
const fail = (status, code) => { throw new ApiError(status, code); };
const json = (body, status = 200) => new Response(JSON.stringify(body), {status, headers:{'Content-Type':'application/json; charset=utf-8'}});
const project = env => env.FIREBASE_PROJECT_ID || 'okayama-girls';
const database = env => `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(project(env))}/databases/(default)/documents`;
const sessionKey = id => `album-pending/${id}.json`;
const mediaKey = id => `album-media/${id}`;

function base64url(bytes) {
  let text = ''; for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
}
function decode64(text) {
  const clean = text.replaceAll('-','+').replaceAll('_','/');
  try { return Uint8Array.from(atob(clean + '='.repeat((4-clean.length%4)%4)), c => c.charCodeAt(0)); }
  catch { fail(403, 'invalid_ticket'); }
}
async function bytes(request, maximum) {
  if (Number(request.headers.get('Content-Length')) > maximum) fail(413, 'file_too_large');
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader(), chunks = []; let length = 0;
  try {
    for (;;) {
      const {done,value} = await reader.read(); if (done) break;
      length += value.byteLength;
      if (length > maximum) { await reader.cancel(); fail(413, 'file_too_large'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const result = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}
async function readJson(request, maximum = 16384) {
  try {
    const input = JSON.parse(new TextDecoder().decode(await bytes(request, maximum)));
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail(400,'invalid_json');
    return input;
  }
  catch (error) { if (error instanceof ApiError) throw error; fail(400, 'invalid_json'); }
}
async function upstream(url, options) {
  try { return await fetch(url, {...options, signal:AbortSignal.timeout(20000)}); }
  catch { fail(503, 'service_unavailable'); }
}

async function authenticate(request, env, adminOnly = false) {
  const match = request.headers.get('Authorization')?.match(/^Bearer ([^\s]+)$/);
  if (!match) fail(401, 'login_required');
  const token = match[1];
  // Google validates the ID token, its project, expiry and account state. Never
  // authorize from a decoded JWT, a client-supplied UID, or a client role flag.
  const response = await upstream(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(env.FIREBASE_WEB_API_KEY)}`, {
    method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({idToken:token})
  });
  if (!response.ok) fail(response.status >= 500 ? 503 : 401, 'login_required');
  const user = (await response.json()).users?.[0];
  if (!user?.localId || user.disabled === true) fail(401, 'login_required');
  const profile = await upstream(`${database(env)}/users/${encodeURIComponent(user.localId)}`, {headers:{Authorization:`Bearer ${token}`}});
  if (!profile.ok) fail(profile.status >= 500 ? 503 : 403, 'access_denied');
  const role = (await profile.json()).fields?.role?.stringValue;
  if (!['admin','member'].includes(role) || (adminOnly && role !== 'admin')) fail(403, 'access_denied');
  return {uid:user.localId, role, token};
}

async function adminToken(env) {
  let account;
  try { account = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT); }
  catch { fail(503, 'album_not_configured'); }
  if (account.type !== 'service_account' || account.project_id !== project(env) || !account.client_email || !account.private_key) fail(503, 'album_not_configured');
  if (googleToken?.email === account.client_email && googleToken.expires > Date.now() + 60000) return googleToken.value;
  const now = Math.floor(Date.now()/1000);
  const header = base64url(encoder.encode(JSON.stringify({alg:'RS256',typ:'JWT'})));
  const claims = base64url(encoder.encode(JSON.stringify({iss:account.client_email,scope:'https://www.googleapis.com/auth/datastore',aud:'https://oauth2.googleapis.com/token',iat:now,exp:now+3600})));
  const input = `${header}.${claims}`;
  const keyBytes = decode64(account.private_key.replace(/-----[^-]+-----/g,'').replace(/\s/g,''));
  const key = await crypto.subtle.importKey('pkcs8', keyBytes, {name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'}, false, ['sign']);
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, encoder.encode(input));
  const response = await upstream('https://oauth2.googleapis.com/token', {method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer',assertion:`${input}.${base64url(new Uint8Array(signature))}`})});
  if (!response.ok) fail(503, 'metadata_unavailable');
  const result = await response.json();
  if (!result.access_token) fail(503, 'metadata_unavailable');
  googleToken = {email:account.client_email,value:result.access_token,expires:Date.now()+Number(result.expires_in || 3600)*1000};
  return googleToken.value;
}
function metadataFields(session) {
  const values = {title:session.title,originalFilename:session.name,mimeType:session.type,mediaType:session.type.startsWith('video/')?'video':'image',source:'r2',objectKey:session.key,uploadedBy:session.uid,createdAt:session.createdAt,size:session.size};
  if (session.folderId) values.folderId = session.folderId;
  return Object.fromEntries(Object.entries(values).map(([key,value])=>[key, typeof value === 'number'?{integerValue:String(value)}:{stringValue:value}]));
}
async function createMetadata(session, env) {
  const token = await adminToken(env);
  const response = await upstream(`${database(env)}/album?documentId=${session.id}`, {method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({fields:metadataFields(session)})});
  if (response.status === 409) {
    const existing = await upstream(`${database(env)}/album/${session.id}`, {headers:{Authorization:`Bearer ${token}`}});
    const fields = existing.ok ? (await existing.json()).fields : null;
    if (fields?.deleted?.booleanValue) fail(410,'media_deleted');
    if (fields?.source?.stringValue !== 'r2' || fields?.objectKey?.stringValue !== session.key || fields?.uploadedBy?.stringValue !== session.uid) fail(409,'metadata_conflict');
  } else if (!response.ok) fail(503, 'metadata_unavailable');
}
function documentId(value) {
  if (typeof value !== 'string' || !value || value.length > 200 || /[\x00-\x1f/]/.test(value) || value === '.' || value === '..') fail(400,'invalid_item');
  return encodeURIComponent(value);
}
function metadataTitle(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 120) fail(400,'invalid_title');
  return value.trim();
}
async function metadataRequest(env, path, options = {}) {
  const token = await adminToken(env);
  const response = await upstream(`${database(env)}${path}`, {...options, headers:{...options.headers, Authorization:`Bearer ${token}`, 'Content-Type':'application/json'}});
  if (response.status === 403) fail(503,'metadata_permissions_required');
  return response;
}
function folderData(document) {
  return {id:document.name.split('/').pop(),title:document.fields?.title?.stringValue || 'フォルダ',updateTime:document.updateTime};
}
async function checkFolder(env, id) {
  if (id === '') return;
  if (typeof id !== 'string' || !UUID.test(id)) fail(400,'invalid_folder');
  const response = await metadataRequest(env, `/albumFolders/${id}`);
  if (response.status === 404) fail(404,'folder_not_found');
  if (!response.ok) fail(503,'metadata_unavailable');
  const folder = await response.json();
  if (folder.fields?.deleted?.booleanValue || folder.fields?.deleteState?.stringValue === 'pending') fail(404,'folder_not_found');
}
async function listFolders(request, env, user) {
  const pageToken = new URL(request.url).searchParams.get('pageToken') || '';
  if (pageToken.length > 4096) fail(400,'invalid_page');
  const params = new URLSearchParams({pageSize:'100'});if (pageToken) params.set('pageToken',pageToken);
  const response = await metadataRequest(env, `/albumFolders?${params}`);
  if (!response.ok) fail(503,'metadata_unavailable');
  const result = await response.json();
  const documents=result.documents || [];
  const pending=user.role==='admin'?documents.filter(document=>document.fields?.deleteState?.stringValue==='pending').map(document=>deletionData(document,'folder')):[];
  if(user.role==='admin'&&!pageToken){
    const jobs=await queryMetadata(env,'album',{fieldFilter:{field:{fieldPath:'deleteState'},op:'EQUAL',value:{stringValue:'pending'}}},12,['title','deleteVersion','deleted','deleteState']);
    pending.push(...jobs.map(document=>deletionData(document,'media')));
  }
  return json({folders:documents.filter(document=>!document.fields?.deleted?.booleanValue&&document.fields?.deleteState?.stringValue!=='pending').map(folderData),nextPageToken:result.nextPageToken || '',features:{mediaDeletion:true,folderDeletion:true},pendingDeletions:pending});
}
async function createFolder(request, env, user) {
  const input = await readJson(request), title = metadataTitle(input.title);
  if (!UUID.test(input.id || '') || Object.keys(input).some(key=>!['id','title'].includes(key))) fail(400,'invalid_folder');
  const fields = {title:{stringValue:title},createdAt:{integerValue:String(Date.now())},createdBy:{stringValue:user.uid}};
  const response = await metadataRequest(env, `/albumFolders?documentId=${input.id}`, {method:'POST',body:JSON.stringify({fields})});
  if (response.status === 409) {
    const existing = await metadataRequest(env, `/albumFolders/${input.id}`);
    const document = existing.ok ? await existing.json() : null;
    if (document?.fields?.createdBy?.stringValue !== user.uid || document?.fields?.title?.stringValue !== title) fail(409,'metadata_conflict');
    return json(folderData(document));
  }
  if (!response.ok) fail(503,'metadata_unavailable');
  return json(folderData(await response.json()),201);
}
async function editableMedia(env, user, id) {
  const response = await upstream(`${database(env)}/album/${documentId(id)}`, {headers:{Authorization:`Bearer ${user.token}`}});
  if (response.status === 404) fail(404,'media_not_found');
  if (!response.ok) fail(response.status >= 500 ? 503 : 403,'access_denied');
  const document = await response.json();
  if (document.fields?.deleted?.booleanValue) fail(410,'media_deleted');
  if (!document.updateTime) fail(503,'metadata_unavailable');
  return document;
}
async function patchFields(env, path, fields, updateTime, clearFields = []) {
  const params = new URLSearchParams({'currentDocument.updateTime':updateTime});
  Object.keys(fields).forEach(key=>params.append('updateMask.fieldPaths',key));
  clearFields.forEach(key=>params.append('updateMask.fieldPaths',key));
  const response = await metadataRequest(env, `${path}?${params}`, {method:'PATCH',body:JSON.stringify({fields})});
  if ([409,412].includes(response.status)) fail(409,'metadata_conflict');
  if (!response.ok) fail(503,'metadata_unavailable');
  return response.json();
}
async function renameFolder(request, env, user, id) {
  if (!UUID.test(id)) fail(400,'invalid_folder');
  const input = await readJson(request), title = metadataTitle(input.title);
  if (Object.keys(input).some(key=>!['title','updateTime'].includes(key))) fail(400,'invalid_folder');
  const response = await metadataRequest(env, `/albumFolders/${id}`);
  if (response.status === 404) fail(404,'folder_not_found');
  if (!response.ok) fail(503,'metadata_unavailable');
  const document = await response.json();
  if (document.fields?.deleted?.booleanValue || document.fields?.deleteState?.stringValue==='pending') fail(404,'folder_not_found');
  if (input.updateTime && input.updateTime !== document.updateTime) fail(409,'metadata_conflict');
  const updated = await patchFields(env, `/albumFolders/${id}`, {title:{stringValue:title},updatedAt:{integerValue:String(Date.now())},updatedBy:{stringValue:user.uid}}, document.updateTime);
  return json(folderData(updated));
}
async function editMedia(request, env, user, id) {
  const input = await readJson(request);
  if (!input || !Object.keys(input).length || Object.keys(input).some(key=>!['title','folderId'].includes(key))) fail(400,'invalid_edit');
  const fields = {updatedAt:{integerValue:String(Date.now())},updatedBy:{stringValue:user.uid}};
  if ('title' in input) fields.title = {stringValue:metadataTitle(input.title)};
  if ('folderId' in input) { await checkFolder(env,input.folderId);fields.folderId = {stringValue:input.folderId}; }
  const document = await editableMedia(env,user,id);
  const updated = await patchFields(env, `/album/${documentId(id)}`, fields, document.updateTime);
  return json({id,title:updated.fields?.title?.stringValue || '',folderId:updated.fields?.folderId?.stringValue || ''});
}
async function moveMedia(request, env, user) {
  const input = await readJson(request);
  if (!Array.isArray(input.ids) || !input.ids.length || input.ids.length > 24 || new Set(input.ids).size !== input.ids.length || Object.keys(input).some(key=>!['ids','folderId'].includes(key))) fail(400,'invalid_selection');
  input.ids.forEach(documentId);await checkFolder(env,input.folderId);
  const documents = await Promise.all(input.ids.map(id=>editableMedia(env,user,id)));
  const fields = {folderId:{stringValue:input.folderId},updatedAt:{integerValue:String(Date.now())},updatedBy:{stringValue:user.uid}};
  const writes = documents.map((document,i)=>({update:{name:`projects/${project(env)}/databases/(default)/documents/album/${input.ids[i]}`,fields},updateMask:{fieldPaths:Object.keys(fields)},currentDocument:{updateTime:document.updateTime}}));
  const response = await metadataRequest(env, ':commit', {method:'POST',body:JSON.stringify({writes})});
  if ([409,412].includes(response.status)) fail(409,'metadata_conflict');
  if (!response.ok) fail(503,'metadata_unavailable');
  return json({ids:input.ids,folderId:input.folderId});
}
async function queryMetadata(env, collection, where, limit = 24, selected = []) {
  const structuredQuery={from:[{collectionId:collection}],where,limit};
  if(selected.length)structuredQuery.select={fields:selected.map(fieldPath=>({fieldPath}))};
  const response=await metadataRequest(env,':runQuery',{method:'POST',body:JSON.stringify({structuredQuery})});
  if(!response.ok)fail(503,'metadata_unavailable');
  return (await response.json()).flatMap(row=>row.document?[row.document]:[]);
}
function deletionData(document, type) {
  return {id:document.name.split('/').pop(),type,title:document.fields?.title?.stringValue || (type==='folder'?'フォルダ':'写真・動画'),updateTime:document.fields?.deleteVersion?.stringValue || document.updateTime,done:document.fields?.deleteState?.stringValue==='done'};
}
function deletionVersion(input) {
  if(Object.keys(input).some(key=>key!=='updateTime')||typeof input.updateTime!=='string'||!input.updateTime||input.updateTime.length>150)fail(400,'invalid_confirmation');
  return input.updateTime;
}
async function deletionMedia(env, user, id) {
  const params=new URLSearchParams();['title','source','objectKey','mediaType','deleted','deleteState','deleteVersion','deleteObjectKey'].forEach(field=>params.append('mask.fieldPaths',field));
  const response=await upstream(`${database(env)}/album/${documentId(id)}?${params}`,{headers:{Authorization:`Bearer ${user.token}`}});
  if(response.status===404)fail(404,'media_not_found');if(!response.ok)fail(response.status>=500?503:403,'access_denied');
  const document=await response.json();if(!document.updateTime)fail(503,'metadata_unavailable');
  document.name=`projects/${project(env)}/databases/(default)/documents/album/${id}`;return document;
}
async function previewMediaDeletion(env, user, id) {
  const document=await deletionMedia(env,user,id);
  return json({...deletionData(document,'media'),kind:document.fields?.mediaType?.stringValue==='video'?'動画':'写真'});
}
async function deleteMedia(request, env, user, id) {
  const version=deletionVersion(await readJson(request));let document=await deletionMedia(env,user,id),fields=document.fields || {};
  if(fields.deleted?.booleanValue){
    if(fields.deleteVersion?.stringValue!==version)fail(409,'metadata_conflict');
    if(fields.deleteState?.stringValue==='done')return json({id,done:true});
  }else{
    if(document.updateTime!==version)fail(409,'metadata_conflict');
    let key='';
    if(fields.source?.stringValue==='r2'){
      if(!UUID.test(id)||fields.objectKey?.stringValue!==mediaKey(id))fail(409,'invalid_media');
      key=mediaKey(id);const object=await env.MEDIA.head(key);if(object&&object.customMetadata?.albumId!==id)fail(409,'invalid_media');
    }
    const marker={deleted:{booleanValue:true},deleteState:{stringValue:'pending'},deleteVersion:{stringValue:version},deletedAt:{integerValue:String(Date.now())},deletedBy:{stringValue:user.uid},deleteObjectKey:{stringValue:key}};
    document=await patchFields(env,`/album/${documentId(id)}`,marker,document.updateTime,['url','objectKey','source','mimeType','mediaType','size','originalFilename','uploadedBy','folderId']);fields=document.fields;
  }
  const key=fields.deleteObjectKey?.stringValue || '';
  if(key){
    if(!UUID.test(id)||key!==mediaKey(id))fail(409,'invalid_media');
    try{
      const object=await env.MEDIA.head(key);if(object&&object.customMetadata?.albumId!==id)fail(409,'invalid_media');
      await env.MEDIA.delete(key);await env.MEDIA.delete(sessionKey(id));
    }catch(error){if(error instanceof ApiError)throw error;fail(503,'deletion_pending');}
  }
  await patchFields(env,`/album/${documentId(id)}`,{deleteState:{stringValue:'done'}},document.updateTime,['deleteObjectKey','title']);
  return json({id,done:true});
}
async function deletionFolder(env, id) {
  if(!UUID.test(id))fail(400,'invalid_folder');
  const response=await metadataRequest(env,`/albumFolders/${id}`);if(response.status===404)fail(404,'folder_not_found');if(!response.ok)fail(503,'metadata_unavailable');return response.json();
}
async function previewFolderDeletion(env, id) {
  const document=await deletionFolder(env,id);
  const query={from:[{collectionId:'album'}],where:{fieldFilter:{field:{fieldPath:'folderId'},op:'EQUAL',value:{stringValue:id}}}};
  const response=await metadataRequest(env,':runAggregationQuery',{method:'POST',body:JSON.stringify({structuredAggregationQuery:{structuredQuery:query,aggregations:[{alias:'mediaCount',count:{}}]}})});
  if(!response.ok)fail(503,'metadata_unavailable');
  const rows=await response.json(),count=Number(rows.find(row=>row.result?.aggregateFields?.mediaCount)?.result.aggregateFields.mediaCount.integerValue || 0);
  return json({...deletionData(document,'folder'),count,keepsMedia:true});
}
async function deleteFolder(request, env, user, id) {
  const version=deletionVersion(await readJson(request));let document=await deletionFolder(env,id),fields=document.fields || {};
  if(fields.deleteState?.stringValue==='done'&&fields.deleted?.booleanValue){if(fields.deleteVersion?.stringValue!==version)fail(409,'metadata_conflict');return json({id,done:true,returned:0});}
  if(fields.deleteState?.stringValue==='pending'){if(fields.deleteVersion?.stringValue!==version)fail(409,'metadata_conflict');}
  else{
    if(document.updateTime!==version)fail(409,'metadata_conflict');
    document=await patchFields(env,`/albumFolders/${id}`,{deleteState:{stringValue:'pending'},deleteVersion:{stringValue:version},deletedAt:{integerValue:String(Date.now())},deletedBy:{stringValue:user.uid}},document.updateTime);
  }
  const children=await queryMetadata(env,'album',{fieldFilter:{field:{fieldPath:'folderId'},op:'EQUAL',value:{stringValue:id}}},24,['folderId']);
  if(children.length){
    const updates={folderId:{stringValue:''},updatedAt:{integerValue:String(Date.now())},updatedBy:{stringValue:user.uid}};
    const writes=children.map(child=>({update:{name:child.name,fields:updates},updateMask:{fieldPaths:Object.keys(updates)},currentDocument:{updateTime:child.updateTime}}));
    const response=await metadataRequest(env,':commit',{method:'POST',body:JSON.stringify({writes})});
    if([409,412].includes(response.status))fail(409,'metadata_conflict');if(!response.ok)fail(503,'metadata_unavailable');
  }
  if(children.length===24)return json({id,done:false,returned:children.length});
  await patchFields(env,`/albumFolders/${id}`,{deleted:{booleanValue:true},deleteState:{stringValue:'done'}},document.updateTime,['title','createdBy','updatedAt','updatedBy']);
  return json({id,done:true,returned:children.length});
}
async function sessionFor(id, user, env) {
  if (!UUID.test(id)) fail(404, 'upload_not_found');
  const object = await env.MEDIA.get(sessionKey(id));
  if (!object) fail(404, 'upload_not_found');
  const session = await object.json();
  if (session.uid !== user.uid) fail(403, 'access_denied');
  if (session.id !== id || session.key !== mediaKey(id)) fail(409, 'invalid_upload');
  if (Date.now() - session.createdAt > SESSION_MS) fail(410, 'upload_expired');
  return session;
}
function validateFile(input) {
  if (!input || !TYPES.has(input.type)) fail(415, 'unsupported_file');
  const maximum = input.type.startsWith('video/') ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
  if (!Number.isSafeInteger(input.size) || input.size <= 0 || input.size > maximum) fail(413, 'file_too_large');
  if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 200 || /[\x00-\x1f]/.test(input.name)) fail(400,'invalid_filename');
  if (typeof input.title !== 'string' || input.title.trim().length > 120) fail(400,'invalid_title');
}
export function fileSignatureMatches(type, data) {
  const starts = (...signature) => signature.every((value,i)=>data[i] === value);
  const text = new TextDecoder('latin1').decode(data.slice(0,64));
  if (type === 'image/jpeg') return starts(0xff,0xd8,0xff);
  if (type === 'image/png') return starts(137,80,78,71,13,10,26,10);
  if (type === 'image/gif') return text.startsWith('GIF87a') || text.startsWith('GIF89a');
  if (type === 'image/webp') return text.startsWith('RIFF') && text.slice(8,12)==='WEBP';
  if (type === 'video/webm') return starts(0x1a,0x45,0xdf,0xa3);
  if (type === 'video/quicktime' && ['wide','mdat','moov'].includes(text.slice(4,8))) return true;
  if (text.slice(4,8) !== 'ftyp') return false;
  const brands = text.slice(8);
  if (type === 'image/avif') return /avif|avis/.test(brands);
  if (type === 'image/heic' || type === 'image/heif') return /heic|heix|hevc|hevx|mif1|msf1/.test(brands);
  return type === 'video/mp4' || type === 'video/quicktime';
}
async function createUpload(request, env, user) {
  const input = await readJson(request); validateFile(input);
  const folderId = input.folderId ?? '';await checkFolder(env,folderId);
  // Fail before creating an R2 upload if metadata credentials are not usable.
  await adminToken(env);
  const id = crypto.randomUUID(), key = mediaKey(id);
  const upload = await env.MEDIA.createMultipartUpload(key, {httpMetadata:{contentType:input.type,cacheControl:'private, no-store'},customMetadata:{albumId:id,uploadedBy:user.uid}});
  const session = {id,key,uploadId:upload.uploadId,uid:user.uid,type:input.type,size:input.size,name:input.name,title:input.title.trim() || input.name,createdAt:Date.now(),folderId};
  try { await env.MEDIA.put(sessionKey(id), JSON.stringify(session), {httpMetadata:{contentType:'application/json'}}); }
  catch (error) { await upload.abort().catch(()=>{}); throw error; }
  return json({id,partSize:PART_BYTES,partCount:Math.ceil(input.size/PART_BYTES)},201);
}
async function uploadPart(request, env, user, id, partText) {
  const session = await sessionFor(id,user,env), partNumber = Number(partText);
  const count = Math.ceil(session.size/PART_BYTES);
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > count) fail(400,'invalid_part');
  if (session.completed || await env.MEDIA.head(session.key)) fail(409,'upload_already_completed');
  const expected = Math.min(PART_BYTES, session.size-(partNumber-1)*PART_BYTES);
  const data = await bytes(request, expected);
  if (data.byteLength !== expected) fail(400,'invalid_part_size');
  if (partNumber === 1 && !fileSignatureMatches(session.type,data)) fail(415,'unsupported_file');
  const part = await env.MEDIA.resumeMultipartUpload(session.key,session.uploadId).uploadPart(partNumber,data);
  return json({partNumber:part.partNumber,etag:part.etag});
}
async function completeUpload(request, env, user, id) {
  const session = await sessionFor(id,user,env);
  const {parts} = await readJson(request,65536);
  const expected = Math.ceil(session.size/PART_BYTES);
  if (!Array.isArray(parts) || parts.length !== expected || parts.some((p,i)=>p.partNumber !== i+1 || typeof p.etag !== 'string' || !p.etag || p.etag.length > 200)) fail(400,'invalid_parts');
  let object = await env.MEDIA.head(session.key);
  if (!object) object = await env.MEDIA.resumeMultipartUpload(session.key,session.uploadId).complete(parts.map(p=>({partNumber:p.partNumber,etag:p.etag})));
  if (object.size !== session.size || object.customMetadata?.albumId !== session.id) fail(409,'invalid_upload');
  // An interrupted metadata request can safely retry: the completed object and
  // session are retained, and createDocument never replaces an existing photo.
  if(session.folderId){try{await checkFolder(env,session.folderId);}catch(error){if(error instanceof ApiError&&error.message==='folder_not_found')session.folderId='';else throw error;}}
  await createMetadata(session,env);
  session.completed = true;
  await env.MEDIA.put(sessionKey(id),JSON.stringify(session),{httpMetadata:{contentType:'application/json'}});
  return json({id:session.id});
}
async function abortUpload(env,user,id) {
  const session = await sessionFor(id,user,env);
  if (session.completed || await env.MEDIA.head(session.key)) fail(409,'upload_already_completed');
  await env.MEDIA.resumeMultipartUpload(session.key,session.uploadId).abort();
  await env.MEDIA.delete(sessionKey(id));
  return json({cancelled:true});
}
async function signingKey(env) {
  if (typeof env.MEDIA_SIGNING_KEY !== 'string' || env.MEDIA_SIGNING_KEY.length < 32) fail(503,'album_not_configured');
  return crypto.subtle.importKey('raw',encoder.encode(env.MEDIA_SIGNING_KEY),{name:'HMAC',hash:'SHA-256'},false,['sign','verify']);
}
const ticketMessage = (id,expires) => encoder.encode(`${id}\n${expires}`);
async function issueTicket(request,env,user,id) {
  if (!UUID.test(id)) fail(404,'media_not_found');
  const response = await upstream(`${database(env)}/album/${id}`,{headers:{Authorization:`Bearer ${user.token}`}});
  if (!response.ok) fail(response.status >= 500 ? 503 : 404,'media_not_found');
  const fields = (await response.json()).fields;
  if(fields?.deleted?.booleanValue)fail(404,'media_not_found');
  if (fields?.source?.stringValue !== 'r2' || fields?.objectKey?.stringValue !== mediaKey(id)) fail(404,'media_not_found');
  const expires = Math.floor(Date.now()/1000)+TICKET_SECONDS;
  const signature = await crypto.subtle.sign('HMAC',await signingKey(env),ticketMessage(id,expires));
  const url = new URL(`/objects/${id}`,request.url);
  url.searchParams.set('expires',String(expires));url.searchParams.set('signature',base64url(new Uint8Array(signature)));
  return json({url:url.href,expiresAt:expires*1000});
}
export function parseRange(value,size) {
  if (!value) return null;
  const m=value.match(/^bytes=(\d*)-(\d*)$/);
  if (!m || (!m[1]&&!m[2])) fail(416,'invalid_range');
  let start,end;
  if (!m[1]) { const suffix=Number(m[2]);if(!Number.isSafeInteger(suffix)||suffix<=0)fail(416,'invalid_range');start=Math.max(0,size-suffix);end=size-1; }
  else { start=Number(m[1]);end=m[2]?Math.min(Number(m[2]),size-1):size-1; }
  if (!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||start>=size||end<start) fail(416,'invalid_range');
  return {offset:start,length:end-start+1};
}
async function serveMedia(request,env,id) {
  if (!UUID.test(id)) fail(404,'media_not_found');
  const url=new URL(request.url),expires=Number(url.searchParams.get('expires')),signature=url.searchParams.get('signature')||'';
  const now=Math.floor(Date.now()/1000);
  if (!Number.isInteger(expires)||expires<=now||expires>now+TICKET_SECONDS||signature.length>100)fail(403,'expired_ticket');
  if (!await crypto.subtle.verify('HMAC',await signingKey(env),decode64(signature),ticketMessage(id,expires)))fail(403,'invalid_ticket');
  const metadata=await env.MEDIA.head(mediaKey(id));
  if (!metadata || metadata.customMetadata?.albumId !== id)fail(404,'media_not_found');
  let range;
  try { range=parseRange(request.headers.get('Range'),metadata.size); }
  catch(error) { if(error.status===416)return new Response(null,{status:416,headers:{'Content-Range':`bytes */${metadata.size}`}});throw error; }
  const headers=new Headers({'Content-Type':metadata.httpMetadata?.contentType||'application/octet-stream','Accept-Ranges':'bytes','Content-Length':String(range?.length??metadata.size),'Content-Disposition':'inline','X-Content-Type-Options':'nosniff'});
  if(range)headers.set('Content-Range',`bytes ${range.offset}-${range.offset+range.length-1}/${metadata.size}`);
  const object=request.method==='HEAD'?null:await env.MEDIA.get(mediaKey(id),range?{range}:undefined);
  if(request.method!=='HEAD'&&!object)fail(404,'media_not_found');
  return new Response(object?.body||null,{status:range?206:200,headers});
}

// v9.78: private admin-only fee ledgers. Kept apart from album objects.
const FEE_PREFIX = 'fee-ledgers/';
function feeString(value, max, optional=false) {
  if(typeof value!=='string'||value.trim().length>max||(!optional&&!value.trim()))fail(400,'invalid_fee');
  return value.trim();
}
function feeDate(value) {
  if(typeof value!=='string'||!/^20\d\d-\d\d-\d\d$/.test(value)||!Number.isFinite(Date.parse(value+'T00:00:00Z'))||new Date(value+'T00:00:00Z').toISOString().slice(0,10)!==value)fail(400,'invalid_fee_date');
  return value;
}
function feeAmount(value) {if(!Number.isSafeInteger(value)||value<1||value>10000000)fail(400,'invalid_fee_amount');return value;}
function feeKeys(input, allowed) {if(Object.keys(input).some(key=>!allowed.includes(key)))fail(400,'invalid_fee');}
function feeUUID(id) {if(!UUID.test(id||''))fail(400,'invalid_fee');return id;}
function feeBalance(ledger, memberId) {return ledger.amount-ledger.payments.filter(p=>p.memberId===memberId&&!p.voidedAt).reduce((n,p)=>n+p.amount,0);}
async function readFee(env,id) {
  const object=await env.MEDIA.get(FEE_PREFIX+feeUUID(id)+'.json');
  if(!object)fail(404,'fee_not_found');
  if(typeof object.etag!=='string'||!object.etag)fail(503,'service_unavailable');
  const ledger=await object.json();
  return {ledger,etag:object.etag};
}
async function writeFee(env,ledger,etag) {
  const next={...ledger,version:crypto.randomUUID(),updatedAt:Date.now()};
  const result=await env.MEDIA.put(FEE_PREFIX+next.id+'.json',JSON.stringify(next),{httpMetadata:{contentType:'application/json'},onlyIf:etag?{etagMatches:etag}:new Headers({'If-None-Match':'*'})});
  if(!result)fail(409,'fee_conflict');
  return next;
}
async function feeRoute(request,env,user,path) {
  if(user.role!=='admin')fail(403,'access_denied');
  if(path==='/fees'&&request.method==='GET'){
    const cursor=new URL(request.url).searchParams.get('cursor')||'';if(cursor.length>4096)fail(400,'invalid_page');
    const page=await env.MEDIA.list({prefix:FEE_PREFIX,limit:25,...(cursor?{cursor}:{})});
    const ledgers=(await Promise.all(page.objects.map(async item=>{const object=await env.MEDIA.get(item.key);return object?object.json():null;}))).filter(ledger=>ledger&&!ledger.deletedAt);
    return json({ledgers,nextCursor:page.truncated?page.cursor:'',features:{feeLedger:true,feeLedgerEditing:true}});
  }
  if(path==='/fees'&&request.method==='POST'){
    const input=await readJson(request);feeKeys(input,['id','title','amount','dueDate','memberIds']);
    const id=feeUUID(input.id),title=feeString(input.title,120),amount=feeAmount(input.amount),dueDate=feeDate(input.dueDate);
    const ids=input.memberIds;
    if(!Array.isArray(ids)||!ids.length||ids.length>100||new Set(ids).size!==ids.length)fail(400,'invalid_fee');ids.forEach(documentId);
    const requestKey=JSON.stringify({title,amount,dueDate,memberIds:[...ids].sort()});
    const existing=await env.MEDIA.get(FEE_PREFIX+id+'.json');
    if(existing){const saved=await existing.json();if(saved.deletedAt)fail(410,'fee_deleted');if(saved.createdBy===user.uid&&saved.requestKey===requestKey)return json(saved);fail(409,'fee_conflict');}
    const members=[];
    for(let offset=0;offset<ids.length;offset+=8){
      const chunk=await Promise.all(ids.slice(offset,offset+8).map(async memberId=>{
        const response=await metadataRequest(env,'/members/'+documentId(memberId));if(response.status===404)fail(400,'fee_member_not_found');if(!response.ok)fail(503,'service_unavailable');
        const document=await response.json();return {memberId,name:feeString(document.fields?.name?.stringValue||'名称未設定',120)};
      }));members.push(...chunk);
    }
    const ledger={id,title,amount,dueDate,members,payments:[],closed:false,createdAt:Date.now(),createdBy:user.uid,requestKey};
    try{return json(await writeFee(env,ledger),201);}catch(error){
      if(error.message!=='fee_conflict')throw error;
      const {ledger:saved}=await readFee(env,id);if(saved.deletedAt)fail(410,'fee_deleted');if(saved.createdBy===user.uid&&saved.requestKey===requestKey)return json(saved);throw error;
    }
  }
  const deletion=path.match(/^\/fees\/([^/]+)$/);
  if(deletion&&request.method==='DELETE'){
    const {ledger,etag}=await readFee(env,deletion[1]),input=await readJson(request);feeKeys(input,['version']);
    if(typeof input.version!=='string'||!input.version)fail(400,'invalid_fee');
    if(ledger.deletedAt)return json(ledger);
    if(input.version!==ledger.version)fail(409,'fee_conflict');
    Object.assign(ledger,{deletedAt:Date.now(),deletedBy:user.uid,updatedBy:user.uid});
    return json(await writeFee(env,ledger,etag));
  }
  const match=path.match(/^\/fees\/([^/]+)\/(payments|voids|status|member-state)$/);
  if(!match||request.method!=='POST')fail(404,'not_found');
  const {ledger,etag}=await readFee(env,match[1]),input=await readJson(request);
  if(ledger.deletedAt)fail(410,'fee_deleted');
  if(match[2]==='member-state'){
    feeKeys(input,['id','memberId','paid','paidOn','version']);feeUUID(input.id);documentId(input.memberId);feeDate(input.paidOn);
    if(typeof input.paid!=='boolean')fail(400,'invalid_fee');
    if(!ledger.members.some(m=>m.memberId===input.memberId))fail(400,'fee_member_not_found');
    const changes=ledger.stateChanges||[],prior=changes.find(change=>change.id===input.id);
    if(prior){if(prior.memberId===input.memberId&&prior.paid===input.paid&&prior.paidOn===input.paidOn&&prior.recordedBy===user.uid)return json(ledger);fail(409,'fee_conflict');}
    if(ledger.payments.some(payment=>payment.id===input.id))fail(409,'fee_conflict');
    if(input.version!==ledger.version)fail(409,'fee_conflict');
    if(ledger.closed)fail(409,'fee_closed');
    const balance=feeBalance(ledger,input.memberId);
    if((input.paid&&balance===0)||(!input.paid&&balance===ledger.amount))return json(ledger);
    if(changes.length>=500||(input.paid&&ledger.payments.length>=500))fail(400,'fee_limit');
    const now=Date.now();
    if(input.paid){
      if(balance<0)fail(409,'fee_conflict');
      ledger.payments.push({id:input.id,memberId:input.memberId,amount:balance,paidOn:input.paidOn,method:'その他',memo:'状態タップで入金済みに変更',recordedAt:now,recordedBy:user.uid});
    }else{
      for(const payment of ledger.payments.filter(p=>p.memberId===input.memberId&&!p.voidedAt))Object.assign(payment,{voidedAt:now,voidedBy:user.uid,voidReason:'状態タップで未入金に変更'});
    }
    ledger.stateChanges=[...changes,{id:input.id,memberId:input.memberId,paid:input.paid,paidOn:input.paidOn,recordedAt:now,recordedBy:user.uid}];
  }else if(match[2]==='payments'){
    feeKeys(input,['id','memberId','amount','paidOn','method','memo','version']);feeUUID(input.id);documentId(input.memberId);feeAmount(input.amount);feeDate(input.paidOn);
    if(!['現金','振込','その他'].includes(input.method))fail(400,'invalid_fee');const memo=feeString(input.memo,300,true);
    if(!ledger.members.some(m=>m.memberId===input.memberId))fail(400,'fee_member_not_found');
    const payment={id:input.id,memberId:input.memberId,amount:input.amount,paidOn:input.paidOn,method:input.method,memo,recordedAt:Date.now(),recordedBy:user.uid};
    const prior=ledger.payments.find(p=>p.id===payment.id);
    if(prior){if(['memberId','amount','paidOn','method','memo','recordedBy'].every(key=>prior[key]===payment[key]))return json(ledger);fail(409,'fee_conflict');}
    if((ledger.stateChanges||[]).some(change=>change.id===input.id))fail(409,'fee_conflict');
    if(ledger.closed)fail(409,'fee_closed');if(ledger.payments.length>=500)fail(400,'fee_limit');
    if(payment.amount>feeBalance(ledger,input.memberId))fail(400,'fee_overpayment');
    ledger.payments.push(payment);
  }else if(match[2]==='voids'){
    feeKeys(input,['id','reason','version']);feeUUID(input.id);const reason=feeString(input.reason,300);
    const payment=ledger.payments.find(p=>p.id===input.id);if(!payment)fail(404,'fee_payment_not_found');
    if(payment.voidedAt)return json(ledger);
    if(ledger.closed)fail(409,'fee_closed');Object.assign(payment,{voidedAt:Date.now(),voidedBy:user.uid,voidReason:reason});
  }else{
    feeKeys(input,['closed','version']);if(typeof input.closed!=='boolean')fail(400,'invalid_fee');
    if(ledger.closed===input.closed)return json(ledger);ledger.closed=input.closed;ledger.statusChangedBy=user.uid;ledger.statusChangedAt=Date.now();
  }
  if(typeof input.version!=='string'||input.version!==ledger.version)fail(409,'fee_conflict');
  ledger.updatedBy=user.uid;return json(await writeFee(env,ledger,etag));
}

// v9.82: authenticated place directory; existing Firebase rules are unchanged.
const PLACE_PREFIX='map-places/', PLACE_PHOTOS='map-place-photos/';
const PLACE_PHOTO_MAX=5*1024*1024;
function placeId(value){if(!UUID.test(value||''))fail(400,'invalid_place');return value;}
function placeText(value,max,optional=false){
  if(typeof value!=='string'||value.trim().length>max||(!optional&&!value.trim())||/[\x00-\x1f]/.test(value))fail(400,'invalid_place');
  return value.trim();
}
function placeMapUrl(value){
  value=placeText(value,2048,true);if(!value)return '';
  let url;try{url=new URL(value);}catch{fail(400,'invalid_map_url');}
  const google=/^(www\.)?google\.(com|co\.jp)$/.test(url.hostname)&&/^\/maps(?:\/|$)/.test(url.pathname);
  if(url.protocol!=='https:'||url.username||url.password||url.port||!(google||url.hostname==='maps.google.com'||url.hostname==='maps.app.goo.gl'||(url.hostname==='goo.gl'&&url.pathname.startsWith('/maps/'))))fail(400,'invalid_map_url');
  return url.href;
}
function placeView(p){return {id:p.id,name:p.name,address:p.address,mapUrl:p.mapUrl,hasPhoto:!!p.photoKey,version:p.version,updatedAt:p.updatedAt};}
async function readPlace(env,id){
  const object=await env.MEDIA.get(PLACE_PREFIX+placeId(id)+'.json');if(!object)fail(404,'place_not_found');
  if(!object.etag)fail(503,'service_unavailable');
  return {place:await object.json(),etag:object.etag};
}
function placePhoto(input){
  if(!input||typeof input!=='object'||Object.keys(input).some(k=>!['type','data'].includes(k))||typeof input.data!=='string'||input.data.length>Math.ceil(PLACE_PHOTO_MAX/3)*4||!['image/jpeg','image/png','image/webp'].includes(input.type)||(input.data.length%4!==0||!/^[A-Za-z0-9+/]*={0,2}$/.test(input.data)))fail(400,'invalid_place_photo');
  let data;try{data=Uint8Array.from(atob(input.data),c=>c.charCodeAt(0));}catch{fail(400,'invalid_place_photo');}
  if(!data.length||data.length>PLACE_PHOTO_MAX)fail(413,'file_too_large');
  const valid=input.type==='image/jpeg'?data[0]===255&&data[1]===216&&data[2]===255:input.type==='image/png'?[137,80,78,71,13,10,26,10].every((n,i)=>data[i]===n):new TextDecoder().decode(data.slice(0,4))==='RIFF'&&new TextDecoder().decode(data.slice(8,12))==='WEBP';
  if(!valid)fail(400,'invalid_place_photo');return {data,type:input.type};
}
async function cleanupPlacePhotos(env,place){
  try{for(const key of place?.cleanupPhotoKeys||[])await env.MEDIA.delete(key);}catch{fail(503,'place_photo_cleanup_pending');}
}
async function placeRoute(request,env,user,path){
  if(path==='/places'&&request.method==='GET'){
    const cursor=new URL(request.url).searchParams.get('cursor')||'';if(cursor.length>4096)fail(400,'invalid_page');
    const page=await env.MEDIA.list({prefix:PLACE_PREFIX,limit:50,...(cursor?{cursor}:{})});
    const places=(await Promise.all(page.objects.map(async item=>{const obj=await env.MEDIA.get(item.key);return obj?obj.json():null;}))).filter(p=>p&&!p.deletedAt).map(placeView);
    return json({places,nextCursor:page.truncated?page.cursor:'',features:{mapPlaces:true,mapPlacesSharedEditing:true}});
  }
  const match=path.match(/^\/places\/([^/]+)(\/photo)?$/);if(!match)fail(404,'not_found');
  const id=placeId(match[1]);
  if(request.method==='GET'){
    const {place}=await readPlace(env,id);if(place.deletedAt)fail(404,'place_not_found');
    if(!match[2])return json(placeView(place));
    if(!place.photoKey)fail(404,'place_photo_not_found');
    const photo=await env.MEDIA.get(place.photoKey);if(!photo)fail(404,'place_photo_not_found');
    return new Response(photo.body,{headers:{'Content-Type':photo.httpMetadata?.contentType||'application/octet-stream','Content-Disposition':'inline'}});
  }
  if(!['admin','member'].includes(user.role))fail(403,'access_denied');
  if(match[2]||!['PUT','DELETE'].includes(request.method))fail(404,'not_found');
  const input=await readJson(request,7*1024*1024);
  if(Object.keys(input).some(k=>!(request.method==='DELETE'?['version','operationId']:['version','operationId','name','address','mapUrl','photo','removePhoto']).includes(k)))fail(400,'invalid_place');
  placeId(input.operationId);
  if(typeof input.version!=='string'||(input.version&&!UUID.test(input.version)))fail(400,'invalid_place');
  // The same operation may be retried after a lost response without creating a duplicate.
  const digest=base64url(new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(JSON.stringify(input)))));
  let prior=null,etag='';
  try{const saved=await readPlace(env,id);prior=saved.place;etag=saved.etag;}catch(e){if(e.message!=='place_not_found')throw e;}
  await cleanupPlacePhotos(env,prior);
  if(prior?.operationId===input.operationId){if(prior.operationUser!==user.uid||prior.operationDigest!==digest)fail(409,'place_conflict');return json(placeView(prior));}
  if(prior?.deletedAt)fail(410,'place_deleted');
  if((prior?.version||'')!==input.version)fail(409,'place_conflict');
  if(request.method==='DELETE'&&!prior)fail(404,'place_not_found');
  const next={...prior,id,operationId:input.operationId,operationUser:user.uid,operationDigest:digest,version:crypto.randomUUID(),updatedAt:Date.now(),updatedBy:user.uid};
  let newPhoto='';
  if(request.method==='DELETE'){next.deletedAt=Date.now();next.photoKey='';}
  else{
    next.name=placeText(input.name,120);next.address=placeText(input.address,300);next.mapUrl=placeMapUrl(input.mapUrl);
    if(input.removePhoto!==undefined&&typeof input.removePhoto!=='boolean')fail(400,'invalid_place');
    if(input.photo&&input.removePhoto)fail(400,'invalid_place');
    if(input.removePhoto)next.photoKey='';
    if(input.photo){
      const photo=placePhoto(input.photo);newPhoto=PLACE_PHOTOS+id+'/'+crypto.randomUUID();
      await env.MEDIA.put(newPhoto,photo.data,{httpMetadata:{contentType:photo.type}});next.photoKey=newPhoto;
    }
    if(!prior){next.createdAt=Date.now();next.createdBy=user.uid;}
  }
  next.cleanupPhotoKeys=prior?.photoKey&&prior.photoKey!==next.photoKey?[prior.photoKey]:[];
  const result=await env.MEDIA.put(PLACE_PREFIX+id+'.json',JSON.stringify(next),{httpMetadata:{contentType:'application/json'},onlyIf:etag?{etagMatches:etag}:new Headers({'If-None-Match':'*'})});
  if(!result){if(newPhoto)await env.MEDIA.delete(newPhoto);fail(409,'place_conflict');}
  // Keep the cleanup key in the committed record so a failed deletion can be retried.
  await cleanupPlacePhotos(env,next);
  return json(placeView(next),prior?200:201);
}


async function route(request,env) {
  if (!env.MEDIA || !env.FIREBASE_WEB_API_KEY || !env.FIREBASE_SERVICE_ACCOUNT || typeof env.MEDIA_SIGNING_KEY !== 'string' || env.MEDIA_SIGNING_KEY.length < 32)fail(503,'album_not_configured');
  const path=new URL(request.url).pathname;
  if (path==='/health' && request.method==='GET')return json({ready:true,features:{albumFolders:true,metadataEditing:true,mediaDeletion:true,folderDeletion:true,feeLedger:true,feeLedgerEditing:true,mapPlaces:true,mapPlacesSharedEditing:true}});
  const object=path.match(/^\/objects\/([^/]+)$/);
  if(object && ['GET','HEAD'].includes(request.method))return serveMedia(request,env,object[1]);
  // Place CRUD is shared by authenticated admins and members only.
  if(path==='/places'||path.startsWith('/places/'))return placeRoute(request,env,await authenticate(request,env),path);
  const write=path.endsWith('/delete-preview')||(!['GET','HEAD'].includes(request.method)&&!(request.method==='POST'&&/^\/media\/[^/]+\/access$/.test(path)));
  const user=await authenticate(request,env,write||path==='/fees'||path.startsWith('/fees/'));
  if(path==='/fees'||path.startsWith('/fees/'))return feeRoute(request,env,user,path);
  if(path==='/folders'&&request.method==='GET')return listFolders(request,env,user);
  if(path==='/folders'&&request.method==='POST')return createFolder(request,env,user);
  const folder=path.match(/^\/folders\/([^/]+)$/);
  if(folder&&request.method==='PATCH')return renameFolder(request,env,user,folder[1]);
  if(folder&&request.method==='DELETE')return deleteFolder(request,env,user,folder[1]);
  const folderPreview=path.match(/^\/folders\/([^/]+)\/delete-preview$/);
  if(folderPreview&&request.method==='GET')return previewFolderDeletion(env,folderPreview[1]);
  if(path==='/media/move'&&request.method==='POST')return moveMedia(request,env,user);
  const edit=path.match(/^\/media\/([^/]+)$/);
  if(edit&&request.method==='PATCH')return editMedia(request,env,user,decodeURIComponent(edit[1]));
  if(edit&&request.method==='DELETE')return deleteMedia(request,env,user,decodeURIComponent(edit[1]));
  const mediaPreview=path.match(/^\/media\/([^/]+)\/delete-preview$/);
  if(mediaPreview&&request.method==='GET')return previewMediaDeletion(env,user,decodeURIComponent(mediaPreview[1]));
  if(path==='/uploads'&&request.method==='POST')return createUpload(request,env,user);
  const part=path.match(/^\/uploads\/([^/]+)\/parts\/(\d+)$/);
  if(part&&request.method==='PUT')return uploadPart(request,env,user,part[1],part[2]);
  const finish=path.match(/^\/uploads\/([^/]+)\/complete$/);
  if(finish&&request.method==='POST')return completeUpload(request,env,user,finish[1]);
  const abort=path.match(/^\/uploads\/([^/]+)$/);
  if(abort&&request.method==='DELETE')return abortUpload(env,user,abort[1]);
  const ticket=path.match(/^\/media\/([^/]+)\/access$/);
  if(ticket&&request.method==='POST')return issueTicket(request,env,user,ticket[1]);
  fail(404,'not_found');
}

export default {
  async fetch(request,env) {
    const origin=request.headers.get('Origin');
    const allowed=env.ALLOWED_ORIGIN||'https://ossy7895.github.io';
    let response;
    try {
      if(origin&&origin!==allowed)fail(403,'origin_denied');
      if(request.method==='OPTIONS')response=new Response(null,{status:204});
      else response=await route(request,env);
    } catch(error) {
      const status=error instanceof ApiError?error.status:500;
      response=json({error:error instanceof ApiError?error.message:'service_unavailable'},status);
    }
    const headers=new Headers(response.headers);
    headers.set('Cache-Control','private, no-store');headers.set('X-Content-Type-Options','nosniff');headers.set('Referrer-Policy','no-referrer');
    if(origin===allowed) {
      headers.set('Access-Control-Allow-Origin',allowed);headers.set('Vary','Origin');
      headers.set('Access-Control-Allow-Methods','GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS');
      headers.set('Access-Control-Allow-Headers','Authorization, Content-Type, Range');
      headers.set('Access-Control-Expose-Headers','Content-Range, Content-Length, Accept-Ranges');
      headers.set('Access-Control-Max-Age','300');
    }
    return new Response(response.body,{status:response.status,headers});
  }
};
