/**
 * 职责：独立调用智谱 GLM-OCR 版面解析，并将 PDF、图片及 LibreOffice 渲染的 DOCX 页级布局转换为稳定 DocumentBlock 结构。
 * 关键入口：`GlmOcrPdfExtractor`、`GlmOcrImageExtractor`、`GlmOcrDocxExtractor`；`parseGlmOcrResponse()` 负责严格页数、块结构和文字保留校验。
 * 使用场景：显式选择 `glm-ocr` 或由双 OCR 池切换激活时调用；请求、响应转换与凭证同 MinerU 保持隔离。
 */
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {mkdir,mkdtemp,readFile,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename,extname,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {promisify} from 'node:util';
import {createLibreOfficeEnvironment} from '../libreoffice';
import {command} from '../pdf';
import {documentBlocksToText,type DocumentBlock,type DocumentCell,type DocumentRow,type Page} from '../pdf';
import {runUnzip} from './mineru-api';
import type {PdfExtractionProvider,PdfExtractionResult} from './types';

export const GLM_OCR_VERSION='glm-ocr-layout-structured-v1';
const MAX_BYTES=50*1024*1024,MAX_IMAGE_BYTES=10*1024*1024,MAX_PAGES=100,TIMEOUT_MS=30*60*1000;
const runFile=promisify(execFile);
const isRecord=(value:unknown):value is Record<string,unknown>=>Boolean(value&&typeof value==='object'&&!Array.isArray(value));

type GlmErrorKind='authentication'|'rate_limit'|'network'|'timeout'|'provider'|'configuration'|'invalid_response';
// 仅附带固定分类与状态，不携带供应商正文、原始异常 cause、请求地址或凭证。
function glmError(kind:GlmErrorKind,reason_code:string,message:string,http_status?:number){
 return Object.assign(new Error(message),{kind,reason_code,...(http_status!==undefined?{http_status}:{})});
}

function checkStopped(signal:AbortSignal|undefined,active:AbortSignal){
 // 外层取消/截止原因由任务拥有，保留其原始身份，不能包装成网络失败。
 signal?.throwIfAborted();
 if(active.aborted)throw glmError('timeout','glm_ocr_timeout','GLM-OCR请求超过30分钟');
}

/** 同一次 layout 请求覆盖响应体读取；任何失败都不自动重传原件。 */
async function requestGlmLayout(bytes:Buffer,env:NodeJS.ProcessEnv,fetcher:typeof fetch,active:AbortSignal,signal?:AbortSignal,cropImages=false,mimeType:'application/pdf'|'image/png'|'image/jpeg'='application/pdf'):Promise<unknown>{
 checkStopped(signal,active);
 const key=env.ZHIPU_API_KEY?.trim();
 if(!key)throw glmError('configuration','glm_ocr_missing_key','未配置 ZHIPU_API_KEY');
 let url:URL;
 try{
  url=new URL(`${(env.ZHIPU_BASE_URL??'https://open.bigmodel.cn/api/paas/v4').replace(/\/$/,'')}/layout_parsing`);
  if(!['https:','http:'].includes(url.protocol)||url.username||url.password)throw new Error('invalid endpoint');
 }catch{throw glmError('configuration','glm_ocr_invalid_endpoint','GLM-OCR接口地址配置无效');}
 let response:Response;
 try{
  response=await fetcher(url,{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify({model:'glm-ocr',file:`data:${mimeType};base64,${bytes.toString('base64')}`,...(cropImages?{return_crop_images:true}:{}),request_id:crypto.randomUUID()}),signal:active});
 }catch(error){
  checkStopped(signal,active);
  if(error instanceof Error&&error.name==='TimeoutError')throw glmError('timeout','glm_ocr_timeout','GLM-OCR请求超时');
  throw glmError('network','glm_ocr_request_failed','GLM-OCR请求连接失败');
 }
 checkStopped(signal,active);
 if(!response.ok){
  const status=response.status,kind=status===401||status===403?'authentication':status===429?'rate_limit':status===408||status===504?'timeout':'provider';
  const failure=glmError(kind,`glm_ocr_http_${status}`,`GLM-OCR返回HTTP ${status}`,status);
  // 不读取错误响应正文；释放响应流，且清理异常不能覆盖已收到的 HTTP 失败。
  try{await response.body?.cancel();}catch{throw failure;}
  throw failure;
 }
 let raw:unknown;
 try{raw=await response.json();}
 catch(error){
  checkStopped(signal,active);
  if(error instanceof Error&&error.name==='TimeoutError')throw glmError('timeout','glm_ocr_timeout','GLM-OCR响应读取超时',response.status);
  if(error instanceof SyntaxError)throw glmError('invalid_response','glm_ocr_invalid_json','GLM-OCR返回无效JSON',response.status);
  throw glmError('network','glm_ocr_response_read_failed','GLM-OCR响应读取失败',response.status);
 }
 checkStopped(signal,active);
 return raw;
}

function decodeHtml(value:string){
 const named:Record<string,string>={nbsp:'\u00a0',amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"};
 return value.replace(/&(#x[\da-f]+|#\d+|nbsp|amp|lt|gt|quot|apos);/gi,(raw,entity:string)=>{
  if(entity[0]!=='#')return named[entity.toLowerCase()]!;
  const point=entity[1]?.toLowerCase()==='x'?Number.parseInt(entity.slice(2),16):Number(entity.slice(1));
  return point>0&&point<=0x10ffff&&!(point>=0xd800&&point<=0xdfff)?String.fromCodePoint(point):raw;
 });
}

function htmlText(value:string){
 if(/<\s*\/?\s*(?:script|style)(?=[\s/>])/i.test(value))return value;
 const inline=new Set(['b','strong','i','em','u','s','sub','sup','span']),block=new Set(['p','div','html','body']),stack:string[]=[];
 let output='',cursor=0,trailingBoundary=false;
 const append=(text:string)=>{if(text){output+=decodeHtml(text);trailingBoundary=false;}};
 const newline=()=>{if(output&&!output.endsWith('\n')){output+='\n';trailingBoundary=true;}};
 for(const match of value.matchAll(/<\s*(\/?)\s*([a-z][a-z0-9]*)(?=[\s/>])((?:"[^"<>]*"|'[^'<>]*'|[^'"<>])*)>/gi)){
  append(value.slice(cursor,match.index));cursor=match.index!+match[0].length;
  const name=match[2]!.toLowerCase(),closing=Boolean(match[1]);
  if(name==='br'&&!closing){output+='\n';trailingBoundary=false;continue;}
  if(!inline.has(name)&&!block.has(name)){output+=match[0];trailingBoundary=false;continue;}
  if(closing){if(stack.pop()!==name)return value;}else if(!/\/\s*>$/.test(match[0]))stack.push(name);
  if(block.has(name))newline();
 }
 append(value.slice(cursor));if(stack.length)return value;
 return trailingBoundary?output.slice(0,-1):output;
}

