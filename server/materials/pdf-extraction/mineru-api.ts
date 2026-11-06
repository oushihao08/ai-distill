/**
 * 职责：直接调用 MinerU v4 上传、解析和结果轮询 API，并复用 MinerU 块结构转换器。
 * 关键入口：`MineruApiPdfExtractor.extract()` 处理 PDF；DOCX 与原图适配器直接上传原件并投影为单逻辑页；`readMineruResultZip()` 有界读取下载流。
 * 使用场景：PDF 由 API 优先适配器调用并按原策略回退 CLI；DOCX 直接复用 API 上传与轮询。
 */
import {storageDirectory} from '../../paths';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { logEvent } from '../../logging';
import { command } from '../pdf';
import { parseMineruDocxJson, parseMineruJson } from './mineru-cli';
import type { PdfExtractionProvider, PdfExtractionResult } from './types';

const API_ROOT = 'https://mineru.net/api/v4';
const API_TIMEOUT_MS = 30 * 60 * 1000;
const POLL_INTERVAL_MS = 3000;
const MAX_RESULT_ZIP_BYTES = 120 * 1024 * 1024;

type MineruApiOptions = {
 fetcher?: typeof fetch;
 now?: () => number;
 sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
 return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

/** 下载时累计检查ZIP字节数；取消会唤醒正在等待的流读取，不依赖响应提供Content-Length。 */
export async function readMineruResultZip(response:Response,signal:AbortSignal,maxBytes=MAX_RESULT_ZIP_BYTES):Promise<Uint8Array>{
 signal.throwIfAborted();
 const reader=response.body?.getReader();
 if(!reader)throw Object.assign(new Error('MinerU API结果包大小无效'),{reason_code:'download_body_missing',failure_stage:'response_body'});
 const cancel=async()=>{
  try{await reader.cancel();}
  catch{logEvent('extraction.download.cleanup_failed',{level:'error',reason_code:'stream_cleanup_failed'});}
 };
 const abort=()=>{void cancel();};
 signal.addEventListener('abort',abort,{once:true});
 const chunks:Uint8Array[]=[];let size=0;
 try{
  signal.throwIfAborted();
  while(true){
   const {done,value}=await reader.read();
   signal.throwIfAborted();
   if(done)break;
   size+=value.byteLength;
   if(size>maxBytes)throw Object.assign(new Error('MinerU API结果包大小无效'),{reason_code:'download_body_too_large',failure_stage:'response_body'});
   chunks.push(value);
  }
  if(!size)throw Object.assign(new Error('MinerU API结果包大小无效'),{reason_code:'download_body_empty',failure_stage:'response_body'});
  const result=new Uint8Array(size);let offset=0;
  for(const chunk of chunks){result.set(chunk,offset);offset+=chunk.byteLength;}
  return result;
 }catch(error){
  if(signal.aborted||isRecord(error)&&typeof error.reason_code==='string')throw error;
  throw addDownloadFailureContext(error,'response_body','download_body_read_failed');
 }finally{
  signal.removeEventListener('abort',abort);
  await cancel();reader.releaseLock();
 }
}

/** curl 显式绕过环境代理；继续复用有界流读取，取消或超限时终止子进程。 */
export async function downloadMineruResultZip(url:string,signal:AbortSignal):Promise<Uint8Array>{
 signal.throwIfAborted();
 const child=Bun.spawn(['curl','--noproxy','*','--fail','--silent','--location','--proto','=https','--proto-redir','=https','--connect-timeout','30','--max-time','1800',url],{stdout:'pipe',stderr:'ignore'});
 const abort=()=>child.kill();
 signal.addEventListener('abort',abort,{once:true});
 if(signal.aborted)abort();
 try{
  const bytes=await readMineruResultZip(new Response(child.stdout),signal);
  const exitCode=await child.exited;
  signal.throwIfAborted();
  if(exitCode!==0)throw Object.assign(new Error('MinerU结果直连下载失败'),{reason_code:'download_transport_failed',failure_stage:'download_request',exit_code:exitCode});
  return bytes;
 }finally{
  signal.removeEventListener('abort',abort);
  child.kill();
  await child.exited;
 }
}

async function defaultSleep(ms: number, signal: AbortSignal) {
 if (signal.aborted) throw new Error('PDF提取已取消');
 await new Promise<void>((resolveSleep, reject) => {
  const timer = setTimeout(() => { cleanup(); resolveSleep(); }, ms);
  const abort = () => { cleanup(); reject(new Error('PDF提取已取消')); };
  const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); };
  signal.addEventListener('abort', abort, { once: true });
 });
}

