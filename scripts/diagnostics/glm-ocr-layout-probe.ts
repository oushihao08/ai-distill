/**
 * 职责：独立探测 GLM-OCR layout_parsing 的原始坐标与文本粒度，供 PDF 原样打码方案验证。
 * 入口：bun scripts/diagnostics/glm-ocr-layout-probe.ts --pdf <原件> --out <私有目录>
 * 使用场景：人工授权的供应商验证；不接入材料库、不改提取结构、不执行打码。
 * 敏感边界：原始响应含未脱敏正文，仅写私有目录；stdout 只输出结构统计，不输出正文或凭证。
 */
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';

function argument(name:string){
 const index=process.argv.indexOf(`--${name}`);
 if(index<0||!process.argv[index+1])throw new Error(`缺少 --${name}`);
 return process.argv[index+1]!;
}
function isRecord(value:unknown):value is Record<string,unknown>{return Boolean(value&&typeof value==='object'&&!Array.isArray(value));}
function increment(target:Record<string,number>,key:string){target[key]=(target[key]??0)+1;}
function distribution(values:number[]){
 if(!values.length)return{count:0};
 const sorted=[...values].sort((a,b)=>a-b),pick=(ratio:number)=>sorted[Math.min(sorted.length-1,Math.floor(sorted.length*ratio))]!;
 return{count:values.length,min:sorted[0],p50:pick(0.5),p90:pick(0.9),max:sorted[sorted.length-1]};
}

const pdfPath=resolve(argument('pdf')),out=resolve(argument('out'));
const bytes=await readFile(pdfPath);
if(bytes.byteLength>50*1024*1024)throw new Error('文件超过GLM-OCR 50 MiB限制');
const info=await Bun.$`pdfinfo ${pdfPath}`.text();
const pageCount=Number(info.match(/^Pages:\s+(\d+)/m)?.[1]);
if(!Number.isSafeInteger(pageCount)||pageCount<1||pageCount>100)throw new Error('PDF页数无效或超过GLM-OCR 100页限制');
const key=process.env.ZHIPU_API_KEY?.trim();
if(!key)throw new Error('未配置 ZHIPU_API_KEY；请在进程环境中提供，不要把密钥写入脚本或命令行');
await mkdir(out,{recursive:true,mode:0o700});
const base=(process.env.ZHIPU_BASE_URL??'https://open.bigmodel.cn/api/paas/v4').replace(/\/$/,'');
const response=await fetch(`${base}/layout_parsing`,{
 method:'POST',
 headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},
 body:JSON.stringify({model:'glm-ocr',file:`data:application/pdf;base64,${bytes.toString('base64')}`,request_id:crypto.randomUUID()}),
 signal:AbortSignal.timeout(30*60*1000),
});
if(!response.ok)throw new Error(`GLM-OCR返回HTTP ${response.status}；响应正文未记录`);
const raw:unknown=await response.json();
await writeFile(resolve(out,'response.private.json'),JSON.stringify(raw),{mode:0o600});
if(!isRecord(raw)||!Array.isArray(raw.layout_details)||raw.layout_details.length!==pageCount)throw new Error('GLM-OCR页数或layout_details结构不一致');

const labels:Record<string,number>={},nativeLabels:Record<string,number>={},keys:Record<string,number>={};
const contentLengths:number[]=[],lineCounts:number[]=[],blockWidths:number[]=[],blockHeights:number[]=[];
let blocks=0,withBbox=0,withContent=0,imageBlocks=0;
const pages=raw.layout_details.map((layout,pageIndex)=>{
 if(!Array.isArray(layout))throw new Error(`第${pageIndex+1}页布局不是数组`);
 for(const block of layout){
  if(!isRecord(block))continue;
  blocks++;
  for(const key of Object.keys(block))increment(keys,key);
  increment(labels,typeof block.label==='string'?block.label:'<none>');
  increment(nativeLabels,typeof block.native_label==='string'?block.native_label:'<none>');
  if(block.label==='image')imageBlocks++;
  const bbox=block.bbox_2d;
  if(Array.isArray(bbox)&&bbox.length===4&&bbox.every(value=>typeof value==='number'&&Number.isFinite(value))){
   withBbox++;blockWidths.push(Math.abs(bbox[2]-bbox[0]));blockHeights.push(Math.abs(bbox[3]-bbox[1]));
  }
  if(typeof block.content==='string'&&block.content){
   withContent++;contentLengths.push(block.content.length);lineCounts.push(block.content.split(/\r?\n/).length);
  }
 }
 return{page:pageIndex+1,blocks:layout.length};
});
const analysis={pdf_pages:pageCount,response_pages:raw.layout_details.length,blocks,with_bbox_2d:withBbox,with_content:withContent,image_blocks:imageBlocks,
 labels,native_labels:nativeLabels,block_keys:keys,pages,
 content_length:distribution(contentLengths),content_lines:distribution(lineCounts),
 bbox_2d_width:distribution(blockWidths),bbox_2d_height:distribution(blockHeights)};
await writeFile(resolve(out,'analysis.json'),JSON.stringify(analysis,null,2),{mode:0o600});
console.log(JSON.stringify({private_directory:out,...analysis},null,2));