function parseTableHtml(html:string):DocumentRow[]{
 const rows:DocumentRow[]=[];let row:DocumentCell[]|undefined,cell:DocumentCell|undefined;
 const tokens=html.match(/<(?:(?:"[^"<>]*"|'[^'<>]*'|[^'"<>])*)>|[^<]+|</g)??[];
 for(const token of tokens){
  if(token[0]!=='<'){if(cell)cell.text+=token;else if(token.trim())return [];continue;}
  const closing=/^<\s*\//.test(token),name=token.match(/^<\s*\/?\s*([a-z0-9]+)/i)?.[1]?.toLowerCase();
  if(!name){if(cell)cell.text+=token;else if(token.trim())return [];continue;}
  if(name==='tr'){
   if(closing){if(!row||cell)return[];if(row.length)rows.push({cells:row});row=undefined;}
   else{if(row)return[];row=[];}
  }else if(name==='td'||name==='th'){
   if(closing){if(!cell)return[];cell.text=htmlText(cell.text);cell=undefined;}
   else if(row){
    if(cell)return[];
    const span=(attribute:string)=>{const raw=token.match(new RegExp(`\\b${attribute}\\s*=\\s*["']?(\\d+)`,'i'))?.[1];return raw?Math.max(1,Number(raw)):undefined;};
    cell={text:'',...(span('rowspan')?{rowSpan:span('rowspan')}:{ }),...(span('colspan')?{columnSpan:span('colspan')}:{ })};row.push(cell);
   }else return[];
  }else if(cell)cell.text+=token;
  else if(!['table','thead','tbody','tfoot','colgroup','col'].includes(name))return[];
 }
 return row||cell?[]:rows;
}