function responseData(value: unknown): Record<string, unknown> {
 if (!isRecord(value) || value.code !== 0 || !isRecord(value.data)) {
  const code = isRecord(value) && Number.isInteger(value.code) ? `（错误码 ${value.code}）` : '';
  throw new Error(`MinerU API响应失败${code}`);
 }
 return value.data;
}

// Only network/service failures benefit from a second transport. Local parsing and
// shared credentials cannot be repaired by repeating the upload through CLI.
function permitsCliFallback(error: unknown): boolean {
 const failure=isRecord(error)?error:{};
 // Once MinerU accepted the upload, the CLI would submit the same bytes to the
 // same service again; repeating a pending timed-out task only adds another wait.
 if(failure.reason_code==='provider_timeout'&&failure.provider_task_submitted===true)return false;
 const message=error instanceof Error?error.message:'';
 const status=Number(/HTTP (\d{3})/.exec(message)?.[1]);
 return status>=500||error instanceof TypeError||message.includes('超过30分钟')||error instanceof DOMException&&['TimeoutError','AbortError'].includes(error.name);
}

function providerTimeoutError(phase:string,state:string|undefined,taskSubmitted:boolean){
 return Object.assign(new Error('MinerU API任务超过30分钟'),{reason_code:'provider_timeout',failure_phase:phase,...(state?{provider_state:state}:{}),provider_task_submitted:taskSubmitted});
}

function safeFailureReason(error: unknown) {
 if(isRecord(error)&&error.reason_code==='provider_timeout')return'provider_timeout';
 const knownReason=isRecord(error)&&typeof error.reason_code==='string'&&error.reason_code.startsWith('download_')?error.reason_code:'';
 if(/^[a-z][a-z0-9_]{0,79}$/.test(knownReason))return knownReason;
 const message = error instanceof Error ? error.message : '';
 const status = /HTTP (\d{3})/.exec(message)?.[1];
 if (status) return `http_${status}`;
 if (message.includes('超过30分钟')) return 'timeout';
 if (message.includes('取消')) return 'cancelled';
 if (message.includes('解析任务失败')) return 'task_failed';
 if (message.includes('content_list')) return 'invalid_structure';
 return 'request_or_response_failed';
}

function safeNetworkErrorCode(error:unknown):string|undefined{
 let current:unknown=error;
 for(let depth=0;depth<4&&isRecord(current);depth++){
  const code=current.code;
  if(typeof code==='string'&&/^(?:UND_ERR_[A-Z0-9_]{1,40}|ERR_[A-Z0-9_]{1,40}|E[A-Z0-9_]{1,30})$/.test(code))return code;
  current=current.cause;
 }
 return undefined;
}

function addDownloadFailureContext(error:unknown,failure_stage:string,reason_code?:string,response_status?:number){
 const context={failure_stage,...(reason_code?{reason_code}:{}),...(response_status?{response_status}:{}),...(safeNetworkErrorCode(error)?{network_error_code:safeNetworkErrorCode(error)}:{})};
 if(error instanceof Error){
  try{return Object.assign(error,context);}catch(assignmentError){return Object.assign(new Error('MinerU结果下载失败',{cause:assignmentError}),context);}
 }
 return Object.assign(new Error('MinerU结果下载失败'),context);
}

async function checkedJson(response: Response, stage: string): Promise<unknown> {
 if (!response.ok) throw new Error(`MinerU API ${stage}返回HTTP ${response.status}`);
 try { return await response.json(); }
 catch { throw new Error(`MinerU API ${stage}返回无效JSON`); }
}

