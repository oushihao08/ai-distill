/**
 * 职责：PDF 材料处理与产物落盘：校验来源和缓存指纹，生成私有逐页文本并保留识别问题。
 * 关键方法与用途：`processMaterials()` 校验原件与缓存后生成私有逐页文本和 issues；`clearExtractionCheckpoints()` 清除指定检查点。
 * 使用场景：提取 worker 调用处理入口，返修流程按需清理缓存。
 */
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { currentTaskSignal } from '../task-signal';
import { DOCUMENT_STRUCTURE_VERSION, documentBlocksToText, type Page } from './pdf';
import type { VisionClient } from './vision';
import type { ExtractionConfig } from './config';
import { ProjectDocumentExtractor,type DocumentExtractor } from './document';

export interface ExtractionCache { storage_path: string; sha256: string; attempt_id: string; material_id: string; }
export interface InputMaterial { id: string; storage_path: string; sha256: string; extraction_cache?: ExtractionCache; }
interface Artifact { kind: string; storage_path: string; sha256: string; size_bytes: number; material_id?: string; content?:string }

function extractionIdentity(config?:ExtractionConfig){return JSON.stringify({extractor:'glm-ocr-layout-v1',prompt:config?.extractionPrompt??''});}
function checkpointDirectory(root:string,workflow:string,material:Pick<InputMaterial,'sha256'>,fingerprint:string){
 return join(resolve(root),'.extraction-checkpoints',workflow,material.sha256,fingerprint);
}
export async function clearExtractionCheckpoints(root:string,workflow:string,materials:Pick<InputMaterial,'sha256'>[],_vision:VisionClient,config?:ExtractionConfig){
 const fingerprint=createHash('sha256').update(extractionIdentity(config)).digest('hex');
 await Promise.all(materials.map(material=>rm(checkpointDirectory(root,workflow,material,fingerprint),{recursive:true,force:true})));
}

