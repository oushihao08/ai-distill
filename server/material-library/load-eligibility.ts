/**
 * 职责：用完整提取结构快速估算合并材料 DOCX 的正文页数，并记录全局加载资格。
 * 入口：ensureLibraryLoadEligibility() 在期次加载、选版和恢复前调用；assertLibraryLoadEligible() 在写事务内复核同一提取任务。
 * 这里只做评估，不生成 DOCX/PDF 或调用 LibreOffice；10 页及以下禁载，未知结果不放行。
 */
import type {Pool,PoolClient} from 'pg';
import {HTTPException} from 'hono/http-exception';
import type {DocumentBlock} from '../../shared/document-structure';
import {preparationUnits} from '../../shared/material-preparation-result';
import {combineMaterialSections,filterMaterialDocxSource} from '../materials/redacted-docx-export';
import {readPreparationSource} from './preparation';

export const MAX_BLOCKED_LIBRARY_LOAD_DOCX_PAGES=10;
// 合并边界、材料过滤或估算参数变化时更新版本，使旧评估失效。
export const LIBRARY_LOAD_ASSESSMENT_VERSION='combined-docx-estimate-v1';
type Db=Pool|PoolClient;
const unavailable=()=>new HTTPException(503,{message:'无法评估拼接材料 DOCX 页数，暂不能加载到任何期次'});

/** 以现有DOCX默认11磅正文和页边距估算排版行；中日韩字符按全宽，其他字符按半宽。 */
function textLines(value:string,width:number){
 return value.split(/\r\n?|\n/).reduce((sum,line)=>{
  const units=[...line].reduce((count,char)=>count+(/[\u2e80-\u9fff\uf900-\ufaff\uff01-\uff60]/u.test(char)?1:0.5),0);
  return sum+Math.max(1,Math.ceil(units/width));
 },0);
}

/** 表格按最宽单元格决定行高；文书在同一连续流中拼接，不把OCR原页码当Word分页。 */
export function estimateCombinedDocxPages(pages:ReadonlyArray<{blocks:DocumentBlock[]}>){
 let lines=0;
 for(const page of pages)for(const block of page.blocks){
  if(block.kind==='table'){
   if(block.caption?.trim())lines+=textLines(block.caption,42);
   for(const row of block.rows){
    const columns=Math.max(1,row.cells.reduce((sum,cell)=>sum+(cell.columnSpan??1),0));
    const width=Math.max(6,42/columns);
    lines+=Math.max(1,...row.cells.map(cell=>textLines(cell.text,width*(cell.columnSpan??1))))*1.2;
   }
   for(const note of block.footnotes??[])if(note.trim())lines+=textLines(note,42);
  }else if(block.kind==='list'){
   for(const item of block.items)if(item.trim())lines+=textLines(item,40)+0.25;
  }else if(block.text.trim())lines+=textLines(block.text,42)+(block.kind==='heading'?0.8:0.25);
 }
 if(!lines)return 0;
 return Math.max(1,Math.ceil(lines/46));
}

/** 提取任务发布后正文不可变；相同来源和评估版本复用缓存，不在项目事务内做全文扫描。 */
export async function ensureLibraryLoadEligibility(pool:Pool,revisionId:string,extractionJobId:string){
 const existing=(await pool.query(`SELECT estimated_page_count,load_eligible FROM ai_distill.library_load_eligibility
  WHERE revision_id=$1 AND extraction_job_id=$2 AND assessment_version=$3`,[revisionId,extractionJobId,LIBRARY_LOAD_ASSESSMENT_VERSION])).rows[0];
 if(existing)return existing as {estimated_page_count:number;load_eligible:boolean};
 let source:Awaited<ReturnType<typeof readPreparationSource>>;
 try{source=await readPreparationSource(pool,revisionId,{extraction_job_id:extractionJobId});}catch{throw unavailable();}
 const sections=preparationUnits(source.index).map(unit=>({title:unit.title,document:{format:'redacted-structure-v1' as const,pages:unit.pages}}));
 if(!sections.length)throw unavailable();
 const combined=filterMaterialDocxSource(combineMaterialSections(sections));
 if(typeof combined==='string')throw unavailable();
 const estimatedPageCount=estimateCombinedDocxPages(combined.pages);
 if(estimatedPageCount<1)throw unavailable();
 const saved=(await pool.query(`INSERT INTO ai_distill.library_load_eligibility(revision_id,extraction_job_id,source_digest,assessment_version,estimated_page_count)
  VALUES($1,$2,$3,$4,$5) ON CONFLICT(revision_id,extraction_job_id,assessment_version) DO NOTHING
  RETURNING estimated_page_count,load_eligible`,[revisionId,extractionJobId,source.source_digest,LIBRARY_LOAD_ASSESSMENT_VERSION,estimatedPageCount])).rows[0];
 if(saved)return saved as {estimated_page_count:number;load_eligible:boolean};
 return(await pool.query(`SELECT estimated_page_count,load_eligible FROM ai_distill.library_load_eligibility
  WHERE revision_id=$1 AND extraction_job_id=$2 AND assessment_version=$3`,[revisionId,extractionJobId,LIBRARY_LOAD_ASSESSMENT_VERSION])).rows[0] as {estimated_page_count:number;load_eligible:boolean};
}

/** 事务内只读已评估的同版结果；没有判定、估算十页及以下均禁止新增或恢复期次引用。 */
export async function assertLibraryLoadEligible(db:Db,revisionId:string,extractionJobId:string){
 const row=(await db.query(`SELECT estimated_page_count,load_eligible FROM ai_distill.library_load_eligibility
  WHERE revision_id=$1 AND extraction_job_id=$2 AND assessment_version=$3`,[revisionId,extractionJobId,LIBRARY_LOAD_ASSESSMENT_VERSION])).rows[0];
 if(!row)throw unavailable();
 if(row.load_eligible!==true)throw new HTTPException(409,{message:`拼接材料 DOCX 估算约 ${row.estimated_page_count} 页，${MAX_BLOCKED_LIBRARY_LOAD_DOCX_PAGES} 页及以下不得加载到任何项目期次`});
}
