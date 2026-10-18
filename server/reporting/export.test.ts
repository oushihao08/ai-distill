/**
 * 验证达标题目 Excel 的数据边界：读取当前题目包、达标判定及判定引用的答案模型名称，并映射当前脱敏 DOCX 地址。
 * 主要验证：只读取达标题目的模型名与分数，不展开答案、评分或返修正文，标答附件列保持空值。
 */
import {afterEach,test,expect} from 'bun:test';
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {redactionInputDigest} from '../materials/redaction-jobs';
import {collectProjectResults,buildProjectExport,verifyProjectAuthoringRules,withProjectExportLock} from './export';
import {scanProjectPrompt} from '../rule-files';

const question={
 id:'q1',workflow_id:'w1',ordinal:4,attempt:1,status:'succeeded',input:{redaction_attempt_id:'redaction'},
 result:{task_name:'付款核对',task_type:'合同审查',question:'核对合同付款节点',question_version:'qv1',rubric_version:'rv1',attachment_ids:['redacted-attachment'],rubric:[{id:'R1',criterion:'说明付款节点',max_score:10}],answer_approach:'按合同条款核对',reference_answer:'合同约定分三期付款'},
};
const accepted={id:'decision',workflow_id:'w1',ordinal:7,attempt:1,status:'succeeded',result:{decision:'accepted',model_scores:{'model-id':{status:'passed',score:8,max_score:10,percentage:80}},evaluation_records:[{model_id:'model-id',answer_attempt_id:'answer-id'}]}};
const roots:string[]=[];
afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});

async function exportFixture(options:{workflowId?:string;materialCount?:number;attachmentCount?:number;accepted?:boolean;withoutPrompt?:boolean}={}){
 const workflowId=options.workflowId??'workflow',materialId='33333333-3333-4333-8333-333333333333',secondMaterialId='44444444-4444-4444-8444-444444444444',questionId='q1';
 const root=await mkdtemp(join(tmpdir(),'project-export-')),attachmentRoot=join(root,'assets','out'),storagePath='附件库/project/第五期/question/成果/source-脱敏-33333333.docx';
 roots.push(root);
 const skill=join(root,'skill');await mkdir(skill,{recursive:true});await writeFile(join(skill,'SKILL.md'),'---\nname: export-skill\ndescription: export fixture\n---\n当前出题skill');const projectPrompt=await scanProjectPrompt(root,skill);
 const docx=Buffer.from('verified redacted docx fixture'),sha=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
 const source={material_id:materialId,source_sha256:'source-hash',artifact_id:'extraction',artifact_sha256:'extraction-hash'},sources=[source,...((options.materialCount??1)>1?[{material_id:secondMaterialId,source_sha256:'source-hash-2',artifact_id:'extraction-2',artifact_sha256:'extraction-hash-2'}]:[])],markdown='脱敏内容',redactedSha=sha(markdown),index=JSON.stringify({redacted_sha256:redactedSha,materials:sources.map((item,index)=>({material_id:item.material_id,markdown:`脱敏附件内容${index+1}`}))});
 const input={digest:redactionInputDigest(sources),materials:sources},rows=options.attachmentCount===0?[]:[{question_attempt_id:questionId,docx_id:'docx-artifact',material_count:options.materialCount??1,material_id:materialId,storage_path:storagePath,source_key:'question',material_root:join(root,'project','questions')}];
 await mkdir(join(attachmentRoot,'附件库','project','第五期','question','成果'),{recursive:true});await writeFile(join(attachmentRoot,storagePath),docx);
 const pool:any={query:async(sql:string)=>{
  if(sql.startsWith('SELECT material_root,local_skill_path'))return{rows:[{material_root:join(root,'questions'),local_skill_path:skill}]};
  if(sql.includes('FROM ai_distill.projects'))return{rows:[{id:'project',name:'项目',material_root:join(root,'questions'),local_skill_path:skill}]};
  if(sql.startsWith('SELECT DISTINCT ON (workflow_id)'))return{rows:[{workflow_id:workflowId,id:questionId,status:'succeeded',input:{project_prompt:options.withoutPrompt?undefined:projectPrompt}}]};
  if(sql.includes('FROM ai_distill.workflows w LEFT JOIN'))return{rows:[{id:workflowId,source_key:'题目1',title:'项目名-题目1',acceptance_status:options.accepted===false?'waiting':'succeeded'}]};
  if(sql.includes('ordinal IN (4,7)'))return{rows:[{...question,id:questionId,workflow_id:workflowId,input:{redaction_attempt_id:'redaction',...(!options.withoutPrompt?{project_prompt:projectPrompt}:{})}},{...accepted,workflow_id:workflowId,result:{...accepted.result}}]};
  if(sql.includes("COALESCE(result->>'model_name',input->>'model_name')"))return{rows:[{id:'answer-id',model_name:'Qwen 3.8'}]};
  if(sql.includes("docx.kind='redacted_docx'"))return{rows};
  if(sql.startsWith('SELECT ar.id,ar.workflow_id'))return{rows:[{id:'docx-artifact',workflow_id:workflowId,attempt_id:'redaction',storage_path:storagePath,sha256:sha(docx),material_id:materialId,source_key:'题目1',material_root:join(root,'project','questions')}]};
  if(sql.includes('SELECT status FROM ai_distill.steps WHERE workflow_id=$1 AND ordinal=9'))return{rows:[{status:'succeeded'}]};
  if(sql.includes("ar.kind='redacted_markdown'"))return{rows:[{id:'redaction',status:'succeeded',input,result:{redacted_sha256:redactedSha},content:markdown,sha256:redactedSha}]};
  if(sql.includes("kind='private_extracted_pages'"))return{rows:sources};
  if(sql.startsWith('SELECT count(*)::int AS count FROM ai_distill.materials'))return{rows:[{count:options.materialCount??1}]};
  if(sql.includes("kind='redacted_index'"))return{rows:[{content:index,sha256:sha(index)}]};
  return{rows:[]};
 }};
 return{pool,root,attachmentRoot,async cleanup(){await rm(root,{recursive:true,force:true});}};
}