/** Step 1 stores extracted PDF text. Redaction is a separate, project-configured step. */
export async function processMaterials(root:string,workflow:string,attempt:string,materials:InputMaterial[],_vision?:VisionClient,_extract?:unknown,config?:ExtractionConfig){
 const directory=join(resolve(root),workflow,attempt);
 await mkdir(directory,{recursive:true,mode:0o700});
 if(!materials.length)throw new Error('原件材料为空');
 const extractor:DocumentExtractor=_extract&&typeof _extract==='object'&&'extract' in _extract?_extract as DocumentExtractor:new ProjectDocumentExtractor();
 const extracted:{material_id:string;sha256:string;format:string;pages:Page[];provider:string;mode:'fresh'|'cached';from_attempt_id:string|null;from_material_id:string|null;cache_error?:'missing_or_invalid'}[]=[];
 const artifacts:Artifact[]=[];
 try{
  for(const material of materials){
   const sourcePath=join(resolve(root),material.storage_path);
   const sourceBytes=await Bun.file(sourcePath).arrayBuffer();
   if(createHash('sha256').update(Buffer.from(sourceBytes)).digest('hex')!==material.sha256)throw new Error('原件指纹变化，停止发布处理结果');
   const format=material.storage_path.split('.').at(-1)?.toLowerCase()??'';
   let pages:Page[]|undefined,provider='glm-ocr',mode:'fresh'|'cached'='fresh',from_attempt_id:string|null=null,from_material_id:string|null=null,cache_error:'missing_or_invalid'|undefined;
   if(format!=='pdf')throw new Error('非PDF文本文档应在入库时直接解析，不能进入PDF提取队列');
   if(material.extraction_cache){
    try{
     const cache=material.extraction_cache,path=resolve(root,cache.storage_path),within=relative(resolve(root),path);
     if(within==='..'||within.startsWith('..'+sep)||isAbsolute(within))throw new Error('invalid cache path');
     const bytes=await Bun.file(path).arrayBuffer();
     if(createHash('sha256').update(Buffer.from(bytes)).digest('hex')!==cache.sha256)throw new Error('invalid cache hash');
     const value=JSON.parse(new TextDecoder().decode(bytes));
    if(value.source_sha256!==material.sha256||value.structure_version!==DOCUMENT_STRUCTURE_VERSION||!Array.isArray(value.pages)||!value.pages.length||value.pages.some((page:Page,index:number)=>!page||page.page!==index+1||typeof page.text!=='string'||!Array.isArray(page.structure)||documentBlocksToText(page.structure)!==page.text||!['text','ocr'].includes(page.method)))throw new Error('invalid cached pages');
     pages=value.pages;provider=typeof value.provider==='string'?value.provider:'glm-ocr';mode='cached';from_attempt_id=cache.attempt_id;from_material_id=cache.material_id;
    }catch{cache_error='missing_or_invalid';}
   }
   if(!pages){
    const result=await extractor.extract(sourcePath,currentTaskSignal());
    if(result.sha256!==material.sha256||result.format!=='pdf')throw new Error('OCR返回与原件不匹配');
    pages=result.pages.map(page=>{
     const structured=page.structure?.length?page.structure:[{id:`p${page.page}-b1`,kind:'paragraph' as const,text:page.text}];
     if(documentBlocksToText(structured)!==page.text)throw new Error('提取正文与结构化文字投影不一致');
     return{...page,structure:structured};
    });provider=result.provider;
   }
   extracted.push({material_id:material.id,sha256:material.sha256,format,pages,provider,mode,from_attempt_id,from_material_id,...(cache_error?{cache_error}:{})});
  }
  const allPages=extracted.flatMap(material=>material.pages.map(page=>({...page,material_id:material.material_id,reused:material.mode==='cached'||page.reused===true})));
  const issues=allPages.flatMap((page,index)=>[
   ...(page.issues??[]).map(kind=>({page_index:index,material_id:page.material_id,page:page.page,kind})),
   ...(!page.text.trim()?[{page_index:index,material_id:page.material_id,page:page.page,kind:'empty_page'}]:[]),
   ...(/无法辨认|�/.test(page.text)?[{page_index:index,material_id:page.material_id,page:page.page,kind:'unreadable'}]:[]),
  ]);
  for(const material of extracted){
   const content=JSON.stringify({source_sha256:material.sha256,format:material.format,provider:material.provider,structure_version:DOCUMENT_STRUCTURE_VERSION,pages:material.pages.map(({reused:_,...page})=>page)});
   const storage_path=workflow+'/'+attempt+'/material-'+material.material_id+'-extracted.json';
   await writeFile(join(resolve(root),storage_path),content,{mode:0o600,flag:'wx'});
   artifacts.push({kind:'private_extracted_pages',material_id:material.material_id,storage_path,sha256:createHash('sha256').update(content).digest('hex'),size_bytes:Buffer.byteLength(content),content});
  }
  const result={
   materials:extracted.map(material=>({material_id:material.material_id,sha256:material.sha256,pages:material.pages.length,format:material.format,provider:material.mode==='cached'?'cache':material.provider,content_type:material.pages.every(page=>page.method==='text')?'text':'scanned',extraction:{mode:material.mode,from_attempt_id:material.from_attempt_id,from_material_id:material.from_material_id,...(material.cache_error?{cache_error:material.cache_error}:{})}})),
   pages:allPages.map(page=>({material_id:page.material_id,page:page.page,method:page.method,usage:page.reused?null:page.usage??null,model:page.model??null,extraction_reused:page.reused,recognition_attempts:page.attempts??[]})),
   issues,
   persistence:'原始文本及逐页索引已写入PostgreSQL私有产物；脱敏由后续独立步骤执行',
  };
  // Partial recognition is still persisted for review; issues remain visible but do not block ingestion.
  return{artifacts,result,blocked:false};
 }catch(error){
  await rm(directory,{recursive:true,force:true});
  throw error;
 }
}
