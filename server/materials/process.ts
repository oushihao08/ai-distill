/**
 * 职责：PDF/DOCX/PNG/JPEG 材料处理与产物落盘：校验来源和缓存指纹，生成私有逐页文本并保留识别问题。
 * 关键入口：processMaterials校验原件与缓存，生成私有结构与issues；只对可重试的问题页做一次子集复识别。
 * 使用场景：旧步骤2提取worker调用；不是全局材料库任务入口，不清理历史Vision检查点。
 */
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { currentTaskSignal } from '../task-signal';
import { DOCUMENT_STRUCTURE_VERSION, documentBlocksToText, type Page } from './pdf';
import { ProjectDocumentExtractor,type DocumentExtractor } from './document';
import type {VisionClient} from './vision';

export interface ExtractionCache { storage_path: string; sha256: string; attempt_id: string; material_id: string; }
export interface InputMaterial { id: string; storage_path: string; sha256: string; extraction_cache?: ExtractionCache; }
interface Artifact { kind: string; storage_path: string; sha256: string; size_bytes: number; material_id?: string; content?:string }

/** Step 1 stores extracted PDF/DOCX text. Redaction is a separate, project-configured step. */
export async function processMaterials(root:string,workflow:string,attempt:string,materials:InputMaterial[],_legacyVision?:VisionClient,_extract?:unknown,_legacyConfig?:unknown){
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
   const sourceSha256=createHash('sha256').update(Buffer.from(sourceBytes)).digest('hex');
   if(sourceSha256!==material.sha256){await rm(directory,{recursive:true,force:true});throw new Error('原件指纹变化，已清理未发布的提取结果');}
   const format=material.storage_path.split('.').at(-1)?.toLowerCase()??'';
   let pages:Page[]|undefined,provider='glm-ocr',mode:'fresh'|'cached'='fresh',from_attempt_id:string|null=null,from_material_id:string|null=null,cache_error:'missing_or_invalid'|undefined;
   if(!['pdf','docx','png','jpg','jpeg'].includes(format))throw new Error('仅PDF/DOCX/PNG/JPEG进入结构化提取队列');
   if(format==='pdf'&&material.extraction_cache){
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
    if(result.format!==format)throw new Error('结构化提取结果与原件不匹配');
    pages=result.pages.map(page=>{
     const structured=page.structure?.length?page.structure:[{id:`p${page.page}-b1`,kind:'paragraph' as const,text:page.text}];
     if(documentBlocksToText(structured)!==page.text)throw new Error('提取正文与结构化文字投影不一致');
     return{...page,structure:structured};
    });provider=result.provider;
   }
   // 历史缓存或provider附带的非重试提示不靠整份PDF重传修复；仅复查明确可重试的空白/乱码页。
   const retryableIssues=new Set(['empty_page','truncated_response','ocr_page_error','unreadable']);
   const ocrPagesToRecheck=pages.filter(page=>page.method==='ocr'&&(!page.text.trim()||page.issues?.some(issue=>retryableIssues.has(issue))));
   if(format==='pdf'&&ocrPagesToRecheck.length&&extractor.extractPages){
    const numbers=ocrPagesToRecheck.map(page=>page.page);
    const recheck=await extractor.extractPages(sourcePath,numbers,currentTaskSignal());
    if(recheck.format!==format||recheck.pages.length!==numbers.length||recheck.pages.some((page,index)=>page.page!==numbers[index]))throw new Error('OCR 复识别结果与原件页序不一致');
    const recheckedByPage=new Map(recheck.pages.map(page=>[page.page,page])),wasCached=mode==='cached';
    const pageNumbersToRecheck=new Set(ocrPagesToRecheck.map(page=>page.page));
    pages=pages.map(page=>{
     if(!pageNumbersToRecheck.has(page.page))return wasCached?{...page,reused:true}:page;
     const replacement=recheckedByPage.get(page.page);
     if(!replacement)throw new Error('OCR 复识别缺少对应原页');
     if(replacement.structure?.length&&documentBlocksToText(replacement.structure)!==replacement.text)throw new Error('OCR 复识别正文与结构不一致');
     const unresolvedIssues=replacement.issues?.filter(issue=>issue!=='empty_page')??[];
     if(replacement.text.trim()){const {issues:_,...body}=replacement;return{...body,structure:replacement.structure?.length?replacement.structure:[{id:`p${page.page}-b1`,kind:'paragraph' as const,text:replacement.text}],...(unresolvedIssues.length?{issues:[...new Set(unresolvedIssues.concat('ocr_recheck_unresolved'))]}:{})};}
     // 复查空结果不能抹去第一次已识别的事实；两次均空时仍保留原空白/结构和诊断，不补造正文。
     return{...page,issues:[...new Set([...(page.issues??[]),...(replacement.issues??[]),'empty_after_recheck'])]};
    });
    provider=recheck.provider;mode='fresh';from_attempt_id=null;from_material_id=null;
   }else if(format==='pdf'&&ocrPagesToRecheck.length){
    // 兼容注入/历史提取器：缺页级能力时保留结果和诊断，不能偷偷退回整份复识别。
    const pending=new Set(ocrPagesToRecheck.map(page=>page.page));
    pages=pages.map(page=>pending.has(page.page)?{...page,issues:[...new Set([...(page.issues??[]),'ocr_recheck_unavailable'])]}:page);
   }
   pages=pages.map(page=>{const structure=page.structure?.length?page.structure:[{id:`p${page.page}-b1`,kind:'paragraph' as const,text:page.text}];return{...page,structure,text:documentBlocksToText(structure)};});
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
