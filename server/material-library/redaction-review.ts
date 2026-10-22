/** 职责：显式重验程序Agent已发布产物，将当前复核及历史追加到job.result_summary；产物行/原文/旧题快照和任务成功状态不变。由revalidate API调用。 */
import type {Pool} from 'pg';
import {HTTPException} from 'hono/http-exception';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {compileAgentMaterialPlan} from '../../shared/agent-material-plan';
import {jobDirectory} from './execution-shared';
import {readAgentRedactionPlan} from './agent-redaction-artifacts';

export async function revalidateAgentLibraryRedaction(pool:Pool,root:string,id:string){
 const row=(await pool.query('SELECT id,redaction_job_id,output_digest,validation_report FROM ai_distill.library_redactions WHERE id=$1',[id])).rows[0];
 if(!row)throw new HTTPException(404,{message:'脱敏结果不存在'});
 if(row.validation_report?.protocol!=='agent-material-plan-v1')throw new HTTPException(409,{message:'本入口仅重验程序Agent结构化产物'});
 let valid=false,reason_code:string|null=null;
 try{
  const directory=join(jobDirectory(root,row.redaction_job_id),'private');
  const context=JSON.parse(await readFile(join(directory,'validation-source.json'),'utf8'));
  compileAgentMaterialPlan(await readAgentRedactionPlan(directory),context.files,context.identity);
  valid=true;
 }catch(error){reason_code=(error as any)?.reason_code??(error instanceof SyntaxError?'invalid_json':'agent_validation_evidence_missing');}
 const validation={valid,reason_code,checked_at:new Date().toISOString(),scope:'program_structure_privacy_resolution_and_source_coverage'};
 const result=await pool.query(`UPDATE ai_distill.library_jobs j
  SET result_summary=result_summary || jsonb_build_object('latest_program_validation',$2::jsonb,'program_validation_history',
    COALESCE(result_summary->'program_validation_history','[]'::jsonb) || jsonb_build_array($2::jsonb))
  WHERE j.id=$1 AND j.status='succeeded'
   AND EXISTS(SELECT 1 FROM ai_distill.library_redactions r WHERE r.id=$3 AND r.redaction_job_id=j.id AND r.output_digest=$4)
  RETURNING j.id`,[row.redaction_job_id,JSON.stringify(validation),id,row.output_digest]);
 if(result.rowCount!==1)throw new HTTPException(409,{message:'脱敏版本在校验期间发生变化'});
 return{id,usable_for_question:valid,...validation};
}
