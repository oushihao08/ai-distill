/**
 * 职责：统一文档提取：本地解析 DOCX/TXT/MD，PDF 必须注入 MinerU provider。
 * 关键方法与用途：`extractLocalDocument()` 解析 DOCX／TXT／MD；`ProjectDocumentExtractor` 校验并调用 MinerU 页级提取。
 * 使用场景：`intake.ts` 和提取队列调用；PDF 文本、页码与识别问题统一返回。
 */
import { readFile } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { HTTPException } from 'hono/http-exception';
import type { Page } from './pdf';
import type { PdfExtractionProvider } from './pdf-extraction/types';

export class DocumentProviderError extends Error {
 readonly kind:string;readonly retryable:boolean;
 constructor(readonly http_status:number){super(`GLM-OCR返回HTTP ${http_status}`);this.kind=http_status===401||http_status===403?'authentication':[402,429].includes(http_status)?'quota':'service';this.retryable=[408,500,502,503,504].includes(http_status);}
}

export interface DocumentExtraction { format: 'pdf' | 'docx' | 'txt' | 'md'; pages: Page[]; provider: 'glm-ocr' | 'mineru-api' | 'mineru-cli' | 'local'; sha256: string }
export interface DocumentExtractor { extract(path: string, signal?: AbortSignal): Promise<DocumentExtraction> }

function decodeXml(value: string) {
 return value.replace(/&#x([\da-f]+);/gi,(_,hex:string)=>String.fromCodePoint(Number.parseInt(hex,16))).replace(/&#(\d+);/g,(_,decimal:string)=>String.fromCodePoint(Number(decimal))).replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&amp;/g,'&');
}
function unzipEntry(bytes: Buffer, entryName: string) {
 let eocd=-1;
 for(let i=bytes.length-22;i>=Math.max(0,bytes.length-65557);i--)if(bytes.readUInt32LE(i)===0x06054b50){eocd=i;break;}
 if(eocd<0)throw new Error('DOCX压缩包目录损坏');
 const count=bytes.readUInt16LE(eocd+10),directory=bytes.readUInt32LE(eocd+16);let offset=directory;
 for(let i=0;i<count;i++){
  if(bytes.readUInt32LE(offset)!==0x02014b50)throw new Error('DOCX压缩包目录损坏');
  const method=bytes.readUInt16LE(offset+10),compressed=bytes.readUInt32LE(offset+20),nameLength=bytes.readUInt16LE(offset+28),extraLength=bytes.readUInt16LE(offset+30),commentLength=bytes.readUInt16LE(offset+32),local=bytes.readUInt32LE(offset+42);
  const name=bytes.subarray(offset+46,offset+46+nameLength).toString('utf8');
  if(name===entryName){if(bytes.readUInt32LE(local)!==0x04034b50)throw new Error('DOCX文件内容损坏');const dataOffset=local+30+bytes.readUInt16LE(local+26)+bytes.readUInt16LE(local+28),data=bytes.subarray(dataOffset,dataOffset+compressed);return method===0?data:method===8?inflateRawSync(data):(()=>{throw new Error('DOCX压缩格式不支持')})();}
  offset+=46+nameLength+extraLength+commentLength;
 }
 throw new Error('DOCX缺少word/document.xml');
}
function extractDocxXml(xml: string) {
 const paragraphs:string[]=[];
 for(const paragraph of xml.matchAll(/<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>/g)){
  const value=[...paragraph[1]!.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\s*\/>|<w:br\s*\/>/g)].map(match=>match[1]===undefined?'\t':decodeXml(match[1])).join('');
  paragraphs.push(value);
 }
 return paragraphs;
}
export class ProjectDocumentExtractor implements DocumentExtractor {
 constructor(private readonly pdfProvider?:PdfExtractionProvider,private readonly docxProvider?:PdfExtractionProvider){}
 async extract(path:string,signal?:AbortSignal):Promise<DocumentExtraction>{
  const bytes=await readFile(path),sha256=createHash('sha256').update(bytes).digest('hex'),extension=path.split('.').at(-1)?.toLowerCase();
  if(extension==='pdf'){
   if(!this.pdfProvider)throw new Error('MinerU PDF解析器未配置');
   const result=await this.pdfProvider.extract(path,signal);
   if(result.sha256!==sha256)throw new Error('PDF提取结果与原件指纹不匹配');
   return{format:'pdf',...result};
  }
  if(extension==='docx'&&this.docxProvider){
   const result=await this.docxProvider.extract(path,signal);
   if(result.sha256!==sha256)throw new Error('DOCX提取结果与原件指纹不匹配');
   return{format:'docx',...result};
  }
  if(extension==='docx'||extension==='txt'||extension==='md')return extractLocalDocument(bytes,extension);
  throw new HTTPException(400,{message:'只支持PDF、DOCX、TXT和MD材料'});
 }
}

export function extractLocalDocument(input:Uint8Array,format:'docx'|'txt'|'md') : DocumentExtraction {
 const bytes=Buffer.from(input),sha256=createHash('sha256').update(bytes).digest('hex');
 if(format==='docx'){
  if(bytes.length<4||bytes.readUInt32LE(0)!==0x04034b50)throw new Error('DOCX压缩包标识无效');
  const paragraphs=extractDocxXml(unzipEntry(bytes,'word/document.xml').toString('utf8'));
  const text=paragraphs.join('\n');
  return{format,provider:'local',sha256,pages:[{page:1,text,method:'text',structure:paragraphs.map((text,index)=>({id:`p1-b${index+1}`,kind:'paragraph' as const,text}))}]};
 }
 let text:string;try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes).replace(/^\uFEFF/,'');}catch{throw new Error(`${format.toUpperCase()}不是有效UTF-8文本`);}
 return{format,provider:'local',sha256,pages:[{page:1,text,method:'text',structure:[{id:'p1-b1',kind:'paragraph',text}]}]};
}