export async function runUnzip(args: string[], maxBytes: number,signal?:AbortSignal): Promise<Uint8Array> {
 if(signal?.aborted)throw signal.reason;
 const child = Bun.spawn(['unzip', ...args], { stdout: 'pipe', stderr: 'ignore' });
 const abort=()=>child.kill();signal?.addEventListener('abort',abort,{once:true});
 if(signal?.aborted)abort();
 const reader=child.stdout.getReader(),chunks:Uint8Array[]=[];
 let size=0;
 try{
  while(true){
   const {done,value}=await reader.read();if(done)break;
   if(signal?.aborted)throw signal.reason;
   size+=value.byteLength;
   if(size>maxBytes)throw new Error('MinerU API结果包超过输出限制');
   chunks.push(value);
  }
  const exitCode=await child.exited;
  if(signal?.aborted)throw signal.reason;
  if(exitCode!==0)throw new Error('MinerU API结果包结构无效');
  const output=new Uint8Array(size);let offset=0;
  for(const chunk of chunks){output.set(chunk,offset);offset+=chunk.byteLength;}
  return output;
 }finally{
  signal?.removeEventListener('abort',abort);
  child.kill();
  await reader.cancel().catch(()=>{logEvent('extraction.unzip.cleanup_failed',{level:'error',reason_code:'stream_cleanup_failed'});});
  await child.exited;
 }
}

function resultZipUrl(data: Record<string, unknown>): string {
 const rows = Array.isArray(data.extract_result) ? data.extract_result : [];
 const row = rows.find(item => isRecord(item) && typeof item.state === 'string');
 if (!isRecord(row)) throw new Error('MinerU API未返回解析任务结果');
 if (row.state === 'failed') throw new Error('MinerU API解析任务失败');
 if (row.state !== 'done' || typeof row.full_zip_url !== 'string') throw new Error('MinerU API解析结果尚未就绪');
 const url = new URL(row.full_zip_url);
 if (url.protocol !== 'https:') throw new Error('MinerU API结果地址无效');
 return url.toString();
}

export class MineruApiPdfExtractor implements PdfExtractionProvider {
 readonly id = 'mineru-api' as const;
 private readonly fetcher: typeof fetch;
 private readonly now: () => number;
 private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;

 constructor(private readonly env: NodeJS.ProcessEnv = process.env, options: MineruApiOptions = {}, private readonly inputFormat: 'pdf' | 'docx' | 'image' = 'pdf') {
  this.fetcher = options.fetcher ?? fetch;
  this.now = options.now ?? Date.now;
  this.sleep = options.sleep ?? defaultSleep;
 }