test('collects current question package and acceptance-linked model scores without loading answer bodies',async()=>{
 const f=await exportFixture(),statements:string[]=[];const query=f.pool.query;f.pool.query=async(sql:string,values?:unknown[])=>{statements.push(sql);return query(sql,values);};
 const result=await collectProjectResults(f.pool,'project',undefined,f.attachmentRoot);
 expect(result.records[0]).toMatchObject({title:'项目名-题目1',accepted:true,task_name:'付款核对',question:'核对合同付款节点',rubric:question.result.rubric,model_scores:[{model_id:'model-id',name:'Qwen 3.8',score:8,max_score:10,percentage:80}],answer_approach:'按合同条款核对',reference_answer:'合同约定分三期付款',reference_answer_attachment:''});
 const attemptsQuery=statements.find(sql=>sql.includes('ordinal IN (4,7)'))??'';
 expect(attemptsQuery).not.toContain('ordinal IN (4,5,6');
 expect(statements.some(sql=>sql.includes("COALESCE(result->>'model_name',input->>'model_name')"))).toBe(true);
 expect(result.records[0]?.input_attachments[0]).toContain('project-export-');
});
test('新项目导出收集保留模型原始分、独立否决和比较指标',async()=>{
 const f=await exportFixture();const query=f.pool.query;
 f.pool.query=async(sql:string,values?:unknown[])=>{
  const result=await query(sql,values);
  if(sql.includes('ordinal IN (4,7)'))return {...result,rows:result.rows.map((row:any)=>row.ordinal===7?{...row,result:{...row.result,model_scores:{'model-id':{status:'passed',score_contract:'model_report_v1',raw_score:-7,full_score:100,percentage:12,veto_triggered:true}}}}:row)};
  return result;
 };
 const result=await collectProjectResults(f.pool,'project',undefined,f.attachmentRoot);
 expect(result.records[0]?.model_scores[0]).toMatchObject({score_contract:'model_report_v1',raw_score:-7,full_score:100,percentage:12,veto_triggered:true,score:null,max_score:null});
});

