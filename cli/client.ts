/** 本机 HTTP 客户端。ApiClient 供 CLI 命令使用；只经 API 操作，不读取服务端配置、数据库或凭证。 */
export class CliError extends Error {
  constructor(message: string, public detail: Record<string, unknown> = {kind:'usage_error'}) {
    super(message); this.name='CliError';
  }
}

export type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;
export class ApiClient {
  readonly base: string;
  constructor(base = 'http://127.0.0.1:3700', private fetcher: Fetcher = fetch) {
    let url: URL;
    try { url=new URL(base); } catch { throw new CliError('API 地址无效'); }
    if (!['http:','https:'].includes(url.protocol) || !['127.0.0.1','localhost','[::1]'].includes(url.hostname)
      || url.username || url.password || url.pathname!=='/' || url.search || url.hash) {
      throw new CliError('API 仅支持不含凭证或路径的本机 HTTP 地址');
    }
    this.base=url.origin;
  }

  private async response(path: string, method: string, body?: unknown, signal?: AbortSignal) {
    if (!path.startsWith('/api/') || path.includes('\\') || path.includes('#')) throw new CliError('API 路径无效');
    const url=new URL(path,this.base);
    if (url.origin!==this.base) throw new CliError('API 路径越界');
    try {
      return await this.fetcher(url.href, {
        method, redirect:'error', signal:signal ? AbortSignal.any([signal,AbortSignal.timeout(35000)]) : AbortSignal.timeout(35000),
        headers:body===undefined?undefined:{'Content-Type':'application/json'},
        body:body===undefined?undefined:JSON.stringify(body),
      });
    } catch {
      throw new CliError(signal?.aborted?'等待已中断，后台任务继续执行':'API 请求未完成；写入请求请先查状态再决定是否重发',
        {kind:signal?.aborted?'interrupted':'network_error',outcome_unknown:method!=='GET'});
    }
  }

  async json(path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<any> {
    const response=await this.response(path,method,body,signal);
    const detail={http_status:response.status,request_id:response.headers.get('X-Request-ID'),outcome_unknown:method!=='GET'};
    let value: any;
    try { value=JSON.parse(await response.text()); } catch {
      throw new CliError(response.ok?'响应不是有效 JSON':'API 返回 HTTP 错误且响应不是有效 JSON',
        {...detail,kind:response.ok?'invalid_response':'http_error'});
    }
    if (!response.ok) throw new CliError(typeof value?.error==='string'?value.error:typeof value?.message==='string'?value.message:'API 请求失败', {...detail,kind:'http_error'});
    return value;
  }

  async download(path: string, signal?: AbortSignal): Promise<Uint8Array> {
    const response=await this.response(path,'GET',undefined,signal);
    if (!response.ok) throw new CliError('下载失败', {kind:'http_error',http_status:response.status,request_id:response.headers.get('X-Request-ID')});
    try { return new Uint8Array(await response.arrayBuffer()); }
    catch { throw new CliError('下载连接中断',{kind:'network_error'}); }
  }
}