 async extract(path: string, signal?: AbortSignal): Promise<PdfExtractionResult> {
  const bytes = await readFile(path), sha256 = createHash('sha256').update(bytes).digest('hex');
  let pageCount = 1;
  if (this.inputFormat === 'pdf') {
   const info = await command(['pdfinfo', path]);
   pageCount = Number(info.match(/^Pages:\s+(\d+)/m)?.[1]);
   if (!Number.isInteger(pageCount) || pageCount < 1) throw new Error('PDF页数无效');
  }
  if (pageCount > 200 || bytes.byteLength > 200 * 1024 * 1024) throw new Error('文件超过MinerU API单文件限制');
  const token = this.env.MINERU_KEY;
  if (!token) throw new Error('未配置 MINERU_KEY');
  if (signal?.aborted) throw new Error('PDF提取已取消');

  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, API_TIMEOUT_MS);
  const startedAt = this.now();
  const fetchOptions = { signal: controller.signal };
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
  const diagnosticId=crypto.randomUUID();
  const diagnosticDirectory=resolve(storageDirectory(this.env),'.mineru-diagnostics',diagnosticId);
  let pollCount=0,lastPollLogAt=0,lastRequestStartedAt=0,lastRequestFinishedAt=0;
  let tempZipPath: string | undefined, completed=false,batchId:string|undefined,phase='request_upload_url',providerState:string|undefined,taskSubmitted=false;
  const recordPhase=async(nextPhase:string,state?:string)=>{
   phase=nextPhase;if(state!==undefined)providerState=state;
   await writeFile(resolve(diagnosticDirectory,'metadata.json'),JSON.stringify({source_sha256:sha256,page_count:pageCount,input_format:this.inputFormat,batch_id:batchId,phase,provider_state:providerState,observed_at:new Date().toISOString()}),{mode:0o600});
   logEvent('extraction.api.phase',{level:'info',provider:this.id,diagnostic_id:diagnosticId,failure_phase:phase,state:providerState??phase,duration_ms:Math.max(0,this.now()-startedAt)});
  };
  try {
   await mkdir(diagnosticDirectory,{recursive:true,mode:0o700});
   await recordPhase('request_upload_url');
   const request = await this.fetcher(`${API_ROOT}/file-urls/batch`, {
    ...fetchOptions, method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ files: [{ name: basename(path), data_id: sha256 }], model_version: 'vlm' }),
   });
   const uploadData = responseData(await checkedJson(request, '上传地址申请'));
   const urls = uploadData.file_urls;
   if (typeof uploadData.batch_id !== 'string' || !Array.isArray(urls) || typeof urls[0] !== 'string') throw new Error('MinerU API上传地址响应缺字段');
   batchId=uploadData.batch_id;
   const uploadUrl = new URL(urls[0]);
   if (uploadUrl.protocol !== 'https:') throw new Error('MinerU API上传地址无效');
   await recordPhase('upload_file');
   const upload = await this.fetcher(uploadUrl, { ...fetchOptions, method: 'PUT', body: bytes });
   if (!upload.ok) throw new Error(`MinerU API文件上传返回HTTP ${upload.status}`);
   taskSubmitted=true;
   logEvent('extraction.api.upload_completed',{provider:this.id,diagnostic_id:diagnosticId,http_status:upload.status,input_bytes:bytes.byteLength,page_count:pageCount,duration_ms:Math.max(0,this.now()-startedAt)});
   await recordPhase('poll_result');

   let zipUrl: string | undefined;
   const deadline = startedAt + API_TIMEOUT_MS;
   while (this.now() < deadline) {
    if (controller.signal.aborted) throw new Error(signal?.aborted ? 'PDF提取已取消' : 'MinerU API任务超过30分钟');
    lastRequestStartedAt=this.now();
    const poll = await this.fetcher(`${API_ROOT}/extract-results/batch/${encodeURIComponent(batchId)}`, { ...fetchOptions, headers });
    const pollBody=await checkedJson(poll,'任务查询');
    lastRequestFinishedAt=this.now();
    const safeId=(v:unknown)=>typeof v==='string'&&/^[a-zA-Z0-9_-]{1,128}$/.test(v)?v:undefined;
    const envelope=isRecord(pollBody)?pollBody:{};
    // 私有快照覆盖保存最新响应摘要；不保存材料文件名、正文或签名URL。
    const payload=isRecord(envelope.data)?envelope.data:{};
    const resultRows=Array.isArray(payload.extract_result)?payload.extract_result:[];
    await writeFile(resolve(diagnosticDirectory,'poll-latest.json'),JSON.stringify({observed_at:new Date().toISOString(),batch_id:batchId,http_status:poll.status,code:envelope.code,trace_id:safeId(envelope.trace_id),request_id:safeId(poll.headers.get('x-request-id')),request_ms:Math.max(0,lastRequestFinishedAt-lastRequestStartedAt),elapsed_ms:Math.max(0,this.now()-startedAt),poll_count:pollCount+1,response_keys:Object.keys(envelope),data_keys:Object.keys(payload),results:resultRows.filter(isRecord).map(row=>({state:row.state,data_id_matches:row.data_id===sha256,file_name_matches:row.file_name===basename(path),has_zip:typeof row.full_zip_url==='string',error_code:safeId(row.err_code),error_message_present:typeof row.err_msg==='string'&&row.err_msg.length>0,progress:isRecord(row.extract_progress)?{extracted_pages:row.extract_progress.extracted_pages,total_pages:row.extract_progress.total_pages}:undefined,result_keys:Object.keys(row)}))}),{mode:0o600});
    const data = responseData(pollBody);
    const rows = Array.isArray(data.extract_result) ? data.extract_result : [];
    const item = rows.find(result => isRecord(result) && (result.data_id === sha256 || result.file_name === basename(path)));
    const state=isRecord(item)&&['waiting-file','pending','running','done','failed','converting'].includes(String(item.state))?String(item.state):'missing_result_item';
    pollCount++;
    if(state!==providerState||this.now()-lastPollLogAt>=60000){
     const progress=isRecord(item)&&isRecord(item.extract_progress)?item.extract_progress:{};
     logEvent('extraction.api.poll_observed',{provider:this.id,diagnostic_id:diagnosticId,http_status:poll.status,elapsed_ms:Math.max(0,lastRequestFinishedAt-lastRequestStartedAt),state,attempt_count:pollCount,material_count:rows.length,page_count:pageCount,duration_ms:Math.max(0,this.now()-startedAt),...(Number.isFinite(progress.extracted_pages)?{actual_count:Number(progress.extracted_pages)}:{}),...(Number.isFinite(progress.total_pages)?{expected_count:Number(progress.total_pages)}:{})});
     lastPollLogAt=this.now();
    }
    if(state!==providerState)await recordPhase('poll_result',state);
    if (isRecord(item)) {
     if (item.state === 'failed') throw new Error('MinerU API解析任务失败');
     if (item.state === 'done') { zipUrl = resultZipUrl({ extract_result: [item] }); break; }
    }
    await this.sleep(POLL_INTERVAL_MS, controller.signal);
   }
   if (!zipUrl) throw providerTimeoutError(phase,providerState,taskSubmitted);

   await recordPhase('download_result');
   let zipBytes:Uint8Array;
   // 注入的 fetcher 保持可替换传输契约；实际运行用 curl 显式直连 CDN。
   if(this.fetcher===fetch){
    zipBytes=await downloadMineruResultZip(zipUrl,controller.signal);
   }else{
    let zipResponse:Response;
    try{zipResponse=await this.fetcher(zipUrl,{...fetchOptions,headers:{Accept:'application/octet-stream'}});}
    catch(error){throw addDownloadFailureContext(error,'download_request','download_request_failed');}
    if(!zipResponse.ok)throw addDownloadFailureContext(new Error(`MinerU API结果下载返回HTTP ${zipResponse.status}`),'download_http_response','download_http_error',zipResponse.status);
    zipBytes=await readMineruResultZip(zipResponse,controller.signal);
   }
   await recordPhase('read_result');
   tempZipPath = resolve(diagnosticDirectory, 'result.zip');
   await writeFile(tempZipPath, zipBytes, { mode: 0o600, flag: 'wx' });
   const listingBytes = await runUnzip(['-Z1', tempZipPath], 2 * 1024 * 1024,controller.signal);
   const entries = new TextDecoder().decode(listingBytes).split(/\r?\n/).filter(Boolean);
   const contentList = entries.find(entry => /(?:^|\/)content_list\.json$/i.test(entry) || /_content_list\.json$/i.test(entry));
   if (!contentList || contentList.split('/').includes('..')) throw new Error('MinerU API结果包缺少content_list.json');
   const content = await runUnzip(['-p', tempZipPath, contentList], 64 * 1024 * 1024,controller.signal);
   await writeFile(resolve(diagnosticDirectory, 'response.json'),content,{mode:0o600,flag:'wx'});
   let raw: unknown;
   try { raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(content)); }
   catch { throw new Error('MinerU API content_list.json无效'); }
   const pages = this.inputFormat === 'pdf' ? parseMineruJson(raw, pageCount) : parseMineruDocxJson(raw);
   if(this.inputFormat==='image'&&(pages.length!==1||pages[0]?.page!==1))throw new Error('MinerU图片结果不是单页结构');
   logEvent('extraction.api.completed', { level: 'info', provider: this.id, page_count: pages.length, duration_ms: Math.max(0, this.now() - startedAt) });
   completed=true;
   return { pages, sha256, provider: this.id };
  } catch (error) {
   const localTimeout=controller.signal.aborted&&!signal?.aborted;
   const reportedError=localTimeout?providerTimeoutError(phase,providerState,taskSubmitted):error;
   const durationMs=Math.max(0,this.now()-startedAt);
   try{await writeFile(resolve(diagnosticDirectory,'failure-context.json'),JSON.stringify({observed_at:new Date().toISOString(),phase,provider_state:providerState,batch_id:batchId,poll_count:pollCount,last_request_started_at:lastRequestStartedAt,last_request_finished_at:lastRequestFinishedAt,request_in_flight:lastRequestStartedAt>lastRequestFinishedAt,elapsed_ms:durationMs,timeout_ms:API_TIMEOUT_MS,local_aborted:controller.signal.aborted,parent_aborted:signal?.aborted??false,parent_reason:isRecord(signal?.reason)?signal.reason.reason_code:undefined,network_error_code:safeNetworkErrorCode(reportedError)}),{mode:0o600});}catch{logEvent('extraction.diagnostics_save_failed',{level:'error',diagnostic_id:diagnosticId,reason_code:'diagnostics_write_failed'});}
   logEvent('extraction.api.failed', { level: 'error', provider: this.id, reason_code: safeFailureReason(reportedError),failure_phase:phase,state:providerState,diagnostic_id:diagnosticId,page_count:pageCount,attempt_count:pollCount,timeout_ms:API_TIMEOUT_MS,provider_task_submitted:taskSubmitted,local_aborted:controller.signal.aborted,parent_aborted:signal?.aborted??false,...(isRecord(reportedError)&&typeof reportedError.failure_stage==='string'?{failure_stage:reportedError.failure_stage}:{}),...(isRecord(reportedError)&&typeof reportedError.response_status==='number'?{response_status:reportedError.response_status}:{}),...(isRecord(reportedError)&&typeof reportedError.network_error_code==='string'?{network_error_code:reportedError.network_error_code}:{}),duration_ms:durationMs });
   throw reportedError;
  } finally {
   clearTimeout(timer);
   signal?.removeEventListener('abort', abort);
   if (completed) {
    try { await rm(diagnosticDirectory, { recursive: true, force: true }); }
    catch { logEvent('extraction.diagnostics_cleanup_failed', { level: 'error', provider: this.id, diagnostic_id: diagnosticId, reason_code: 'diagnostics_cleanup_failed' }); }
   }
  }
 }
}

