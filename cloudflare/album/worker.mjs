// Private album API. R2 access uses a binding; Firebase credentials stay in
// Worker secrets. No existing album document is overwritten or deleted.
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
  try { return JSON.parse(new TextDecoder().decode(await bytes(request, maximum))); }
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
  return Object.fromEntries(Object.entries(values).map(([key,value])=>[key, typeof value === 'number'?{integerValue:String(value)}:{stringValue:value}]));
}
async function createMetadata(session, env) {
  const token = await adminToken(env);
  const response = await upstream(`${database(env)}/album?documentId=${session.id}`, {method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({fields:metadataFields(session)})});
  if (response.status === 409) {
    const existing = await upstream(`${database(env)}/album/${session.id}`, {headers:{Authorization:`Bearer ${token}`}});
    const fields = existing.ok ? (await existing.json()).fields : null;
    if (fields?.source?.stringValue !== 'r2' || fields?.objectKey?.stringValue !== session.key || fields?.uploadedBy?.stringValue !== session.uid) fail(409,'metadata_conflict');
  } else if (!response.ok) fail(503, 'metadata_unavailable');
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
  // Fail before creating an R2 upload if metadata credentials are not usable.
  await adminToken(env);
  const id = crypto.randomUUID(), key = mediaKey(id);
  const upload = await env.MEDIA.createMultipartUpload(key, {httpMetadata:{contentType:input.type,cacheControl:'private, no-store'},customMetadata:{albumId:id,uploadedBy:user.uid}});
  const session = {id,key,uploadId:upload.uploadId,uid:user.uid,type:input.type,size:input.size,name:input.name,title:input.title.trim() || input.name,createdAt:Date.now()};
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

async function route(request,env) {
  if (!env.MEDIA || !env.FIREBASE_WEB_API_KEY || !env.FIREBASE_SERVICE_ACCOUNT || typeof env.MEDIA_SIGNING_KEY !== 'string' || env.MEDIA_SIGNING_KEY.length < 32)fail(503,'album_not_configured');
  const path=new URL(request.url).pathname;
  if (path==='/health' && request.method==='GET')return json({ready:true});
  const object=path.match(/^\/objects\/([^/]+)$/);
  if(object && ['GET','HEAD'].includes(request.method))return serveMedia(request,env,object[1]);
  const write=path.startsWith('/uploads');
  const user=await authenticate(request,env,write);
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
      headers.set('Access-Control-Allow-Methods','GET, HEAD, POST, PUT, DELETE, OPTIONS');
      headers.set('Access-Control-Allow-Headers','Authorization, Content-Type, Range');
      headers.set('Access-Control-Expose-Headers','Content-Range, Content-Length, Accept-Ranges');
      headers.set('Access-Control-Max-Age','300');
    }
    return new Response(response.body,{status:response.status,headers});
  }
};
