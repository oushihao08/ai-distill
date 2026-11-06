/**
 * 职责：为 OpenRouter API 作答提供只读冻结附件和受管 attempt 产物工具。
 * 关键入口：`answerLocalToolDefinitions()` 定义函数契约，`createAnswerLocalToolExecutor()` 执行受限调用。
 * 边界：不接受任意本机路径；附件只来自本次冻结输入，产物只位于本 attempt 目录。
 */
import {mkdir,readFile,readdir,writeFile} from 'node:fs/promises';
import {basename,join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import type {AnswerLocalTool} from '../../shared/types';
import type {FunctionToolDefinition,FunctionToolExecutor} from '../llm-api';
import {buildDocx} from '../document-generation/docx';
import {buildXlsx,type WorkbookSheet} from '../document-generation/xlsx';

export interface AnswerLocalToolContext {materials:{name:string;text:string}[];directory:string;enabled:AnswerLocalTool[]}
const MAX_OUTPUT=48_000,MAX_ARTIFACT=2_000_000;
const safeName=/^[\p{L}\p{N}._ -]{1,120}$/u;
const extensions=new Set(['.txt','.md','.csv','.json','.html','.docx','.xlsx']);
const definitions:Record<AnswerLocalTool,FunctionToolDefinition>={
 attachment_list:{type:'function',name:'attachment_list',description:'列出本次作答已冻结且允许读取的附件。',strict:true,parameters:{type:'object',properties:{},additionalProperties:false}},
 attachment_search:{type:'function',name:'attachment_search',description:'在本次冻结附件中搜索字面文本，返回带行号的命中片段。',strict:true,parameters:{type:'object',properties:{query:{type:'string'},max_results:{type:'integer',minimum:1,maximum:20}},required:['query'],additionalProperties:false}},
 attachment_read:{type:'function',name:'attachment_read',description:'按附件ID和行号范围读取冻结附件正文。',strict:true,parameters:{type:'object',properties:{attachment_id:{type:'string'},start_line:{type:'integer',minimum:1},end_line:{type:'integer',minimum:1}},required:['attachment_id'],additionalProperties:false}},
 document_inspect:{type:'function',name:'document_inspect',description:'检查冻结附件的文本结构、行数、标题、表格和页面标记，不臆造原始Office元数据。',strict:true,parameters:{type:'object',properties:{attachment_id:{type:'string'}},required:['attachment_id'],additionalProperties:false}},
 artifact_write:{type:'function',name:'artifact_write',description:'在本次作答受管目录生成 txt、md、csv、json、html、DOCX 或 XLSX。DOCX content 为 Markdown；XLSX content 为 {sheets:[{name,columns,rows,columnWidths?,rowHeight?}]} JSON。',strict:true,parameters:{type:'object',properties:{filename:{type:'string'},content:{type:'string'}},required:['filename','content'],additionalProperties:false}},
 artifact_render:{type:'function',name:'artifact_render',description:'读回并校验本次作答产物。文本返回受限预览；DOCX/XLSX返回真实OOXML校验、摘要及其规范化生成源，不冒充像素渲染。',strict:true,parameters:{type:'object',properties:{filename:{type:'string'}},required:['filename'],additionalProperties:false}},
};
export function answerLocalToolDefinitions(enabled:AnswerLocalTool[]):FunctionToolDefinition[]{return enabled.map(name=>structuredClone(definitions[name]));}
function object(value:unknown):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('invalid_arguments');return value as Record<string,unknown>;}
function attachment(materials:AnswerLocalToolContext['materials'],id:unknown){if(typeof id!=='string'||!/^attachment-[1-9][0-9]*$/.test(id))throw new Error('attachment_not_found');const index=Number(id.slice(11))-1,item=materials[index];if(!item)throw new Error('attachment_not_found');return{...item,id,index};}
function filename(value:unknown){if(typeof value!=='string'||!safeName.test(value)||basename(value)!==value)throw new Error('invalid_filename');const ext=value.slice(value.lastIndexOf('.')).toLowerCase();if(!extensions.has(ext))throw new Error('unsupported_artifact_format');return value;}
function limited(value:unknown){const text=JSON.stringify(value);return text.length<=MAX_OUTPUT?text:JSON.stringify({truncated:true,preview:text.slice(0,MAX_OUTPUT)});}
const digest=(value:Uint8Array|string)=>createHash('sha256').update(value).digest('hex');
function artifactSourcePath(root:string,file:string){return join(root,'.sources',`${file}.json`);}
function xlsxSource(content:string):{sheets:WorkbookSheet[];canonical:string}{
 let value:unknown;try{value=JSON.parse(content);}catch{throw new Error('invalid_xlsx_source');}
 if(!value||typeof value!=='object'||Array.isArray(value)||!Array.isArray((value as any).sheets)||(value as any).sheets.length<1)throw new Error('invalid_xlsx_source');
 const sheets=(value as any).sheets as WorkbookSheet[];const canonical=JSON.stringify({sheets});
 return{sheets,canonical};
}
async function generatedBytes(file:string,content:string){
 const ext=file.slice(file.lastIndexOf('.')).toLowerCase();
 if(ext==='.docx')return{bytes:Buffer.from(await buildDocx(content,{style:'legal'})),source:content,format:'docx',media_type:'application/vnd.openxmlformats-officedocument.wordprocessingml.document'};
 if(ext==='.xlsx'){const source=xlsxSource(content);return{bytes:Buffer.from(buildXlsx(source.sheets)),source:source.canonical,format:'xlsx',media_type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'};}
 if(ext==='.json')try{JSON.parse(content);}catch{throw new Error('invalid_json_artifact');}
 return{bytes:Buffer.from(content),source:content,format:ext.slice(1),media_type:ext==='.html'?'text/html; charset=utf-8':ext==='.csv'?'text/csv; charset=utf-8':ext==='.json'?'application/json; charset=utf-8':'text/plain; charset=utf-8'};
}
function validOoxml(bytes:Buffer,format:string){
 if(bytes[0]!==0x50||bytes[1]!==0x4b)return false;
 const names=bytes.toString('latin1');
 return names.includes('[Content_Types].xml')&&(format==='docx'?names.includes('word/document.xml'):format==='xlsx'?names.includes('xl/workbook.xml')&&names.includes('xl/worksheets/sheet1.xml'):false);
}
export function createAnswerLocalToolExecutor(context:AnswerLocalToolContext):FunctionToolExecutor{
 const root=resolve(context.directory,'artifacts');
 return async(name,raw)=>{
  if(!context.enabled.includes(name as AnswerLocalTool))throw new Error('tool_not_enabled');const args=object(raw);
  if(name==='attachment_list')return limited({attachments:context.materials.map((item,index)=>({id:`attachment-${index+1}`,name:item.name,characters:item.text.length,lines:item.text.split(/\r?\n/).length}))});
  if(name==='attachment_search'){
   const query=typeof args.query==='string'?args.query.trim():'';if(!query||query.length>500)throw new Error('invalid_query');const max=Number.isSafeInteger(args.max_results)?Math.min(20,Math.max(1,Number(args.max_results))):10,hits:{attachment_id:string;name:string;line:number;snippet:string}[]=[];
   for(let i=0;i<context.materials.length&&hits.length<max;i++)for(const [line,text] of context.materials[i]!.text.split(/\r?\n/).entries())if(text.toLocaleLowerCase().includes(query.toLocaleLowerCase())){hits.push({attachment_id:`attachment-${i+1}`,name:context.materials[i]!.name,line:line+1,snippet:text.slice(0,800)});if(hits.length>=max)break;}return limited({query,hits});
  }
  if(name==='attachment_read'){const item=attachment(context.materials,args.attachment_id),lines=item.text.split(/\r?\n/),start=Number.isSafeInteger(args.start_line)?Number(args.start_line):1,end=Number.isSafeInteger(args.end_line)?Number(args.end_line):Math.min(lines.length,start+199);if(start<1||end<start||end-start>499)throw new Error('invalid_line_range');return limited({attachment_id:item.id,name:item.name,start_line:start,end_line:Math.min(end,lines.length),text:lines.slice(start-1,end).join('\n')});}
  if(name==='document_inspect'){const item=attachment(context.materials,args.attachment_id),lines=item.text.split(/\r?\n/),headings=lines.filter(line=>/^#{1,6}\s+/.test(line.trim())).slice(0,40),table_lines=lines.filter(line=>line.includes('|')||line.includes('\t')).length,page_markers=lines.filter(line=>/^(?:-+\s*)?第\s*\d+\s*页|^\[?page\s*\d+\]?/i.test(line.trim())).length;return limited({attachment_id:item.id,name:item.name,characters:item.text.length,lines:lines.length,headings,table_lines,page_markers,inspection_basis:'extracted_text'});}
  const file=filename(args.filename),path=join(root,file);
  if(name==='artifact_write'){if(typeof args.content!=='string'||!args.content.trim()||Buffer.byteLength(args.content)>MAX_ARTIFACT)throw new Error('invalid_artifact_content');const generated=await generatedBytes(file,args.content);if(generated.bytes.byteLength>MAX_ARTIFACT)throw new Error('artifact_too_large');await mkdir(root,{recursive:true,mode:0o700});await mkdir(join(root,'.sources'),{recursive:true,mode:0o700});await writeFile(path,generated.bytes,{mode:0o600});await writeFile(artifactSourcePath(root,file),JSON.stringify({filename:file,format:generated.format,media_type:generated.media_type,source:generated.source,source_sha256:digest(generated.source),artifact_sha256:digest(generated.bytes)}),{encoding:'utf8',mode:0o600});return limited({filename:file,format:generated.format,media_type:generated.media_type,size_bytes:generated.bytes.byteLength,sha256:digest(generated.bytes),written:true});}
  if(name==='artifact_render'){let bytes:Buffer,source:any;try{bytes=await readFile(path);source=JSON.parse(await readFile(artifactSourcePath(root,file),'utf8'));}catch{throw new Error('artifact_not_found');}if(source.artifact_sha256!==digest(bytes)||source.source_sha256!==digest(source.source))throw new Error('artifact_digest_mismatch');const binary=['docx','xlsx'].includes(source.format);if(binary&&!validOoxml(bytes,source.format))throw new Error('invalid_ooxml_artifact');return limited({filename:file,format:source.format,media_type:source.media_type,size_bytes:bytes.byteLength,sha256:source.artifact_sha256,verification:binary?'ooxml_required_entries_and_digest':'text_digest',rendering_scope:binary?'structure_and_generation_source_not_pixel_render':'text_preview',lines:source.source.split(/\r?\n/).length,preview:source.source.slice(0,12_000),truncated:source.source.length>12_000});}
  throw new Error('unknown_tool');
 };
}
export async function readGeneratedAnswerArtifacts(directory:string){
 const root=resolve(directory,'artifacts');let entries:string[];try{entries=await readdir(root);}catch{return[];}
 const artifacts=[];for(const name of entries.sort()){
  let safe:string;try{safe=filename(name);}catch{continue;}const bytes=await readFile(join(root,safe));if(!bytes.length||bytes.byteLength>MAX_ARTIFACT)continue;let source:any;try{source=JSON.parse(await readFile(artifactSourcePath(root,safe),'utf8'));}catch{continue;}if(source.artifact_sha256!==digest(bytes)||source.source_sha256!==digest(source.source))continue;artifacts.push({filename:safe,bytes,content:String(source.source),source_sha256:source.source_sha256,sha256:source.artifact_sha256,size_bytes:bytes.byteLength,format:String(source.format),media_type:String(source.media_type)});
 }return artifacts;
}
