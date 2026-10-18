/** 验证归档前重查达标版本和文件指纹，并复用重复归档标记。
 * 运行方式：由 Bun test 收集本文件用例；修改对应模块时针对该文件回归验证。
 */
import {test,expect} from 'bun:test';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import type {Pool} from 'pg';
import {publishWorkflow,readPublicationHistory,withdrawPublication} from './jobs';
import {acceptanceSourceDigest} from '../decisions/jobs';
import {scanProjectPrompt} from '../rule-files';
import {canonicalJson} from '../../shared/workflow-config';
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
async function fixture(options:{withoutPrompt?:boolean}={}){
 const root=await mkdtemp(join(tmpdir(),'publish-test-'));const text='模型完整答案';
 const skill=join(root,'skill');await mkdir(skill);await writeFile(join(skill,'SKILL.md'),'---\nname: current-skill\ndescription: publication fixture\n---\n当前出题规则');
 const prompt=await scanProjectPrompt(root,skill);
 const modelId='11111111-1111-4111-8111-111111111111';
 const config={required_models:[modelId],minimum_score_by_model:{[modelId]:50}};
 const quality={passed:true,checks:{material_grounding:true,question_complete:true,rubric_consistent:true,reference_answer_complete:true,deliverables_complete:true},issues:[]};
 const q={id:'q1',status:'succeeded',input:{redaction_attempt_id:'extract',materials:[{id:'material',sha256:hash('脱敏材料')}],...(!options.withoutPrompt?{project_prompt:prompt}:{})},result:{question:'正式题面',question_version:'qv1',rubric_version:'rv1',rubric:[{id:'r1',criterion:'准确答案得10分，否则0分',max_score:10}],attachment_ids:['material'],answer_requirements:{input_mode:'text',output_mode:'text',tools:[]},quality_check:quality,reference_answer:'私有标答不能公开'}};
 const a={id:'a1',model:modelId,status:'succeeded',result:{text,answer_sha256:hash(text),question_attempt_id:'q1',question_version:'qv1',input_digest:'d'.repeat(64)}};
 const s={id:'s1',answer_attempt_id:'a1',status:'succeeded',result:{binding:{answer_attempt_id:'a1',answer_sha256:hash(text),question_version:'qv1',rubric_version:'rv1',input_digest:a.result.input_digest,rubric_digest:hash(JSON.stringify(q.result.rubric))},validation:{valid:true},report:{total:4,max_score:10,disputes:[],items:[{id:'r1',score:4,reason:'有证据'}]}}};
 const snapshot={config,question:q,answers:[a],scores:[s]};
 const accepted={id:'accepted',status:'succeeded',input:{source_digest:acceptanceSourceDigest(snapshot)},result:{decision:'accepted'}};
 const artifacts:{id:string|undefined;attempt_id:string|undefined;kind:string|undefined;storage_path:string|undefined;sha256:string;content?:string}[]=[];for(const [id,attempt,kind,body] of [['artifact-q','q1','authored_question','public question'],['artifact-a','a1','model_answer',text],['artifact-s','s1','score_report','public score'],['material','extract','redacted_markdown','脱敏材料']]){
  await writeFile(join(root,id!),body!);artifacts.push({id,attempt_id:attempt,kind,storage_path:id,sha256:hash(body!)});
 }
 const libraryFiles=[{library_file_id:'library-file',material_id:'material',source_sha256:hash('原件'),document_sha256:hash('结构'),source_artifact_id:'source-file',pages_artifact_id:'pages-file',position:1,original_name:'附件.docx'}];
 const libraryIndex=JSON.stringify({format:'redacted-index-v2',redacted_sha256:hash('脱敏材料'),materials:[{material_id:'material',markdown:'脱敏材料',document:{format:'redacted-structure-v1',pages:[{page:1,blocks:[{type:'paragraph',text:'脱敏材料'}]}]},structure_sha256:'not-used'}]});
 const libraryManifest={version:2,origin:{kind:'library_v1',package_id:'pkg',revision_id:'rev',redaction_id:'redact',source_digest:'d'.repeat(64)},files:libraryFiles,redacted_markdown:{artifact_id:'material',sha256:hash('脱敏材料')},redacted_index:{artifact_id:'library-index',sha256:hash(libraryIndex)}};
 const librarySnapshotDigest=hash(canonicalJson(libraryManifest));
 const writes:{sql:string;values:unknown[]}[]=[];let previous:any=null;let latestEventType:'archived'|'withdrawn'|null=null;
 const query=async(sql:string,values:unknown[]=[]):Promise<any>=>{
  if(sql.startsWith('SELECT p.material_backend'))return{rows:[{material_backend:(snapshot.question.input as any).material_origin?'library_v1':'legacy'}],rowCount:1};
  if(sql.startsWith('SELECT s.snapshot_manifest'))return{rows:[{package_name:'标准材料包',snapshot_manifest:{version:2,files:libraryFiles,redacted_markdown:{artifact_id:'material',sha256:hash('脱敏材料')}}}],rowCount:1};
  if(sql.startsWith('SELECT project_id,package_id,revision_id,redaction_id,source_digest,snapshot_manifest'))return{rows:[{project_id:'project',package_id:'pkg',revision_id:'rev',redaction_id:'redact',source_digest:'d'.repeat(64),snapshot_manifest:libraryManifest,snapshot_digest:librarySnapshotDigest,markdown_artifact_id:'material',index_artifact_id:'library-index'}],rowCount:1};
  if(sql.startsWith('SELECT snapshot_manifest,redaction_id FROM ai_distill.question_library_sources'))return{rows:[{redaction_id:'redaction',snapshot_manifest:{files:libraryFiles,redacted_index:{artifact_id:'library-index'}}}],rowCount:1};
  if(sql.startsWith('SELECT p.material_backend FROM ai_distill.workflows'))return{rows:[{material_backend:'library_v1'}],rowCount:1};
  if(sql.startsWith('SELECT id,kind,attempt_id,sha256,content FROM ai_distill.artifacts'))return{rows:[{id:'material',kind:'redacted_markdown',attempt_id:null,sha256:hash('脱敏材料'),content:'脱敏材料'},{id:'library-index',kind:'redacted_index',attempt_id:null,sha256:hash(libraryIndex),content:libraryIndex}],rowCount:2};
  if(sql.startsWith('SELECT id,content,sha256 FROM ai_distill.artifacts'))return{rows:[{id:'library-index',content:libraryIndex,sha256:hash(libraryIndex)}],rowCount:1};
  if(sql.startsWith('SELECT w.project_id'))return {rows:[{project_id:'project',project_name:'项目',title:'标题',material_root:join(root,'questions'),local_skill_path:skill,status:'succeeded'}],rowCount:1};
  if(sql.startsWith('SELECT s.model_id'))return {rows:[{model_id:modelId,name:'Qwen',enabled:true,minimum_score:config.minimum_score_by_model[modelId],config:{provider:'qwen',base_url:'https://openrouter.ai/api/v1',model:'qwen/qwen-plus'}}],rowCount:1};
  if(sql.startsWith('SELECT config'))return {rows:[{config}],rowCount:1};
  if(sql.startsWith('SELECT ordinal,status'))return {rows:[4,5,6,7].map(ordinal=>({ordinal,status:'succeeded'})),rowCount:4};
  if(sql.includes('ordinal=7')&&sql.startsWith('SELECT'))return {rows:[accepted],rowCount:1};
  if(sql.startsWith('SELECT id,input,result FROM ai_distill.step_attempts WHERE workflow_id=$1 AND ordinal=8')&&sql.includes('FOR UPDATE'))return {rows:[{id:'published',input:{material_provenance:{project_id:'project',workflow_id:'workflow',material_origin:{kind:'legacy',redaction_attempt_id:'extract'},materials:[{artifact_id:'material',sha256:hash('脱敏材料')}]}},result:{}}],rowCount:1};
  if(sql.startsWith('SELECT event_type FROM ai_distill.workflow_publication_events'))return {rows:previous?[{event_type:latestEventType??'archived'}]:[],rowCount:previous?1:0};
  if(sql.includes('ordinal=8')&&sql.startsWith('SELECT'))return {rows:previous?[previous]:[],rowCount:previous?1:0};
  if(sql.startsWith('SELECT a.id,a.status,a.input,a.result'))return {rows:[q],rowCount:1};
  if(sql.startsWith('SELECT DISTINCT ON'))return {rows:[a],rowCount:1};
  if(sql.startsWith("SELECT id,input->'context'"))return {rows:[s],rowCount:1};
  if(sql.startsWith('SELECT ar.id,ar.attempt_id'))return {rows:artifacts.filter(row=>row.kind==='redacted_markdown'),rowCount:1};
  if(sql.startsWith('SELECT id,attempt_id,kind,storage_path,sha256')){const rows=sql.includes("kind='published_result'")?artifacts.filter(row=>row.attempt_id===values[1]&&row.kind==='published_result'):artifacts.filter(row=>row.kind!=='published_result');return {rows:rows.map(row=>{const {content,...file}=row;return /sha256,content\b/.test(sql)?row:file;}),rowCount:rows.length};}
  if(sql.startsWith('INSERT')||sql.startsWith('UPDATE'))writes.push({sql,values});
  return {rows:[],rowCount:0};
 };
 return {root,skill,snapshot,accepted,artifacts,writes,librarySnapshotDigest,pool:{query,connect:async()=>({query,release(){}})} as unknown as Pool,setPrevious:(value:any)=>{previous=value;},setLatestEvent:(value:'archived'|'withdrawn')=>{latestEventType=value;}};
}
async function publisher(){return publishWorkflow;}
test('archive records the accepted version in the database without creating a published file',async()=>{
 const publish=await publisher(),f=await fixture();try{
  const result=await publish(f.pool,'workflow',f.root);expect(result.completed).toBe(true);expect(result.reused).toBe(false);
  const attempt=f.writes.find(row=>row.sql.startsWith('INSERT INTO ai_distill.step_attempts'))!;
  const data=JSON.parse(String(attempt.values[3]));
  expect(data).toMatchObject({question_version:'qv1',rubric_version:'rv1',acceptance_attempt_id:'accepted'});
  expect(data).toHaveProperty('archived_at');expect(data).not.toHaveProperty('question');expect(data).not.toHaveProperty('reference_answer');
  expect(f.writes.some(row=>row.sql.startsWith('INSERT INTO ai_distill.artifacts'))).toBe(false);
  expect(f.writes.some(row=>row.sql.includes("ordinal=8")&&row.sql.startsWith('UPDATE'))).toBe(true);
 expect(f.writes.some(row=>row.sql.startsWith('INSERT INTO ai_distill.workflow_publication_events'))).toBe(true);
 }finally{await rm(f.root,{recursive:true,force:true});}
});
test('archive provenance freezes project, library source version and redacted attachment identity',async()=>{
 const f=await fixture();try{
  (f.snapshot.question.input as any).material_origin={kind:'library_v1',package_id:'pkg',revision_id:'rev',redaction_id:'redact',snapshot_digest:f.librarySnapshotDigest};
  f.accepted.input.source_digest=acceptanceSourceDigest(f.snapshot);
  const result=await publishWorkflow(f.pool,'workflow',f.root);expect(result.completed).toBe(true);
  const attempt=f.writes.find(row=>row.sql.startsWith('INSERT INTO ai_distill.step_attempts'))!;
  const frozen=JSON.parse(String(attempt.values[2]));
  expect(frozen.material_provenance).toEqual({project_id:'project',project_name:'项目',workflow_id:'workflow',workflow_title:'标题',material_origin:(f.snapshot.question.input as any).material_origin,materials:[{artifact_id:'material',sha256:hash('脱敏材料')}],standard_material_package_name:'标准材料包',source_files:[{file_id:'library-file',material_id:'material',original_name:'附件.docx',sha256:hash('原件')}]});
  const event=f.writes.find(row=>row.sql.startsWith('INSERT INTO ai_distill.workflow_publication_events'))!;
  expect(JSON.parse(String(event.values[5]))).toEqual(frozen.material_provenance);
 }finally{await rm(f.root,{recursive:true,force:true});}
});
test('withdrawing archive clears only current publication and preserves the succeeded attempt',async()=>{
 const f=await fixture();try{
  const result=await withdrawPublication(f.pool,'workflow');expect(result.withdrawn).toBe(true);
  expect(f.writes.some(row=>row.sql.startsWith('INSERT INTO ai_distill.workflow_publication_events'))).toBe(true);
  expect(f.writes.some(row=>row.sql.includes("SET implemented=true,status='waiting'")&&row.sql.includes('ordinal=8'))).toBe(true);
  expect(f.writes.some(row=>row.sql.startsWith('DELETE FROM ai_distill.step_attempts'))).toBe(false);
 }finally{await rm(f.root,{recursive:true,force:true});}
});
test('re-archiving after withdrawal restores current state and appends a new archive event',async()=>{
 const f=await fixture();try{
  f.setPrevious({id:'published',input:{material_provenance:{project_id:'project',workflow_id:'workflow',material_origin:{kind:'legacy',redaction_attempt_id:'extract'},materials:[]}},result:{source_digest:f.accepted.input.source_digest,acceptance_attempt_id:'accepted'}});
  f.setLatestEvent('withdrawn');
  const result=await publishWorkflow(f.pool,'workflow',f.root);
  expect(result).toMatchObject({id:'published',reused:true,completed:true});
  expect(f.writes.some(row=>row.sql.startsWith('INSERT INTO ai_distill.workflow_publication_events')&&row.values[4]==='archived')).toBe(true);
  expect(f.writes.some(row=>row.sql.includes("SET implemented=true,status='succeeded'")&&row.sql.includes('ordinal=8'))).toBe(true);
 }finally{await rm(f.root,{recursive:true,force:true});}
});
test('publication history remains readable after its workflow has been removed',async()=>{
 let sql='';const pool={query:async(statement:string)=>{sql=statement;return{rows:[{workflow_id:'removed-workflow',workflow_title:null,workflow_exists:false,project_name:'项目',event_type:'archived'}]};}} as any;
 const history=await readPublicationHistory(pool,'removed-workflow');
 expect(history).toMatchObject([{workflow_id:'removed-workflow',workflow_exists:false,event_type:'archived'}]);
 expect(sql).toContain('LEFT JOIN ai_distill.workflows w');
});
test.each(['changed_answer','changed_threshold','changed_file','changed_material'])('archive blocks %s without marking success',async mode=>{
 const publish=await publisher(),f=await fixture();try{
  if(mode==='changed_answer')f.snapshot.answers[0]!.result.text='changed';
  if(mode==='changed_threshold')f.snapshot.config.minimum_score_by_model['11111111-1111-4111-8111-111111111111']=30;
  if(mode==='changed_material')await writeFile(join(f.root,'material'),'changed material');
  if(mode==='changed_file')await writeFile(join(f.root,'artifact-a'),'tampered');
  await expect(publish(f.pool,'workflow',f.root)).rejects.toThrow();expect(f.writes).toHaveLength(0);
 }finally{await rm(f.root,{recursive:true,force:true});}
});