function cleanInlineMarkdown(value:string){
 return value.replace(/(?<!\*)\*\*(?!\*)(.+?)(?<!\*)\*\*(?!\*)/g,'$1').replace(/(?<!_)__(?!_)(.+?)(?<!_)__(?!_)/g,'$1').replace(/`([^`]+)`/g,'$1');
}

function unwrapKnownLayoutHtml(value:string){
 const trimmed=value.trim(),div=/^<div\s+align=["'](?:center|left|right)["']\s*>([\s\S]*)<\/div>$/i.exec(trimmed);
 return div?div[1]!.trim():trimmed.replace(/<br\s*\/?\s*>/gi,'\n');
}

function textBlocks(id:string,content:string,defaultKind:'paragraph'|'caption'|'footnote'='paragraph'):DocumentBlock[]{
 const blocks:DocumentBlock[]=[],lines=unwrapKnownLayoutHtml(content).replace(/\r\n?/g,'\n').split('\n'),paragraph:string[]=[];
 const flush=()=>{if(paragraph.length){blocks.push({id:`${id}-${blocks.length+1}`,kind:defaultKind,text:cleanInlineMarkdown(paragraph.join('\n'))});paragraph.length=0;}};
 for(const raw of lines){
  const line=raw.trim();if(!line){flush();continue;}
  const heading=/^(#{1,6})\s+(.+)$/.exec(line);
  if(heading){flush();blocks.push({id:`${id}-${blocks.length+1}`,kind:'heading',level:heading[1]!.length,text:cleanInlineMarkdown(heading[2]!)});continue;}
  const formula=/^\$\s*([\s\S]*?)\s*\$$/.exec(line);
  if(formula){flush();blocks.push({id:`${id}-${blocks.length+1}`,kind:'formula',text:formula[1]!});continue;}
  paragraph.push(line);
 }
 flush();return blocks;
}

function blockFromLayout(value:unknown,page:number,index:number):DocumentBlock[]{
 if(!isRecord(value))throw glmError('invalid_response','glm_ocr_invalid_block',`GLM-OCR第${page}页布局块无效`);
 const content=value.content;
 if(content===undefined)return[];
 if(typeof content!=='string')throw glmError('invalid_response','glm_ocr_invalid_content',`GLM-OCR第${page}页布局块正文无效`);
 const id=`p${page}-b${index+1}`,label=typeof value.label==='string'?value.label.toLowerCase():'',native=typeof value.native_label==='string'?value.native_label.toLowerCase():'';
 if(label==='table'||native==='table'){
  const rows=parseTableHtml(content);
  return rows.length?[{id,kind:'table',rows}]:textBlocks(id,content);
 }
 const text=cleanInlineMarkdown(unwrapKnownLayoutHtml(content));
 if(native==='doc_title')return[{id,kind:'heading',text:text.replace(/^#+\s*/,''),level:1}];
 if(native==='paragraph_title')return[{id,kind:'heading',text:text.replace(/^#+\s*/,''),level:2}];
 if(native.includes('caption')||native==='figure_title')return textBlocks(id,content,'caption');
 if(native.includes('title')||native.includes('heading'))return[{id,kind:'heading',text:text.replace(/^#+\s*/,''),level:Math.max(1,Math.min(6,Number(value.level)||2))}];
 if(native.includes('footnote'))return textBlocks(id,content,'footnote');
 if(native.includes('formula')||native.includes('equation'))return[{id,kind:'formula',text:text.replace(/^\$\s*|\s*\$$/g,'')}];
 if(native.includes('code')||native.includes('algorithm'))return[{id,kind:'code',text}];
 if(native.includes('list'))return[{id,kind:'list',items:text.split(/\r?\n/).map(item=>item.replace(/^\s*(?:[-*•]|\d+[.)、])\s*/,''))}];
 return textBlocks(id,content);
}

export function parseGlmOcrResponse(value:unknown,expectedPages:number):Page[]{
 if(!isRecord(value)||!isRecord(value.data_info)||value.model!=='glm-ocr')throw glmError('invalid_response','glm_ocr_invalid_structure','GLM-OCR响应结构无效');
 const reported=value.data_info.num_pages,details=value.layout_details;
 if(reported!==expectedPages||!Array.isArray(details)||details.length!==expectedPages)throw glmError('invalid_response','glm_ocr_page_mismatch','GLM-OCR返回页数与原件不一致');
 return details.map((layout,pageIndex)=>{
  if(!Array.isArray(layout))throw glmError('invalid_response','glm_ocr_invalid_layout',`GLM-OCR第${pageIndex+1}页布局无效`);
  const structure=layout.flatMap((block,index)=>blockFromLayout(block,pageIndex+1,index));
  const text=documentBlocksToText(structure),issues=text.trim()?undefined:['empty_page'];
  return{page:pageIndex+1,text,structure,method:'ocr',model:'glm-ocr',...(pageIndex===0&&value.usage!==undefined?{usage:value.usage}:{}),...(issues?{issues}:{})};
 });
}

/** 保图模式专用：只取版面识别出的独立图片裁块，正文仍由原提取供应商负责。 */
export async function extractGlmOcrImageRegions(path:string,signal?:AbortSignal,env:NodeJS.ProcessEnv=process.env,fetcher:typeof fetch=fetch):Promise<{page:number;position:number;native_label:string;bytes:Uint8Array;content_type:'image/png'|'image/jpeg'}[]>{
 signal?.throwIfAborted();
 const bytes=await readFile(path),info=await command(['pdfinfo',path]),pageCount=Number(info.match(/^Pages:\s+(\d+)/m)?.[1]);
 if(!Number.isInteger(pageCount)||pageCount<1||bytes.length>MAX_BYTES||pageCount>MAX_PAGES)throw new Error('GLM-OCR图片裁块原件超过限制');
 const active=signal?AbortSignal.any([signal,AbortSignal.timeout(TIMEOUT_MS)]):AbortSignal.timeout(TIMEOUT_MS);
 const raw=await requestGlmLayout(bytes,env,fetcher,active,signal,true);
 if(!isRecord(raw)||raw.model!=='glm-ocr'||!isRecord(raw.data_info)||raw.data_info.num_pages!==pageCount||!Array.isArray(raw.layout_details)||raw.layout_details.length!==pageCount)throw new Error('GLM-OCR图片裁块页数或结构无效');
 const images:{page:number;position:number;native_label:string;bytes:Uint8Array;content_type:'image/png'|'image/jpeg'}[]=[];
 for(const [pageIndex,layout] of raw.layout_details.entries()){
  if(!Array.isArray(layout))throw new Error('GLM-OCR图片裁块布局无效');
  for(const [position,block] of layout.entries()){
   if(!isRecord(block)||block.label!=='image')continue;
   if(typeof block.content!=='string'||!block.content)throw new Error('GLM-OCR图片裁块缺少下载地址');
   const url=new URL(block.content);
   if(url.protocol!=='https:'||!url.hostname.endsWith('.ufileos.com'))throw new Error('GLM-OCR图片裁块地址不受信任');
   const crop=await fetcher(url,{signal:active,redirect:'error'});
   if(!crop.ok||Number(crop.headers.get('content-length')??0)>10*1024*1024)throw new Error('GLM-OCR图片裁块下载失败或过大');
   const data=new Uint8Array(await crop.arrayBuffer());
   if(data.byteLength>10*1024*1024)throw new Error('GLM-OCR图片裁块过大');
   const content_type=data[0]===0x89&&data[1]===0x50?'image/png':data[0]===0xff&&data[1]===0xd8?'image/jpeg':undefined;
   if(!content_type)throw new Error('GLM-OCR图片裁块格式无效');
   images.push({page:pageIndex+1,position,native_label:typeof block.native_label==='string'?block.native_label:'',bytes:data,content_type});
  }
 }
 return images;
}

export class GlmOcrPdfExtractor implements PdfExtractionProvider{
 readonly id='glm-ocr' as const;
 constructor(private readonly env:NodeJS.ProcessEnv=process.env,private readonly fetcher:typeof fetch=fetch){}
 async extract(path:string,signal?:AbortSignal):Promise<PdfExtractionResult>{
  signal?.throwIfAborted();
  const bytes=await readFile(path),sha256=createHash('sha256').update(bytes).digest('hex');
  const info=await command(['pdfinfo',path]),pageCount=Number(info.match(/^Pages:\s+(\d+)/m)?.[1]);
  if(!Number.isInteger(pageCount)||pageCount<1)throw new Error('PDF页数无效');
  if(bytes.length>MAX_BYTES||pageCount>MAX_PAGES)throw new Error('文件超过GLM-OCR单文件限制（50 MiB、100页），请先使用材料预处理切片');
  const timeout=AbortSignal.timeout(TIMEOUT_MS),active=signal?AbortSignal.any([signal,timeout]):timeout;
  const raw=await requestGlmLayout(bytes,this.env,this.fetcher,active,signal);
  return{provider:this.id,sha256,pages:parseGlmOcrResponse(raw,pageCount)};
 }
}

/** PNG/JPG/JPEG 原件直传 GLM-OCR layout_parsing，投影为单页结构，无文字图片保留 empty_page。 */
export class GlmOcrImageExtractor implements PdfExtractionProvider{
 readonly id='glm-ocr' as const;
 constructor(private readonly env:NodeJS.ProcessEnv=process.env,private readonly fetcher:typeof fetch=fetch){}
 async extract(path:string,signal?:AbortSignal):Promise<PdfExtractionResult>{
  signal?.throwIfAborted();
  const bytes=await readFile(path),sha256=createHash('sha256').update(bytes).digest('hex');
  if(bytes.length>MAX_IMAGE_BYTES)throw glmError('configuration','glm_ocr_image_too_large','图片超过GLM-OCR单文件限制（10 MiB）');
  const ext=extname(path).toLowerCase();
  const mimeType=bytes[0]===0x89&&bytes[1]===0x50?'image/png':bytes[0]===0xff&&bytes[1]===0xd8?'image/jpeg':ext==='.png'?'image/png':ext==='.jpg'||ext==='.jpeg'?'image/jpeg':undefined;
  if(!mimeType)throw glmError('configuration','glm_ocr_unsupported_image','GLM-OCR仅支持PNG和JPEG图片');
  const timeout=AbortSignal.timeout(TIMEOUT_MS),active=signal?AbortSignal.any([signal,timeout]):timeout;
  const raw=await requestGlmLayout(bytes,this.env,this.fetcher,active,signal,false,mimeType);
  const normalized=isRecord(raw)&&Array.isArray(raw.layout_details)&&raw.layout_details.length===1&&(!isRecord(raw.data_info)||raw.data_info.num_pages===undefined)
   ?{...raw,data_info:{...(isRecord(raw.data_info)?raw.data_info:{}),num_pages:1}}
   :raw;
  return{provider:this.id,sha256,pages:parseGlmOcrResponse(normalized,1)};
 }
}

function decodeWordXml(value:string){
 return value.replace(/&#x([\da-f]+);/gi,(_,hex:string)=>String.fromCodePoint(Number.parseInt(hex,16))).replace(/&#(\d+);/g,(_,dec:string)=>String.fromCodePoint(Number(dec))).replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&amp;/g,'&');
}

function parseDocxParagraphXml(inner:string):string{
 return [...inner.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\s*\/>|<w:br(?:\s[^>]*)?\/>/g)]
  .map(match=>match[1]!==undefined?decodeWordXml(match[1]):match[0].startsWith('<w:tab')?'\t':'\n')
  .join('');
}

function parseDocxDocumentXmlBlocks(xml:string):DocumentBlock[]{
 const blocks:DocumentBlock[]=[];
 let index=0;
 for(const match of xml.matchAll(/<w:tbl(?:\s[^>]*)?>([\s\S]*?)<\/w:tbl>|<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>/g)){
  if(match[1]!==undefined){
   const rows:DocumentRow[]=[];
   for(const tr of match[1].matchAll(/<w:tr(?:\s[^>]*)?>([\s\S]*?)<\/w:tr>/g)){
    const cells:DocumentCell[]=[];
    for(const tc of tr[1]!.matchAll(/<w:tc(?:\s[^>]*)?>([\s\S]*?)<\/w:tc>/g)){
     const cellText=[...tc[1]!.matchAll(/<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>/g)].map(p=>parseDocxParagraphXml(p[1]!)).filter(Boolean).join('\n');
     const gridSpan=Number(/<w:gridSpan\s+[^>]*w:val=["'](\d+)["']/i.exec(tc[1]!)?.[1]??0);
     cells.push({text:cellText,...(gridSpan>1?{columnSpan:gridSpan}:{})});
    }
    if(cells.length)rows.push({cells});
   }
   if(rows.length)blocks.push({id:`xml-b${++index}`,kind:'table',rows});
  }else if(match[2]!==undefined){
   const text=parseDocxParagraphXml(match[2]);
   if(text.trim())blocks.push({id:`xml-b${++index}`,kind:'paragraph',text});
  }
 }
 return blocks;
}

/** DOCX 优先经隔离 LibreOffice 转临时 PDF 识别；本机未安装 soffice 时直接解析 OOXML 段落/表格并将内嵌图片送 GLM-OCR 识别，绑定原 DOCX 摘要。 */
export class GlmOcrDocxExtractor implements PdfExtractionProvider{
 readonly id='glm-ocr' as const;
 private readonly pdfExtractor:PdfExtractionProvider;
 private readonly imageExtractor:PdfExtractionProvider;
 constructor(
  private readonly env:NodeJS.ProcessEnv=process.env,
  fetcher:typeof fetch=fetch,
  options:{pdfExtractor?:PdfExtractionProvider;imageExtractor?:PdfExtractionProvider;convertToPdf?:(sourcePath:string,outputDir:string,signal?:AbortSignal)=>Promise<string>}={},
 ){
  this.pdfExtractor=options.pdfExtractor??new GlmOcrPdfExtractor(env,fetcher);
  this.imageExtractor=options.imageExtractor??new GlmOcrImageExtractor(env,fetcher);
  this.convertToPdf=options.convertToPdf??((sourcePath,outputDir,activeSignal)=>this.defaultConvertToPdf(sourcePath,outputDir,activeSignal));
 }
 private readonly convertToPdf:(sourcePath:string,outputDir:string,signal?:AbortSignal)=>Promise<string>;
 private async defaultConvertToPdf(sourcePath:string,outputDir:string,signal?:AbortSignal):Promise<string>{
  const profile=join(outputDir,'profile');
  await mkdir(profile,{recursive:true,mode:0o700});
  const loEnv=await createLibreOfficeEnvironment(profile);
  const soffice=this.env.LIBREOFFICE_PATH||'soffice';
  await runFile(soffice,[`-env:UserInstallation=${pathToFileURL(profile).href}`,'--headless','--convert-to','pdf','--outdir',outputDir,sourcePath],{timeout:180_000,maxBuffer:4*1024*1024,signal,env:loEnv});
  const pdfPath=join(outputDir,`${basename(sourcePath,extname(sourcePath))}.pdf`);
  const info=await stat(pdfPath).catch(()=>null);
  if(!info?.isFile()||info.size<5)throw glmError('provider','glm_ocr_docx_convert_failed','LibreOffice未能生成有效DOCX转换PDF');
  return pdfPath;
 }
 private async extractFromDocxArchive(sourceCopy:string,tempDir:string,sha256:string,signal?:AbortSignal):Promise<PdfExtractionResult>{
  const listing=new TextDecoder().decode(await runUnzip(['-Z1',sourceCopy],2*1024*1024,signal)).split(/\r?\n/).filter(Boolean);
  const structure:DocumentBlock[]=[];
  if(listing.includes('word/document.xml')){
   const xml=new TextDecoder('utf-8',{fatal:false}).decode(await runUnzip(['-p',sourceCopy,'word/document.xml'],32*1024*1024,signal));
   structure.push(...parseDocxDocumentXmlBlocks(xml));
  }
  const mediaEntries=listing.filter(entry=>/^word\/media\/[A-Za-z0-9._-]+\.(?:png|jpe?g)$/i.test(entry)&&!entry.includes('..'));
  for(const [index,entry] of mediaEntries.entries()){
   signal?.throwIfAborted();
   const imgBytes=await runUnzip(['-p',sourceCopy,entry],MAX_IMAGE_BYTES+1024,signal);
   if(imgBytes.byteLength>MAX_IMAGE_BYTES)continue;
   const ext=entry.toLowerCase().endsWith('.png')?'png':'jpg';
   const imgPath=join(tempDir,`media-${index}.${ext}`);
   await Bun.write(imgPath,imgBytes);
   const imgResult=await this.imageExtractor.extract(imgPath,signal);
   const imgBlocks=imgResult.pages[0]?.structure??[];
   if(!documentBlocksToText(imgBlocks).trim())continue;
   structure.push(...imgBlocks.map(block=>({...block,id:`media-${index}-${block.id}`})));
  }
  const text=documentBlocksToText(structure);
  return{provider:this.id,sha256,pages:[{page:1,text,structure,method:'ocr',model:'glm-ocr',...(!text.trim()?{issues:['empty_page']}:{ })}]};
 }
 async extract(path:string,signal?:AbortSignal):Promise<PdfExtractionResult>{
  signal?.throwIfAborted();
  const bytes=await readFile(path),sha256=createHash('sha256').update(bytes).digest('hex');
  const tempDir=await mkdtemp(join(tmpdir(),'glm-docx-'));
  try{
   const sourceCopy=join(tempDir,'source.docx');
   await Bun.write(sourceCopy,bytes);
   let pdfPath:string|undefined;
   try{
    pdfPath=await this.convertToPdf(sourceCopy,tempDir,signal);
   }catch(error){
    if((error as NodeJS.ErrnoException)?.code==='ENOENT'){
     return await this.extractFromDocxArchive(sourceCopy,tempDir,sha256,signal);
    }
    throw error;
   }
   const pdfResult=await this.pdfExtractor.extract(pdfPath,signal);
   const structure=pdfResult.pages.flatMap(page=>(page.structure??[]).map(block=>({...block,id:`p${page.page}-${block.id}`})));
   const text=documentBlocksToText(structure);
   return{provider:this.id,sha256,pages:[{page:1,text,structure,method:'ocr',model:'glm-ocr',...(!text.trim()?{issues:['empty_page']}:{ })}]};
  }finally{
   await rm(tempDir,{recursive:true,force:true});
  }
 }
}
