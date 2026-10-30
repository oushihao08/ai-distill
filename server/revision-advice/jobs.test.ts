/** 手动建议的输入、版本、复用、作者冻结及执行边界；合成SQL/Agent替身，不访问业务库或真实模型。 */
import {test,expect} from 'bun:test';
import type {Pool} from 'pg';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {canonicalJson} from '../../shared/workflow-config';
import {adviceSource,validateAdvice,frozenRevisionAdvice,validFrozenAdvice,runNextRevisionAdvice} from './jobs';
const hash=(value:unknown)=>createHash('sha256').update(canonicalJson(value)).digest('hex');
const rows=()=>[{ordinal:4,status:'succeeded',result:{question_version:'q1',rubric_version:'r1',question:'合成题',rubric:[{id:'R1'}]}},{ordinal:5,status:'succeeded',result:{models:[{model_id:'private-model',name:'PRIVATE IDENTITY',status:'succeeded',answer:'合成答'}]}},{ordinal:6,status:'succeeded',result:{models:[{model_id:'private-model',name:'PRIVATE IDENTITY',score:20,report:{reason:'合成扣分'}}]}},{ordinal:7,status:'succeeded',result:{decision:'repair',reasons:['合成未达标']}}];
test('advice uses current results, removes model identity and rejects accepted/missing inputs',()=>{
 const source=adviceSource(rows());expect(source.authoring_version).toBe('q1');expect(JSON.stringify(source)).not.toContain('PRIVATE IDENTITY');expect(source.answers).toHaveLength(1);
 const accepted=rows();accepted[3]!.result={decision:'accepted'} as any;expect(()=>adviceSource(accepted)).toThrow('已达标');
 const running=rows();running[1]!.status='running';expect(()=>adviceSource(running)).toThrow('仍在执行');
 expect(()=>adviceSource(rows().filter(row=>row.ordinal!==6))).toThrow('作答和评分');expect(validateAdvice({text:' 合成建议 '})).toEqual({text:'合成建议'});expect(()=>validateAdvice({text:' '})).toThrow();expect(()=>validateAdvice({text:'x'.repeat(20001)})).toThrow();
});
test('latest valid repair advice freezes across source versions; active authoring reuses its original frozen advice',async()=>{
 const source=adviceSource(rows()),id=randomUUID(),value={id,source_digest:hash(source),authoring_version:'q1',text:'修正题面歧义'},frozen={...value,digest:hash(value)};let active:any,version='q1';
 const db={query:async(sql:string)=>{
  if(sql.includes('to_regclass'))return{rows:[{available:true}]};
  if(sql.includes("input->'revision_advice'"))return{rows:active?[{advice:active}]:[]};
  if(sql.startsWith('SELECT ordinal'))return{rows:rows().map(row=>row.ordinal===4?{...row,result:{...row.result,question_version:version}}:row)};
  if(sql.includes("result->>'decision'"))return{rows:[{decision:'repair'}]};
  if(sql.startsWith('SELECT id FROM ai_distill.step_attempts'))return{rows:[],rowCount:0};
  if(sql.includes('revision_advice_attempts'))return{rows:[{...value,result:{text:value.text}}]};
  return{rows:[]};
 }} as any;
 expect(await frozenRevisionAdvice(db,'flow')).toEqual(frozen);version='q2';expect(await frozenRevisionAdvice(db,'flow')).toEqual(frozen);
 expect(await validFrozenAdvice(db,'flow',{...frozen,text:'tampered'})).toBe(false);active=frozen;expect(await frozenRevisionAdvice(db,'flow')).toEqual(frozen);
});
test('suggestion completion persists advice without changing steps and does not author a new question',async()=>{
 const root=await mkdtemp(join(tmpdir(),'advice-test-')),source=adviceSource(rows()),id=randomUUID(),job={id,workflow_id:'flow',project_id:'project',input:source,source_digest:hash(source),config:{model:'fixture',reasoning_effort:'low'}},queries:string[]=[];let saved:any,calls=0;
 const db={query:async(sql:string,values:any[]=[])=>{queries.push(sql);if(sql.startsWith('SELECT a.*'))return{rows:[job]};if(sql.startsWith('SELECT ordinal'))return{rows:rows()};if(sql.startsWith('SELECT id FROM ai_distill.step_attempts'))return{rows:[],rowCount:0};if(sql.startsWith('UPDATE')&&sql.includes("status='succeeded'")){saved=JSON.parse(values[1]);return{rows:[],rowCount:1};}return{rows:[],rowCount:1};},release(){}};
 const pool={...db,connect:async()=>db} as unknown as Pool;
 try{
  expect(await runNextRevisionAdvice(pool,root,undefined,(async (options:any)=>{calls++;expect(options.task_type).toBe('revision_advice');expect(options.prompt).toContain('不生成新题');expect(await readFile(join(options.directory,'basis.json'),'utf8')).toContain('合成答');return{result:{text:'补清履约时间和证据边界'},session_id:'fixture',duration_ms:1};}) as any)).toBe(true);
  expect(calls).toBe(1);expect(saved).toEqual({text:'补清履约时间和证据边界'});expect(queries.some(sql=>sql.startsWith('UPDATE ai_distill.steps'))).toBe(false);
 }finally{await rm(root,{recursive:true,force:true});}
});


test('anonymous scoring stays paired with the correct answer when model order changes',()=>{
 const input=rows();input[1]!.result={models:[{model_id:'A',attempt_id:'answer-a',answer:'A答案'},{model_id:'B',attempt_id:'answer-b',answer:'B答案'}]} as any;
 input[2]!.result={models:[{model_id:'B',score:90},{answer_attempt_id:'answer-a',score:10},{score:30}]} as any;
 const source=adviceSource(input);expect(source.scores).toMatchObject([{candidate:'候选2',score:90},{candidate:'候选1',score:10},{candidate:'未匹配评分3',score:30}]);
});
