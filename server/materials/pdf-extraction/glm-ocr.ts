/**
 * 职责：独立调用智谱 GLM-OCR 版面解析，并将页级布局完整转换为系统稳定 DocumentBlock 结构。
 * 关键入口：GlmOcrPdfExtractor.extract()；parseGlmOcrResponse() 负责严格页数、块结构和文字保留校验。
 * 使用场景：PDF_EXTRACTION_PROVIDER=glm-ocr 时由旧材料队列和全局材料库调用；不复用 MinerU 请求、响应或回退链。
 */
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {command} from '../pdf';
import {documentBlocksToText,type DocumentBlock,type DocumentCell,type DocumentRow,type Page} from '../pdf';
import type {PdfExtractionProvider,PdfExtractionResult} from './types';

export const GLM_OCR_VERSION='glm-ocr-layout-structured-v1';
const MAX_BYTES=50*1024*1024,MAX_PAGES=100,TIMEOUT_MS=30*60*1000;
const isRecord=(value:unknown):value is Record<string,unknown>=>Boolean(value&&typeof value==='object'&&!Array.isArray(value));

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
 if(!isRecord(value))throw new Error(`GLM-OCR第${page}页布局块无效`);
 const content=value.content;
 if(content===undefined)return[];
 if(typeof content!=='string')throw new Error(`GLM-OCR第${page}页布局块正文无效`);
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
 if(!isRecord(value)||!isRecord(value.data_info)||value.model!=='glm-ocr')throw new Error('GLM-OCR响应结构无效');
 const reported=value.data_info.num_pages,details=value.layout_details;
 if(reported!==expectedPages||!Array.isArray(details)||details.length!==expectedPages)throw new Error('GLM-OCR返回页数与原件不一致');
 return details.map((layout,pageIndex)=>{
  if(!Array.isArray(layout))throw new Error(`GLM-OCR第${pageIndex+1}页布局无效`);
  const structure=layout.flatMap((block,index)=>blockFromLayout(block,pageIndex+1,index));
  const text=documentBlocksToText(structure),issues=text.trim()?undefined:['empty_page'];
  return{page:pageIndex+1,text,structure,method:'ocr',model:'glm-ocr',...(pageIndex===0&&value.usage!==undefined?{usage:value.usage}:{}),...(issues?{issues}:{})};
 });
}

export class GlmOcrPdfExtractor implements PdfExtractionProvider{
 readonly id='glm-ocr' as const;
 constructor(private readonly env:NodeJS.ProcessEnv=process.env,private readonly fetcher:typeof fetch=fetch){}
 async extract(path:string,signal?:AbortSignal):Promise<PdfExtractionResult>{
  const bytes=await readFile(path),sha256=createHash('sha256').update(bytes).digest('hex');
  const info=await command(['pdfinfo',path]),pageCount=Number(info.match(/^Pages:\s+(\d+)/m)?.[1]);
  if(!Number.isInteger(pageCount)||pageCount<1)throw new Error('PDF页数无效');
  if(bytes.length>MAX_BYTES||pageCount>MAX_PAGES)throw new Error('文件超过GLM-OCR单文件限制（50 MiB、100页），请先使用材料预处理切片');
  const key=this.env.ZHIPU_API_KEY?.trim();if(!key)throw new Error('未配置 ZHIPU_API_KEY');
  const timeout=AbortSignal.timeout(TIMEOUT_MS),active=signal?AbortSignal.any([signal,timeout]):timeout;
  let response:Response;
  try{
   response=await this.fetcher(`${(this.env.ZHIPU_BASE_URL??'https://open.bigmodel.cn/api/paas/v4').replace(/\/$/,'')}/layout_parsing`,{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify({model:'glm-ocr',file:`data:application/pdf;base64,${bytes.toString('base64')}`,request_id:crypto.randomUUID()}),signal:active});
  }catch(error){if(signal?.aborted)throw signal.reason??new Error('PDF提取已取消');if(error instanceof Error&&error.name==='TimeoutError')throw new Error('GLM-OCR请求超过30分钟');throw new Error('GLM-OCR请求失败；未记录请求内容及凭证');}
  if(!response.ok)throw new Error(`GLM-OCR返回HTTP ${response.status}`);
  let raw:unknown;try{raw=await response.json();}catch{throw new Error('GLM-OCR返回无效JSON');}
  return{provider:this.id,sha256,pages:parseGlmOcrResponse(raw,pageCount)};
 }
}