test('exports only accepted questions without requiring the separate archive step',async()=>{
 const f=await exportFixture();
 expect((await buildProjectExport(f.pool,'project',undefined,f.attachmentRoot)).records).toHaveLength(1);
 const pending=await exportFixture({accepted:false});expect((await buildProjectExport(pending.pool,'project',undefined,pending.attachmentRoot)).records).toHaveLength(0);
});

test('changed current skill does not block export of a question bound to its frozen snapshot',async()=>{
 const f=await exportFixture();await writeFile(join(f.root,'skill','SKILL.md'),'---\nname: export-skill\ndescription: export fixture\n---\n新规则');
 await expect(buildProjectExport(f.pool,'project',undefined,f.attachmentRoot)).resolves.toMatchObject({records:[{accepted:true}]});
 await expect(verifyProjectAuthoringRules(f.pool,'project',['workflow'])).resolves.toBeUndefined();
});

test('export refuses historical accepted questions without a frozen skill fingerprint',async()=>{
 const f=await exportFixture({withoutPrompt:true});
 await expect(buildProjectExport(f.pool,'project',undefined,f.attachmentRoot)).rejects.toThrow('缺少出题时绑定的项目 skill 指纹');
});

test('maps the selected redaction to its generated DOCX instead of original attachments',async()=>{
 const f=await exportFixture();const record=(await collectProjectResults(f.pool,'project',undefined,f.attachmentRoot)).records[0];
 expect(record?.input_attachments[0]).toContain('%E9%99%84%E4%BB%B6%E5%BA%93');expect(record?.input_attachments[0]).toContain('source-%E8%84%B1%E6%95%8F-33333333.docx');
});

test('missing current redacted DOCX blocks export instead of falling back to source files',async()=>{
 const f=await exportFixture({attachmentCount:0});await expect(buildProjectExport(f.pool,'project',undefined,f.attachmentRoot)).rejects.toThrow('尚未生成全部附件的当前脱敏 DOCX');
});

test('partial per-material DOCX set blocks export',async()=>{
 const f=await exportFixture({materialCount:2});await expect(buildProjectExport(f.pool,'project',undefined,f.attachmentRoot)).rejects.toThrow('尚未生成全部附件');
});

test('holds the project export lock inside a transaction and commits after export work',async()=>{
 const statements:string[]=[];
 const client:any={query:async(sql:string)=>{statements.push(sql);return sql.includes('pg_try_advisory_xact_lock')?{rows:[{acquired:true}]}:{rows:[]};},release(){}};
 const pool:any={connect:async()=>client};
 const result=await withProjectExportLock(pool,'project-1',async db=>{expect(db).toBe(client);statements.push('export work');return 'done';});
 expect(result).toBe('done');
 expect(statements[0]).toBe('BEGIN');
 expect(statements[1]).toContain('pg_try_advisory_xact_lock');
 expect(statements).toContain('export work');
 expect(statements.at(-1)).toBe('COMMIT');
 expect(statements.some(sql=>sql.includes('pg_try_advisory_lock('))).toBe(false);
});

test('rolls back and does not run export work when another project operation owns the lock',async()=>{
 const statements:string[]=[];let ran=false;
 const client:any={query:async(sql:string)=>{statements.push(sql);return sql.includes('pg_try_advisory_xact_lock')?{rows:[{acquired:false}]}:{rows:[]};},release(){}};
 const pool:any={connect:async()=>client};
 await expect(withProjectExportLock(pool,'project-1',async()=>{ran=true;})).rejects.toThrow('项目导出或重置正在执行');
 expect(ran).toBe(false);
 expect(statements.at(-1)).toBe('ROLLBACK');
});