test('archive refuses historical attempts without a frozen project skill fingerprint',async()=>{
 const f=await fixture({withoutPrompt:true});try{await expect(publishWorkflow(f.pool,'workflow',f.root)).rejects.toThrow('缺少出题时绑定的项目 skill 指纹');expect(f.writes).toHaveLength(0);}finally{await rm(f.root,{recursive:true,force:true});}
});
test('identical publication is reused instead of overwriting files or creating attempts',async()=>{
 const publish=await publisher(),f=await fixture();try{await writeFile(join(f.root,'published-file'),'published');f.artifacts.push({id:'published-file',attempt_id:'published',kind:'published_result',storage_path:'published-file',sha256:hash('published')});f.setPrevious({id:'published',result:{source_digest:f.accepted.input.source_digest,acceptance_attempt_id:'accepted'}});const result=await publish(f.pool,'workflow',f.root);expect(result).toMatchObject({id:'published',reused:true,completed:true});expect(f.writes).toHaveLength(0);}finally{await rm(f.root,{recursive:true,force:true});}
});
test('changed current skill does not invalidate an archive bound to its frozen snapshot',async()=>{
 const f=await fixture();
 try{
  f.setPrevious({id:'published',result:{source_digest:f.accepted.input.source_digest,acceptance_attempt_id:'accepted'}});
  await writeFile(join(f.skill,'SKILL.md'),'---\nname: current-skill\ndescription: publication fixture\n---\n后续规则');
  expect((await publishWorkflow(f.pool,'workflow',f.root)).completed).toBe(true);
  expect(f.writes).toHaveLength(0);
 }finally{await rm(f.root,{recursive:true,force:true});}
});


