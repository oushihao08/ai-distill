/**
 * 职责：为单题归档生成同题数据工作簿，并安全写入该题成果目录。
 * 关键入口：`writeArchivedWorkflowWorkbook()` 复用报表模块的达标题目筛选和附件核验。
 * 使用场景：工作流归档完成后由 `app.ts` 调用；下载接口按保存的摘要复核文件。
 */
import type {Pool} from 'pg';
import {createHash,randomUUID} from 'node:crypto';
import {lstat,mkdir,readFile,realpath,rename,rm,writeFile} from 'node:fs/promises';
import {basename,join,relative,resolve,sep} from 'node:path';
import {HTTPException} from 'hono/http-exception';
import {questionResultDirectory} from '../materials/redacted-docx-export';
import {buildProjectExport} from './export';

const digest=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
function inside(root:string,path:string){const rel=relative(root,path);return rel!==''&&rel!=='..'&&!rel.startsWith(`..${sep}`)&&!rel.startsWith(sep);}

export async function writeArchivedWorkflowWorkbook(pool:Pool,workflowId:string,assetRoot:string){
 const row=(await pool.query(`SELECT w.project_id,w.title,w.source_key,p.name,p.parent_name,p.phase_name
  FROM ai_distill.workflows w JOIN ai_distill.projects p ON p.id=w.project_id
  JOIN ai_distill.steps publication ON publication.workflow_id=w.id AND publication.ordinal=8 AND publication.status='succeeded'
  WHERE w.id=$1 AND w.deleted_at IS NULL AND p.deleted_at IS NULL`,[workflowId])).rows[0];
 if(!row)throw new HTTPException(409,{message:'题目尚未归档，不能生成归档 Excel'});
 const exported=await buildProjectExport(pool,String(row.project_id),undefined,assetRoot,workflowId);
 if(exported.records.length!==1||exported.records[0]?.workflow_id!==workflowId)throw new HTTPException(409,{message:'当前达标题目数据不完整，不能生成归档 Excel'});
 const root=await realpath(resolve(assetRoot)),directory=await questionResultDirectory(root,String(row.parent_name??row.name),String(row.phase_name??''),String(row.phase_name?row.source_key||row.title:row.title));
 if(!inside(root,directory))throw new HTTPException(409,{message:'归档 Excel 输出目录越界'});
 await mkdir(directory,{recursive:true,mode:0o700});
 const path=join(directory,'题目归档数据.xlsx');
 const info=await lstat(directory);if(info.isSymbolicLink()||!info.isDirectory())throw new HTTPException(409,{message:'归档 Excel 输出目录无效'});
 const bytes=exported.bytes,sha256=digest(bytes),temporary=join(directory,`.题目归档数据.${randomUUID()}.tmp`);
 await writeFile(temporary,bytes,{mode:0o600,flag:'wx'});
 try{await rename(temporary,path);}catch(error){await rm(temporary,{force:true});throw error;}
 return{archive_path:relative(root,path).split(sep).join('/'),sha256,filename:basename(path),workflow_id:workflowId};
}

export async function readArchivedWorkflowWorkbook(pool:Pool,workflowId:string,assetRoot:string){
 const row=(await pool.query(`SELECT result FROM ai_distill.steps WHERE workflow_id=$1 AND ordinal=8 AND status='succeeded'`,[workflowId])).rows[0];
 const saved=row?.result?.archive_workbook;
 if(!saved||typeof saved.archive_path!=='string'||typeof saved.sha256!=='string')throw new HTTPException(404,{message:'该题尚无归档 Excel'});
 const root=await realpath(resolve(assetRoot)),path=resolve(root,saved.archive_path);
 if(!inside(root,path)||!saved.archive_path.split('/').every((part:string)=>part&&part!=='.'&&part!=='..'))throw new HTTPException(409,{message:'归档 Excel 路径无效'});
 try{
  const info=await lstat(path);if(info.isSymbolicLink()||!info.isFile()||info.size>30*1024*1024)throw new Error('invalid file');
  const bytes=await readFile(path);if(digest(bytes)!==saved.sha256)throw new Error('changed file');
  return{bytes,filename:typeof saved.filename==='string'?saved.filename:'题目归档数据.xlsx'};
 }catch{throw new HTTPException(404,{message:'归档 Excel 缺失或指纹已变化，请重新归档'});}
}
