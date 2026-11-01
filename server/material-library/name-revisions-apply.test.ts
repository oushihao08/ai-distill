/** 验证修订应用的事务顺序、版本冲突、幂等与失败回滚；pg替身不证明真实数据库约束、磁盘或模型质量。 */
import {expect,test} from 'bun:test';
import {canonicalJson} from '../../shared/workflow-config';
import {applyNameRevision,buildNameRevisionPreview,type NameRevisionContext} from './name-revisions';
import {nameRevisionHash as hash} from '../authoring/name-revision-preview';
const mappings=[{original:'杨政',before:'林知远',after:'杨正',kind:'person' as const}];
const requestKey='11111111-1111-4111-8111-111111111111';
function fixture(options:{fail?:string;active?:boolean;archived?:boolean;prior?:any}={}){
 const markdown='林知远申请',document={format:'redacted-structure-v1',pages:[{page:1,blocks:[{id:'b1',kind:'paragraph',text:markdown}]}]};
 const index=JSON.stringify({format:'redacted-index-v2',redacted_sha256:hash(markdown),materials:[{material_id:'file',markdown,document,structure_sha256:hash(JSON.stringify(document))}],prepared_documents:[{id:'d1',title:'申请',text:markdown,document}]});
 const original=JSON.stringify({pages:[{page:1,text:'杨政申请',structure:[{id:'b1',kind:'paragraph',text:'杨政申请'}]}]});
 const manifest={version:2,origin:{kind:'library_v1',material_mode:'redacted',package_id:'package',revision_id:'revision',redaction_id:'red'},files:[{library_file_id:'file',material_id:'file',original_name:'附件.pdf'}],material_markdown:{artifact_id:'old-md',sha256:hash(markdown),kind:'redacted_markdown'},material_index:{artifact_id:'old-index',sha256:hash(index),kind:'redacted_index'}};
 const c:NameRevisionContext={project_id:'project',redaction:{id:'red',package_id:'package',revision_id:'revision',extraction_job_id:'extract',redaction_job_id:'old-job',output_digest:'old-digest',link_id:'link',link_version:1,selected_redaction_id:'red',markdown,markdown_sha256:hash(markdown),index_content:index,index_sha256:hash(index),validation_report:{}},originals:[{file_id:'file',original_name:'附件.pdf',document:original,sha256:hash(original)}],workflows:[{id:'workflow',title:'题目',project_id:'project',redaction_id:'red',source_attempt_id:'old-attempt',snapshot_manifest:manifest,snapshot_digest:hash(canonicalJson(manifest)),markdown,markdown_sha256:hash(markdown),index_content:index,index_sha256:hash(index),question:{header:{},task_name:'林知远代理',task_type:'民间借贷',question:markdown,answer_approach:'林知远',reference_answer:'林知远',attachment_ids:['file'],answer_requirements:{input_mode:'text',output_mode:'text',tools:[]},rubric:[{id:'R1',criterion:'林知远',max_score:1}],question_version:'q1',rubric_version:'r1'},source_input:{title:'题目',materials:[{id:'old-md',sha256:hash(markdown)}]},source_config:{},active:options.active??false,archived:options.archived??false}]};
 const calls:{sql:string;values:any[]}[]=[],artifacts=new Map<string,any>();let newManifest:any,released=false;
 const db={release(){released=true;},async query(sql:string,values:any[]=[]){
  calls.push({sql,values});if(options.fail&&sql.includes(options.fail))throw new Error('injected failure');
  let rows:any[]=[];
  if(sql.startsWith('SELECT p.id FROM ai_distill.library_packages'))rows=[{id:'package'}];
  else if(sql.startsWith('SELECT input_digest,result_summary'))rows=options.prior?[options.prior]:[];
  else if(sql.includes('ORDER BY w.id FOR UPDATE OF w'))rows=[{id:'workflow'}];
  else if(sql.includes('pg_try_advisory_xact_lock'))rows=[{locked:true}];
  else if(sql.includes('m.text_content AS markdown'))rows=[c.redaction];
  else if(sql.includes('f.id AS file_id'))rows=c.originals;
  else if(sql.includes('q.result AS question'))rows=c.workflows;
  else if(sql.startsWith('INSERT INTO ai_distill.library_blobs'))rows=[{id:values[0]}];
  else if(sql.startsWith('INSERT INTO ai_distill.artifacts')&&sql.includes('material_id'))artifacts.set(values[0],{id:values[0],sha256:values[4],content:values[6]});
  else if(sql.startsWith('INSERT INTO ai_distill.question_library_sources'))newManifest=JSON.parse(values[7]);
  return{rows,rowCount:rows.length||1};
 }};
 const pool={connect:async()=>db} as any;
 const readMaterials=async()=>{
  const m=newManifest.material_markdown,attachment=artifacts.get(m.artifact_id);
  return{origin:{...newManifest.origin,snapshot_digest:hash(canonicalJson(newManifest))},attachments:[{...attachment,source_names:['附件.pdf'],attempt_id:null}],digest:hash(canonicalJson(newManifest))};
 };
 const reviewCallId='22222222-2222-4222-8222-222222222222';
 const review={review_call_id:reviewCallId,request_digest:'b'.repeat(64),package_id:c.redaction.package_id,redaction_id:c.redaction.id,workflow_id:'workflow',mappings,evidence:mappings.map(m=>({original:m.original,before:m.before,count:1,question_hits:1,samples:[{file_id:'file',original_name:'附件.pdf',page:1,path:'/0/text',context:'林知远申请'}]}))};
 const preview=buildNameRevisionPreview(c,mappings,review);
 const body={project_id:'project',request_key:requestKey,preview_digest:preview.preview_digest,review_call_id:reviewCallId,reason:'修复同音化名'};
 const readReview=async()=>review;
 return{c,pool,body,calls,readMaterials:readMaterials as any,readReview,released:()=>released};
}
test('成功事务同时新增库结果、材料快照与人工题包尝试，最后提交',async()=>{
 const f=fixture();const result=await applyNameRevision(f.pool,'/tmp','project','red',f.body,f.readMaterials,f.readReview);
 expect(result.reused).toBe(false);expect(result.workflows).toHaveLength(1);expect(result.workflows[0].invalidated_ordinals).toEqual([5,6,7,8]);
 const attempt=f.calls.find(c=>c.sql.startsWith('INSERT INTO ai_distill.step_attempts'))!;
 const input=JSON.parse(attempt.values[2]),q=JSON.parse(attempt.values[4]);expect(input.material_origin.redaction_id).toBe(result.redaction_id);expect(input.materials[0].id).not.toBe('old-md');expect(q.question).toBe('杨正申请');expect(q.reference_answer).toBe('杨正');expect(q.manual_revision.source_attempt_id).toBe('old-attempt');
 expect(q.attachment_ids).toEqual([input.materials[0].id]);expect(q.question_version).not.toBe('q1');
 expect(f.calls.at(-1)?.sql).toBe('COMMIT');expect(f.released()).toBe(true);
});
test('预览版本不匹配时拒绝全部业务写入',async()=>{
 const f=fixture();f.body.preview_digest='0'.repeat(64);
 await expect(applyNameRevision(f.pool,'/tmp','project','red',f.body,f.readMaterials,f.readReview)).rejects.toThrow('重新预览');
 expect(f.calls.some(c=>c.sql.startsWith('INSERT'))).toBe(false);expect(f.calls.at(-1)?.sql).toBe('ROLLBACK');
});
test('下游更新失败回滚，不提交部分修订',async()=>{
 const f=fixture({fail:'UPDATE ai_distill.steps SET status'});
 await expect(applyNameRevision(f.pool,'/tmp','project','red',f.body,f.readMaterials,f.readReview)).rejects.toThrow('injected failure');
 expect(f.calls.some(c=>c.sql.startsWith('INSERT INTO ai_distill.library_redactions'))).toBe(true);expect(f.calls.at(-1)?.sql).toBe('ROLLBACK');expect(f.calls.some(c=>c.sql==='COMMIT')).toBe(false);expect(f.released()).toBe(true);
});
test('活动任务与已归档题目均拒绝应用',async()=>{
 for(const options of [{active:true},{archived:true}]){
  const f=fixture(options);await expect(applyNameRevision(f.pool,'/tmp','project','red',f.body,f.readMaterials,f.readReview)).rejects.toThrow('活动任务或已归档');expect(f.calls.some(c=>c.sql.startsWith('INSERT'))).toBe(false);
 }
});
test('相同请求回放返回原回执，不重新读取或更新题目',async()=>{
 const f=fixture();const digest=hash(canonicalJson({project_id:'project',redaction_id:'red',review_call_id:f.body.review_call_id,review_request_digest:'b'.repeat(64),mappings,preview_digest:f.body.preview_digest,reason:f.body.reason}));
 const replay=fixture({prior:{input_digest:digest,result_summary:{name_revision_receipt:{job_id:'original-job',workflows:[]}}}});
 const result=await applyNameRevision(replay.pool,'/tmp','project','red',replay.body,replay.readMaterials,replay.readReview);expect(result.job_id).toBe('original-job');expect(result.reused).toBe(true);expect(replay.calls.some(c=>c.sql.startsWith('INSERT'))).toBe(false);
});