test('archives database-backed authored content without requiring a local copy',async()=>{
 const f=await fixture();try{
  const artifact=f.artifacts.find(a=>a.kind==='authored_question')!;
  artifact.content='public question';
  await rm(join(f.root,artifact.storage_path!));
  expect((await publishWorkflow(f.pool,'workflow',f.root)).completed).toBe(true);
 }finally{await rm(f.root,{recursive:true,force:true});}
});
test('归档新格式负分与独立否决结果，完整规则绑定仍有效',async()=>{
 const f=await fixture();
 try{
  const q=f.snapshot.question as any,s=f.snapshot.scores[0] as any;
  const policy={contract:'model_report_v1',rules_text:'完整加扣分规则，否决单独记录',reference_answer:'none'};
  q.result.rubric=[{id:'r1',criterion:'严重错误扣分',rule:'出现错误扣7分',metadata:{score:-7}},{id:'veto',criterion:'实务红线',rule:'触发即独立否决',metadata:{score:null}}];q.result.scoring_policy=policy;
  const {scoreRubricBindingText}=await import('../scoring/validate');
  s.result.binding.rubric_digest=hash(scoreRubricBindingText(q.result.rubric,policy as any));
  s.result.report={contract:'model_report_v1',summary:{raw_score:-7,full_score:100,evaluation_percent:12,veto_triggered:true}};s.result.validation={valid:true,mode:'model_report_v1'};
  f.accepted.input.source_digest=acceptanceSourceDigest(f.snapshot);
  expect((await publishWorkflow(f.pool,'workflow',f.root)).completed).toBe(true);
  expect(q.result.rubric[0].metadata.score).toBe(-7);expect(s.result.report.summary.veto_triggered).toBe(true);
 }finally{await rm(f.root,{recursive:true,force:true});}
});
