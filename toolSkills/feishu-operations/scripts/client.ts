/** 通用飞书应用身份HTTP客户端；CLI和工具包共用，不读取ai-distill数据库或项目配置。 */
export class FeishuError extends Error {constructor(public code:string){super(code);}}
export interface FeishuClient {
 call(path:string,method?:string,body?:unknown):Promise<any>;
 list(path:string):Promise<any[]>;
 download(fileToken:string):Promise<Uint8Array>;
}
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
export async function createAppClient(options:{appId?:string;appSecret?:string;root?:string;timeoutMs?:number;fetcher?:typeof fetch}={}):Promise<FeishuClient>{
 const appId=options.appId??process.env.FEISHU_APP_ID,appSecret=options.appSecret??process.env.FEISHU_APP_SECRET;
 if(!appId||!appSecret)throw new FeishuError('feishu_credentials_missing');
 const root=apiRoot(options.root??process.env.FEISHU_API_BASE_URL??'https://open.feishu.cn/open-apis');
 const signal=AbortSignal.timeout(options.timeoutMs??90_000),request=options.fetcher??fetch;
 let auth:any;
 try{const response=await request(root+'/auth/v3/tenant_access_token/internal',{method:'POST',signal,headers:{'Content-Type':'application/json'},body:JSON.stringify({app_id:appId,app_secret:appSecret})});auth=await response.json();if(!response.ok||auth.code!==0||typeof auth.tenant_access_token!=='string')throw new FeishuError('feishu_auth_failed');}
 catch(error){throw error instanceof FeishuError?error:new FeishuError(signal.aborted?'feishu_timeout':'feishu_auth_failed');}
 async function send(path:string,method='GET',body?:unknown){
  resourcePath(path);
  const multipart=body instanceof FormData;
  try{return await request(root+path,{method,signal,headers:{Authorization:`Bearer ${auth.tenant_access_token}`,...(!multipart?{'Content-Type':'application/json'}:{})},...(body!==undefined?{body:multipart?body:JSON.stringify(body)}:{})});}
  catch{throw new FeishuError(signal.aborted?'feishu_timeout':'feishu_request_failed');}
 }
 async function call(path:string,method='GET',body?:unknown){
  const response=await send(path,method,body);let data:any;
  try{data=await response.json();}catch{throw new FeishuError(`feishu_response_invalid_${response.status}`);}
  if(!response.ok||data.code!==0)throw new FeishuError(`feishu_api_${Number(data.code)||response.status}`);
  return data.data;
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
