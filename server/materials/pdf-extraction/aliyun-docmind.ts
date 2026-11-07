/**
 * 职责：调用阿里云 Document Mind 文档解析大模型版，完成本地文件上传、轮询和 layout 分页收集。
 * 关键入口：`AliyunDocMindClient.parseFile()` 返回原始 layout、页数与清理临时 OSS 图片链接后的 Markdown。
 * 使用场景：作为 MinerU／GLM-OCR 之外的独立对照提取能力；当前不改变生产 provider 选择。
 */
import DocMindClientImport, {
 GetDocParserResultRequest,
 QueryDocParserStatusRequest,
 SubmitDocParserJobAdvanceRequest,
} from '@alicloud/docmind-api20220711';
import {$OpenApiUtil} from '@alicloud/openapi-core';
import * as $dara from '@darabonba/typescript';
import {createReadStream} from 'node:fs';
import {stat} from 'node:fs/promises';
import {basename,extname} from 'node:path';

const DocMindClient=((DocMindClientImport as unknown as {default?:typeof DocMindClientImport}).default??DocMindClientImport);

const DEFAULT_ENDPOINT='docmind-api.cn-hangzhou.aliyuncs.com';
const DEFAULT_POLL_INTERVAL_MS=10_000;
const DEFAULT_TIMEOUT_MS=2*60*60*1000;
const LAYOUT_STEP_SIZE=100;

type Layout=Record<string,unknown>;

export interface AliyunDocMindResult{
 jobId:string;
 pageCount:number|null;
 layouts:Layout[];
 markdown:string;
}

const delay=(milliseconds:number,signal?:AbortSignal)=>new Promise<void>((resolve,reject)=>{
 if(signal?.aborted){reject(signal.reason??new Error('文档解析已取消'));return;}
 const timer=setTimeout(done,milliseconds);
 function done(){signal?.removeEventListener('abort',cancel);resolve();}
 function cancel(){clearTimeout(timer);reject(signal?.reason??new Error('文档解析已取消'));}
 signal?.addEventListener('abort',cancel,{once:true});
});

function cleanOssImageUrls(text:string){
 return text
  .replace(/!\[[^\]]*\]\([^\)]*oss[^\)]*\)/gi,'')
  .replace(/https?:\/\/[^\s)]*oss[^\s)]*/gi,'')
  .replace(/\n{3,}/g,'\n\n')
  .trim();
}

function textFromLayouts(layouts:Layout[]){
 const markdown=layouts.map(layout=>typeof layout.markdownContent==='string'?layout.markdownContent:'').join('');
 if(markdown.trim())return cleanOssImageUrls(markdown);
 return cleanOssImageUrls(layouts.map(layout=>typeof layout.text==='string'?layout.text:'').filter(Boolean).join('\n'));
}

export class AliyunDocMindClient{
 private readonly client:InstanceType<typeof DocMindClient>;
 private readonly pollIntervalMs:number;
 private readonly timeoutMs:number;

 constructor(env:NodeJS.ProcessEnv=process.env){
  const accessKeyId=env.ALIYUN_DOCMIND_ACCESS_KEY_ID?.trim();
  const accessKeySecret=env.ALIYUN_DOCMIND_ACCESS_KEY_SECRET?.trim();
  if(!accessKeyId||!accessKeySecret)throw new Error('未配置 ALIYUN_DOCMIND_ACCESS_KEY_ID/ALIYUN_DOCMIND_ACCESS_KEY_SECRET');
  this.client=new DocMindClient(new $OpenApiUtil.Config({
   accessKeyId,
   accessKeySecret,
   endpoint:env.ALIYUN_DOCMIND_ENDPOINT?.trim()||DEFAULT_ENDPOINT,
   connectTimeout:60_000,
   readTimeout:60_000,
   httpProxy:env.HTTP_PROXY??env.http_proxy,
   httpsProxy:env.HTTPS_PROXY??env.https_proxy,
   noProxy:env.NO_PROXY??env.no_proxy,
  }));
  this.pollIntervalMs=Number(env.ALIYUN_DOCMIND_POLL_INTERVAL_MS)||DEFAULT_POLL_INTERVAL_MS;
  this.timeoutMs=Number(env.ALIYUN_DOCMIND_TIMEOUT_MS)||DEFAULT_TIMEOUT_MS;
 }

 async parseFile(path:string,signal?:AbortSignal):Promise<AliyunDocMindResult>{
  const file=await stat(path);
  if(!file.isFile())throw new Error('Document Mind 输入不是文件');
  const request=new SubmitDocParserJobAdvanceRequest({
   fileUrlObject:createReadStream(path),
   fileName:basename(path),
   fileNameExtension:extname(path).slice(1).toLowerCase(),
   outputFormat:['markdown'],
  });
  const response=await this.client.submitDocParserJobAdvance(request,new $dara.RuntimeOptions({}));
  const jobId=response.body?.data?.id;
  if(!jobId)throw new Error(`Document Mind 提交失败${response.body?.code?`：${response.body.code}`:''}`);
  const pageCount=await this.waitForCompletion(jobId,signal);
  const layouts=await this.collectLayouts(jobId,signal);
  if(!layouts.length)throw new Error('Document Mind 返回空 layout');
  const layoutPageCount=Math.max(...layouts.map(layout=>typeof layout.pageNum==='number'?layout.pageNum+1:0));
  const resolvedPageCount=Math.max(pageCount??0,layoutPageCount);
  return{jobId,pageCount:resolvedPageCount||null,layouts,markdown:textFromLayouts(layouts)};
 }

 private async waitForCompletion(jobId:string,signal?:AbortSignal){
  const deadline=Date.now()+this.timeoutMs;
  while(Date.now()<deadline){
   await delay(this.pollIntervalMs,signal);
   const response=await this.client.queryDocParserStatus(new QueryDocParserStatusRequest({id:jobId}));
   const status=response.body?.data?.status?.toLowerCase();
   if(status==='success')return response.body?.data?.pageCountEstimate??null;
   if(status==='fail'||status==='failed')throw new Error('Document Mind 解析失败');
  }
  throw new Error(`Document Mind 轮询超过${Math.round(this.timeoutMs/60_000)}分钟`);
 }

 private async collectLayouts(jobId:string,signal?:AbortSignal){
  const layouts:Layout[]=[];
  while(true){
   if(signal?.aborted)throw signal.reason??new Error('文档解析已取消');
   const response=await this.client.getDocParserResult(new GetDocParserResultRequest({
    id:jobId,
    layoutNum:layouts.length,
    layoutStepSize:LAYOUT_STEP_SIZE,
   }));
   const page=response.body?.data?.layouts;
   if(!Array.isArray(page)||page.length===0)break;
   layouts.push(...page.filter((layout):layout is Layout=>Boolean(layout&&typeof layout==='object'&&!Array.isArray(layout))));
   if(page.length<LAYOUT_STEP_SIZE)break;
  }
  return layouts;
 }
}
