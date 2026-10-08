import {test,expect} from 'bun:test';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import type {Pool} from 'pg';
import {publishWorkflow} from './jobs';
import {acceptanceSourceDigest} from '../decisions/jobs';
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'publish-test-'));const text='模型完整答案';
 const config={required_models:['qwen'],minimum_score_by_model:{qwen:8}};
 const quality={passed:true,checks:{material_grounding:true,question_complete:true,rubric_consistent:true,reference_answer_complete:true,deliverables_complete:true},issues:[]};
 const q={id:'q1',status:'succeeded',input_revision:1,input:{extraction_attempt_id:'extract',materials:[{id:'material',sha256:hash('脱敏材料')}]},result:{input_revision:1,question:'正式题面',question_version:'qv1',rubric_version:'rv1',rubric:[{id:'r1',criterion:'准确答案得10分，否则0分',max_score:10}],attachment_ids:['material'],answer_requirements:{input_mode:'text',output_mode:'text',tools:[]},quality_check:quality,reference_answer:'私有标答不能公开'}};
 const a={id:'a1',model:'qwen',status:'succeeded',result:{text,answer_sha256:hash(text),input_revision:1,question_attempt_id:'q1',question_version:'qv1',input_digest:'d'.repeat(64)}};
 const s={id:'s1',answer_attempt_id:'a1',status:'succeeded',result:{binding:{answer_attempt_id:'a1',answer_sha256:hash(text),input_revision:1,question_version:'qv1',rubric_version:'rv1'},validation:{valid:true},report:{total:9,max_score:10,disputes:[],items:[{id:'r1',score:9,reason:'有证据'}]}}};
 const snapshot={revision:1,config,question:q,answers:[a],scores:[s]};
 const accepted={id:'accepted',status:'succeeded',input:{source_digest:acceptanceSourceDigest(snapshot)},result:{decision:'accepted'}};
 const artifacts:{id:string|undefined;attempt_id:string|undefined;kind:string|undefined;storage_path:string|undefined;sha256:string}[]=[];for(const [id,attempt,kind,body] of [['artifact-q','q1','authored_question','public question'],['artifact-a','a1','model_answer',text],['artifact-s','s1','score_report','public score'],['material','extract','redacted_markdown','脱敏材料']]){
  await writeFile(join(root,id!),body!);artifacts.push({id,attempt_id:attempt,kind,storage_path:id,sha256:hash(body!)});
 }
 const writes:{sql:string;values:unknown[]}[]=[];let previous:any=null;
 const query=async(sql:string,values:unknown[]=[]):Promise<any>=>{
  if(sql.startsWith('SELECT w.input_revision'))return {rows:[{input_revision:1,project_id:'project',title:'标题'}],rowCount:1};
  if(sql.startsWith('SELECT config'))return {rows:[{config}],rowCount:1};
  if(sql.startsWith('SELECT ordinal,status'))return {rows:[4,5,6,7].map(ordinal=>({ordinal,status:'succeeded'})),rowCount:4};
  if(sql.includes('ordinal=7')&&sql.startsWith('SELECT'))return {rows:[accepted],rowCount:1};
  if(sql.includes('ordinal=8')&&sql.startsWith('SELECT'))return {rows:previous?[previous]:[],rowCount:previous?1:0};
  if(sql.startsWith('SELECT id,status,input_revision,input,result'))return {rows:[q],rowCount:1};
  if(sql.startsWith('SELECT DISTINCT ON'))return {rows:[a],rowCount:1};
  if(sql.startsWith("SELECT id,input->'context'"))return {rows:[s],rowCount:1};
  if(sql.startsWith('SELECT ar.id,ar.attempt_id'))return {rows:artifacts.filter(row=>row.kind==='redacted_markdown'),rowCount:1};
  if(sql.startsWith('SELECT id,attempt_id,kind,storage_path,sha256')){const rows=sql.includes("kind='published_result'")?artifacts.filter(row=>row.attempt_id===values[1]&&row.kind==='published_result'):artifacts.filter(row=>row.kind!=='published_result');return {rows,rowCount:rows.length};}
  if(sql.startsWith('INSERT')||sql.startsWith('UPDATE'))writes.push({sql,values});
  return {rows:[],rowCount:0};
 };
 return {root,snapshot,accepted,artifacts,writes,pool:{query,connect:async()=>({query,release(){}})} as unknown as Pool,setPrevious:(value:any)=>{previous=value;}};
}
async function publisher(){return publishWorkflow;}
test('publication records current accepted versions and only public fields after verifying files',async()=>{
 const publish=await publisher(),f=await fixture();try{
  const result=await publish(f.pool,'workflow',f.root);expect(result.completed).toBe(true);expect(result.reused).toBe(false);
  const artifact=f.writes.find(row=>row.sql.startsWith('INSERT INTO ai_distill.artifacts'))!;
  const raw=await readFile(join(f.root,String(artifact.values[4])),'utf8');const data=JSON.parse(raw);
  expect(data).toMatchObject({input_revision:1,question_version:'qv1',rubric_version:'rv1',acceptance_attempt_id:'accepted'});
  expect(raw).not.toContain('私有标答');expect(data).not.toHaveProperty('reference_answer');
  expect(f.writes.some(row=>row.sql.includes("ordinal=8")&&row.sql.startsWith('UPDATE'))).toBe(true);
 }finally{await rm(f.root,{recursive:true,force:true});}
});
test.each(['changed_answer','changed_threshold','failed_quality','changed_file','changed_material'])('publication blocks %s without marking success',async mode=>{
 const publish=await publisher(),f=await fixture();try{
  if(mode==='changed_answer')f.snapshot.answers[0]!.result.text='changed';
  if(mode==='changed_threshold')f.snapshot.config.minimum_score_by_model.qwen=10;
  if(mode==='failed_quality')f.snapshot.question.result.quality_check.passed=false;
  if(mode==='changed_material')await writeFile(join(f.root,'material'),'changed material');
  if(mode==='changed_file')await writeFile(join(f.root,'artifact-a'),'tampered');
  await expect(publish(f.pool,'workflow',f.root)).rejects.toThrow();expect(f.writes).toHaveLength(0);
 }finally{await rm(f.root,{recursive:true,force:true});}
});
test('identical publication is reused instead of overwriting files or creating attempts',async()=>{
 const publish=await publisher(),f=await fixture();try{await writeFile(join(f.root,'published-file'),'published');f.artifacts.push({id:'published-file',attempt_id:'published',kind:'published_result',storage_path:'published-file',sha256:hash('published')});f.setPrevious({id:'published',result:{source_digest:f.accepted.input.source_digest,acceptance_attempt_id:'accepted'}});const result=await publish(f.pool,'workflow',f.root);expect(result).toMatchObject({id:'published',reused:true,completed:true});expect(f.writes).toHaveLength(0);}finally{await rm(f.root,{recursive:true,force:true});}
});