/** DOCX reuses the verified v4 transport and maps native document blocks to one logical page. */
export class MineruApiDocxExtractor extends MineruApiPdfExtractor {
 constructor(env: NodeJS.ProcessEnv = process.env, options: MineruApiOptions = {}) { super(env, options, 'docx'); }
}

/** PNG/JPEG 原件直传 MinerU API，不转PDF，不经CLI或其他OCR provider回退。 */
export class MineruApiImageExtractor extends MineruApiPdfExtractor {
 constructor(env: NodeJS.ProcessEnv = process.env, options: MineruApiOptions = {}) { super(env, options, 'image'); }
}

export class MineruApiFirstPdfExtractor implements PdfExtractionProvider {
 readonly id = 'mineru-api' as const;

 constructor(private readonly api: PdfExtractionProvider, private readonly cli: PdfExtractionProvider) {}

 async extract(path: string, signal?: AbortSignal): Promise<PdfExtractionResult> {
  try { return await this.api.extract(path, signal); }
  catch (apiError) {
   if (signal?.aborted) throw apiError;
   if (!permitsCliFallback(apiError)) {
    const failure=isRecord(apiError)?apiError:{};
    if(failure.reason_code==='provider_timeout'&&failure.provider_task_submitted===true){
     logEvent('extraction.cli.fallback.skipped',{level:'warn',provider:'mineru-cli',reason_code:'provider_task_submitted_timeout',failure_phase:failure.failure_phase,state:failure.provider_state});
    }
    throw apiError;
   }
   logEvent('extraction.cli.fallback.started', { level: 'warn', provider: 'mineru-cli', reason_code: safeFailureReason(apiError) });
   return await this.cli.extract(path, signal);
  }
 }
}
