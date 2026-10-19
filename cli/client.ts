/**
 * 文件职责：为 CLI 提供受限的本机 HTTP 客户端、JSON/multipart 请求及二进制下载。
 * 关键入口：`json()`、`form()`、`download()` 分别供命令层读写 API、上传显式列出的材料文件和下载产物。
 * 边界：请求只允许本机 API；写请求不重试，网络结果未知时由调用者按原任务/幂等键查询恢复。
 */
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

  private async response(path: string, method: string, body?: BodyInit, signal?: AbortSignal, headers:Record<string,string>={}) {
    if (!path.startsWith('/api/') || path.includes('\\') || path.includes('#')) throw new CliError('API 路径无效');
    const url=new URL(path,this.base);
    if (url.origin!==this.base) throw new CliError('API 路径越界');
    try {
      return await this.fetcher(url.href, {
        method, redirect:'error', signal:signal ? AbortSignal.any([signal,AbortSignal.timeout(35000)]) : AbortSignal.timeout(35000),
        headers:{...headers,...(this.token?{Authorization:`Bearer ${this.token}`}:{})},
        body,
      });
    } catch {
      throw new CliError(signal?.aborted?'等待已中断，后台任务继续执行':'API 请求未完成；写入请求请先查状态再决定是否重发',
        {kind:signal?.aborted?'interrupted':'network_error',outcome_unknown:method!=='GET'});
    }
  }

  async json(path: string, method = 'GET', body?: unknown, signal?: AbortSignal, headers:Record<string,string>={}): Promise<any> {
    const response=await this.response(path,method,body===undefined?undefined:JSON.stringify(body),signal,{...(body===undefined?{}:{'Content-Type':'application/json'}),...headers});
    const detail={http_status:response.status,request_id:response.headers.get('X-Request-ID'),outcome_unknown:method!=='GET'};
    let value: any;
    try { value=JSON.parse(await response.text()); } catch {
      throw new CliError(response.ok?'响应不是有效 JSON':'API 返回 HTTP 错误且响应不是有效 JSON',
        {...detail,kind:response.ok?'invalid_response':'http_error'});
    }
    if (!response.ok) throw new CliError(typeof value?.error==='string'?value.error:typeof value?.message==='string'?value.message:'API 请求失败', {...detail,kind:'http_error'});
    return value;
  }

  /** 使用浏览器/Fetch 自动生成 multipart boundary，调用者只传由显式文件清单构造的 FormData。 */
  async form(path:string,method:string,body:FormData,signal?:AbortSignal,headers:Record<string,string>={}):Promise<any>{
    const response=await this.response(path,method,body,signal,headers);
    const detail={http_status:response.status,request_id:response.headers.get('X-Request-ID'),outcome_unknown:method!=='GET'};
    let value:any;
    try{value=JSON.parse(await response.text());}catch{
      throw new CliError(response.ok?'响应不是有效 JSON':'API 返回 HTTP 错误且响应不是有效 JSON',
        {...detail,kind:response.ok?'invalid_response':'http_error'});
    }
    if(!response.ok)throw new CliError(typeof value?.error==='string'?value.error:typeof value?.message==='string'?value.message:'API 请求失败',{...detail,kind:'http_error'});
    return value;
  }

  async download(path: string, signal?: AbortSignal): Promise<Uint8Array> {
    const response=await this.response(path,'GET',undefined,signal);
    if (!response.ok) throw new CliError('下载失败', {kind:'http_error',http_status:response.status,request_id:response.headers.get('X-Request-ID')});
    try { return new Uint8Array(await response.arrayBuffer()); }
    catch { throw new CliError('下载连接中断',{kind:'network_error'}); }
  }
}
