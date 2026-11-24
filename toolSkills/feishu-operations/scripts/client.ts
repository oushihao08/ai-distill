/** 通用飞书应用身份HTTP客户端；CLI、工具包与服务端交付共用，内置进程级tenant_access_token缓存与超20MB分片上传，不读取ai-distill数据库或项目配置。 */
import {createHash} from 'node:crypto';
export class FeishuError extends Error {constructor(public code:string){super(code);}}
export interface FeishuClient {
 call(path:string,method?:string,body?:unknown):Promise<any>;
 list(path:string):Promise<any[]>;
 download(fileToken:string):Promise<Uint8Array>;
}
const TOKEN_REFRESH_MARGIN_MS=5*60_000;
const CHUNK_UPLOAD_THRESHOLD_BYTES=20*1024*1024;
const cachedTokens=new Map<string,{token:string;expiresAt:number}>();
const pendingTokens=new Map<string,Promise<string>>();
export function clearFeishuAuthTokenCache(){cachedTokens.clear();pendingTokens.clear();}

/** 默认只连接飞书；显式回环地址用于隔离验收，不允许凭证被发送到任意主机。 */
function apiRoot(raw:string){
 const url=new URL(raw);
 if(url.username||url.password||url.search||url.hash||!((url.origin==='https://open.feishu.cn')||(url.protocol==='http:'&&['127.0.0.1','[::1]'].includes(url.hostname))))throw new FeishuError('feishu_origin_invalid');
 if(url.pathname!=='/open-apis'&&url.pathname!=='/open-apis/')throw new FeishuError('feishu_origin_invalid');
 return raw.replace(/\/$/,'');
}
function resourcePath(path:string){
 const decoded=decodeURIComponent(path.split('?')[0]!);
 if(!path.startsWith('/')||decoded.startsWith('//')||decoded.includes('\\')||/[\r\n#]/.test(path)||/(?:^|\/)\.\.(?:\/|$)/.test(decoded)||/^\/(?:auth|oauth|application)\//.test(decoded))throw new FeishuError('feishu_path_invalid');
 return path;
}
async function fetchTenantToken(root:string,appId:string,appSecret:string,timeoutMs:number,request:typeof fetch,useCache:boolean):Promise<string>{
 const cacheKey=useCache?`${root}\0${appId}\0${createHash('sha256').update(appSecret).digest('hex')}`:'';
 if(useCache){
  const hit=cachedTokens.get(cacheKey);
  if(hit&&Date.now()<hit.expiresAt)return hit.token;
  const inflight=pendingTokens.get(cacheKey);
  if(inflight)return inflight;
 }
 const run=(async()=>{
  const authSignal=AbortSignal.timeout(timeoutMs);
  try{
   const response=await request(root+'/auth/v3/tenant_access_token/internal',{method:'POST',signal:authSignal,headers:{'Content-Type':'application/json'},body:JSON.stringify({app_id:appId,app_secret:appSecret})});
   const auth:any=await response.json();
   if(!response.ok||auth.code!==0||typeof auth.tenant_access_token!=='string')throw new FeishuError('feishu_auth_failed');
   if(useCache){
    const ttlSeconds=Number.isFinite(Number(auth.expire))?Number(auth.expire):7200;
    cachedTokens.set(cacheKey,{token:auth.tenant_access_token,expiresAt:Date.now()+Math.max(60_000,ttlSeconds*1000-TOKEN_REFRESH_MARGIN_MS)});
   }
   return auth.tenant_access_token as string;
  }catch(error){
   throw error instanceof FeishuError?error:new FeishuError(authSignal.aborted?'feishu_timeout':'feishu_auth_failed');
  }finally{
   if(useCache)pendingTokens.delete(cacheKey);
  }
 })();
 if(useCache)pendingTokens.set(cacheKey,run);
 return run;
}
export async function createAppClient(options:{appId?:string;appSecret?:string;root?:string;timeoutMs?:number;fetcher?:typeof fetch}={}):Promise<FeishuClient>{
 const rawAppId=options.appId??process.env.FEISHU_APP_ID,rawAppSecret=options.appSecret??process.env.FEISHU_APP_SECRET;
 if(!rawAppId||!rawAppSecret)throw new FeishuError('feishu_credentials_missing');
 const appId:string=rawAppId,appSecret:string=rawAppSecret;
 const root=apiRoot(options.root??process.env.FEISHU_API_BASE_URL??'https://open.feishu.cn/open-apis');
 const timeoutMs=options.timeoutMs??90_000,request=options.fetcher??fetch,useCache=!options.fetcher;
 const cacheKey=useCache?`${root}\0${appId}\0${createHash('sha256').update(appSecret).digest('hex')}`:'';
 let token=await fetchTenantToken(root,appId,appSecret,timeoutMs,request,useCache);
 async function send(path:string,method='GET',body?:unknown,bearer=token){
  resourcePath(path);
  const multipart=body instanceof FormData;
  const signal=AbortSignal.timeout(timeoutMs);
  try{return await request(root+path,{method,signal,headers:{Authorization:`Bearer ${bearer}`,...(!multipart?{'Content-Type':'application/json'}:{})},...(body!==undefined?{body:multipart?body:JSON.stringify(body)}:{})});}
  catch{throw new FeishuError(signal.aborted?'feishu_timeout':'feishu_request_failed');}
 }
 async function rawCall(path:string,method='GET',body?:unknown):Promise<any>{
  let response=await send(path,method,body);let data:any;
  try{data=await response.json();}catch{throw new FeishuError(`feishu_response_invalid_${response.status}`);}
  // 仅在进程缓存token过期且请求为只读GET时自动刷新一次；写请求绝不盲目重发。
  if(useCache&&method==='GET'&&(data?.code===99991663||data?.code===99991668)){
   cachedTokens.delete(cacheKey);
   token=await fetchTenantToken(root,appId,appSecret,timeoutMs,request,useCache);
   response=await send(path,method,body,token);
   try{data=await response.json();}catch{throw new FeishuError(`feishu_response_invalid_${response.status}`);}
  }
  if(!response.ok||data.code!==0)throw new FeishuError(`feishu_api_${Number(data.code)||response.status}`);
  return data.data;
 }
 async function call(path:string,method='GET',body?:unknown):Promise<any>{
  if(body instanceof FormData&&path==='/drive/v1/medias/upload_all'&&method==='POST'&&body.get('parent_type')==='bitable_file'){
   const file=body.get('file');
   if(file instanceof Blob&&file.size>CHUNK_UPLOAD_THRESHOLD_BYTES){
    const fileName=String(body.get('file_name')??'file'),parentNode=String(body.get('parent_node')??'');
    const prepared=await rawCall('/drive/v1/medias/upload_prepare','POST',{file_name:fileName,parent_type:'bitable_file',parent_node:parentNode,size:file.size});
    const {upload_id,block_size,block_num}=prepared??{};
    if(typeof upload_id!=='string'||!Number.isSafeInteger(block_size)||block_size<1||!Number.isSafeInteger(block_num)||block_num!==Math.ceil(file.size/block_size))throw new FeishuError('feishu_upload_prepare_invalid');
    for(let seq=0;seq<block_num;seq++){
     const part=file.slice(seq*block_size,Math.min(file.size,(seq+1)*block_size));
     const partForm=new FormData();partForm.set('upload_id',upload_id);partForm.set('seq',String(seq));partForm.set('size',String(part.size));partForm.set('file',part,'part');
     await rawCall('/drive/v1/medias/upload_part','POST',partForm);
    }
    return rawCall('/drive/v1/medias/upload_finish','POST',{upload_id,block_num});
   }
  }
  return rawCall(path,method,body);
 }
 async function list(path:string){
  const items:any[]=[],seen=new Set<string>();let next='';
  do{
   const page=await call(`${path}${path.includes('?')?'&':'?'}page_size=100${next?`&page_token=${encodeURIComponent(next)}`:''}`);
   items.push(...(page.items??[]));
   if(page.has_more&&(!page.page_token||seen.has(page.page_token)))throw new FeishuError('feishu_pagination_invalid');
   next=page.has_more?page.page_token:'';if(next)seen.add(next);
  }while(next);
  return items;
 }
 async function download(fileToken:string){
  const response=await send(`/drive/v1/medias/${encodeURIComponent(fileToken)}/download`);
  if(!response.ok||response.headers.get('content-type')?.includes('application/json'))throw new FeishuError(`feishu_download_${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
 }
 return{call,list,download};
}
