/**
 * 文件职责：为 CLI 提供受限的本机 HTTP 客户端、JSON/multipart 请求及二进制下载。
 * 关键入口：`json()`、`form()` 负责JSON/表单请求；`download()`返回字节，`downloadTo()`供命令层安全落盘。
 * 边界：请求只允许本机 API；写请求不重试，网络结果未知时由调用者按原任务/幂等键查询恢复。
 */
import {writeFile} from 'node:fs/promises';

export class CliError extends Error {
  constructor(message: string, public detail: Record<string, unknown> = {kind:'usage_error'}) {
    super(message); this.name='CliError';
  }
}

export type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;
export class ApiClient {
  readonly base: string;
  constructor(base = 'http://127.0.0.1:3700', private fetcher: Fetcher = fetch, private token?:string) {
    let url: URL;
    try { url=new URL(base); } catch { throw new CliError('API 地址无效'); }
    if (!['http:','https:'].includes(url.protocol) || !['127.0.0.1','localhost','[::1]'].includes(url.hostname)
      || url.username || url.password || url.pathname!=='/' || url.search || url.hash) {
      throw new CliError('API 仅支持不含凭证或路径的本机 HTTP 地址');
    }
    this.base=url.origin;
  }

  private async response(path: string, method: string, body?: BodyInit, signal?: AbortSignal, headers:Record<string,string>={},timeoutMs=35000) {
    if (!path.startsWith('/api/') || path.includes('\\') || path.includes('#')) throw new CliError('API 路径无效');
    if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>180000)throw new CliError('请求超时须为1至180000毫秒');
    const url=new URL(path,this.base);
    if (url.origin!==this.base) throw new CliError('API 路径越界');
    try {
      return await this.fetcher(url.href, {
        method, redirect:'error', signal:signal ? AbortSignal.any([signal,AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
        headers:{...headers,...(this.token?{Authorization:`Bearer ${this.token}`}:{})},
        body,
      });
    } catch {
      throw new CliError(signal?.aborted?'等待已中断，后台任务继续执行':'API 请求未完成；写入请求请先查状态再决定是否重发',
        {kind:signal?.aborted?'interrupted':'network_error',outcome_unknown:method!=='GET'});
    }
  }

  /** JSON与multipart共用响应协议；写入结果未知时仍须按原任务ID查询，不能在这里重试。 */
  private async readJsonResponse(response:Response,method:string):Promise<any>{
    const detail={http_status:response.status,request_id:response.headers.get('X-Request-ID'),outcome_unknown:method!=='GET'};
    let value:any;
    try{value=JSON.parse(await response.text());}catch{
      throw new CliError(response.ok?'响应不是有效 JSON':'API 返回 HTTP 错误且响应不是有效 JSON',
        {...detail,kind:response.ok?'invalid_response':'http_error'});
    }
    if(!response.ok){
      const message=typeof value?.error==='string'?value.error:typeof value?.message==='string'?value.message:'API 请求失败';
      if(value?.code==='local_queue_full'&&value.dispatched===false)throw new CliError(message,{...detail,kind:'http_error',code:'local_queue_full',outcome_unknown:false,dispatched:false,lane:value.lane,limit:value.limit,waiting:value.waiting,requested:value.requested});
      throw new CliError(message,{...detail,kind:'http_error'});
    }
    return value;
  }

  async json(path:string,method='GET',body?:unknown,signal?:AbortSignal,headers:Record<string,string>={},timeoutMs=35000):Promise<any>{
    const response=await this.response(path,method,body===undefined?undefined:JSON.stringify(body),signal,
      {...(body===undefined?{}:{'Content-Type':'application/json'}),...headers},timeoutMs);
    return this.readJsonResponse(response,method);
  }

  /** Fetch生成multipart boundary；只发送调用者明确列出的材料文件。 */
  async form(path:string,method:string,body:FormData,signal?:AbortSignal,headers:Record<string,string>={}):Promise<any>{
    const response=await this.response(path,method,body,signal,headers);
    return this.readJsonResponse(response,method);
  }

  /** 下载并独占创建文件；保留网络错误，不覆盖已存在的本地文件。 */
  async downloadTo(path:string,out:string,signal?:AbortSignal):Promise<{path:string;bytes:number}>{
    const bytes=await this.download(path,signal);
    try{await writeFile(out,bytes,{flag:'wx',mode:0o600});}
    catch{throw new CliError('无法写入下载文件；目标须不存在且父目录已创建',{kind:'file_error'});}
    return{path:out,bytes:bytes.length};
  }

  async download(path: string, signal?: AbortSignal): Promise<Uint8Array> {
    const response=await this.response(path,'GET',undefined,signal);
    if (!response.ok) throw new CliError('下载失败', {kind:'http_error',http_status:response.status,request_id:response.headers.get('X-Request-ID')});
    try { return new Uint8Array(await response.arrayBuffer()); }
    catch { throw new CliError('下载连接中断',{kind:'network_error'}); }
  }
}
