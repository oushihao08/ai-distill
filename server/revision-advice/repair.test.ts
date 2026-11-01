/** 返修准入回归：合成SQL替身验证实际出题/本机及远程作答/评分入口拒绝旧轮次；不连接业务库、队列或模型。 */
import {test,expect} from 'bun:test';
import type {Pool} from 'pg';
import {Hono} from 'hono';
import {registerWorkflowExecutionRoutes} from '../workflow-execution-routes';
import {repairStepIssue,assertRepairStepAllowed} from './jobs';
import {enqueueAuthoring} from '../authoring/jobs';
import {enqueueAnswer} from '../answer-models/jobs';
import {enqueueScore} from '../scoring/jobs';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('repair permission is restricted to authoring with usable advice',()=>{
 for(const adviceReady of [false,true]){
  const repair={status:'succeeded',result:{decision:'repair'}};
  expect(repairStepIssue(4,repair,adviceReady)).toBe(adviceReady?null:'未达标题目须先生成并完成返修建议，且建议文本有效');
  for(const ordinal of [5,6])expect(repairStepIssue(ordinal,repair,adviceReady)).toContain('重新出题');
  for(const acceptance of [undefined,{status:'waiting',result:null},{status:'succeeded',result:{decision:'accepted'}}]){
   for(const ordinal of [4,5,6])expect(repairStepIssue(ordinal,acceptance,adviceReady)).toBeNull();
  }
 }
});

function fixture(receipt=false){
 const calls:string[]=[];let released=false;
 const query=async(sql:string)=>{
  calls.push(sql);
  if(['BEGIN','ROLLBACK','COMMIT'].includes(sql))return{rows:[],rowCount:0};
  if(sql.startsWith('SELECT id FROM ai_distill.workflows'))return{rows:[{id:'flow'}],rowCount:1};
  if(sql.includes('ordinal=8'))return{rows:[],rowCount:0};
  if(sql.startsWith('SELECT w.project_id'))return{rows:[{project_id:'project'}],rowCount:1};
  if(sql.includes("input->>'remote_request_key'"))return{rows:receipt?[{id:'original-answer'}]:[],rowCount:receipt?1:0};
  if(sql.includes('ordinal=7'))return{rows:[{status:'succeeded',result:{decision:'repair'}}],rowCount:1};
  if(sql.includes('to_regclass'))return{rows:[{available:false}],rowCount:1};
  throw new Error('Unexpected SQL in isolated admission test');
 };
 const db={query,release(){released=true;}};
 return{pool:{query,connect:async()=>db} as unknown as Pool,db,calls,released:()=>released};
}

test('actual authoring, local/remote answer and score admission reject repair before mutations',async()=>{
 const key='11111111-1111-4111-8111-111111111111';
 for(const dispatch of [
  (pool:Pool)=>enqueueAuthoring(pool,'flow'),
  (pool:Pool)=>enqueueAnswer(pool,'flow','/unused'),
  (pool:Pool)=>enqueueAnswer(pool,'flow','/unused','server',key),
  (pool:Pool)=>enqueueScore(pool,'flow'),
 ]){
  const f=fixture();
  await expect(dispatch(f.pool)).rejects.toMatchObject({status:409});
  expect(f.calls[0]).toBe('BEGIN');
  expect(f.calls[1]).toContain('FOR UPDATE NOWAIT');
  expect(f.calls.at(-1)).toBe('ROLLBACK');
  expect(f.calls.some(sql=>/^(INSERT|UPDATE|DELETE)/.test(sql))).toBe(false);
  expect(f.released()).toBe(true);
 }
});

test('existing remote request receipt remains readable without dispatching again',async()=>{
 const f=fixture(true);
 expect(await enqueueAnswer(f.pool,'flow','/unused','server','11111111-1111-4111-8111-111111111111')).toEqual({id:'original-answer',ids:['original-answer'],reused:true});
 expect(f.calls.some(sql=>sql.includes('ordinal=7'))).toBe(false);
 expect(f.calls.some(sql=>/^(INSERT|UPDATE|DELETE)/.test(sql))).toBe(false);
 expect(f.calls.at(-1)).toBe('COMMIT');
});

test('admission database failures propagate rather than allowing execution',async()=>{
 const failure=new Error('synthetic offline');
 await expect(assertRepairStepAllowed({query:async()=>{throw failure;}} as any,'flow',5)).rejects.toBe(failure);
});

test('authoring admission accepts existing advice across versions but not absent or invalid advice',async()=>{
 for(const text of [undefined,'','   ','已有旧版本返修意见']){
  const db={query:async(sql:string)=>{
   if(sql.includes('ordinal=7'))return{rows:[{status:'succeeded',result:{decision:'repair'}}]};
   if(sql.includes('to_regclass'))return{rows:[{available:true}]};
   if(sql.includes('SELECT DISTINCT workflow_id'))return{rows:[]};
   if(sql.includes('BETWEEN 4 AND 7'))return{rows:[{workflow_id:'flow',ordinal:7,status:'succeeded',result:{decision:'repair'}}]};
   if(sql.includes('revision_advice_attempts a'))return{rows:text===undefined?[]:[{workflow_id:'flow',source_digest:'old-source',result:{text}}]};
   throw new Error('Unexpected SQL');
  }} as any;
  if(text?.trim())await assertRepairStepAllowed(db,'flow',4);
  else await expect(assertRepairStepAllowed(db,'flow',4)).rejects.toMatchObject({status:409});
 }
});

test('HTTP single answer and score cannot bypass repair admission',async()=>{
 for(const stage of ['answer','score']){
  const f=fixture(),app=new Hono();
  registerWorkflowExecutionRoutes(app,{pool:f.pool,storageRoot:'/unused',dispatch:async(id,ordinal)=>ordinal===5?enqueueAnswer(f.pool,id,'/unused'):enqueueScore(f.pool,id)});
  const response=await app.request(`/api/workflows/22222222-2222-4222-8222-222222222222/${stage}`,{method:'POST'});
  expect(response.status).toBe(409);expect(await response.text()).toContain('重新出题');
  expect(f.calls.some(sql=>/^(INSERT|UPDATE|DELETE)/.test(sql))).toBe(false);
 }
});

test('HTTP batch preserves advice readiness for authoring and never dispatches old answers or scores',async()=>{
 const project='11111111-1111-4111-8111-111111111111',flow='22222222-2222-4222-8222-222222222222';
 const root=await mkdtemp(join(tmpdir(),'repair-batch-route-'));
 try{
  for(const adviceReady of [false,true]){
   const app=new Hono(),dispatched:number[]=[];
   registerWorkflowExecutionRoutes(app,{pool:{} as Pool,storageRoot:root,repository:{
    projectExists:async()=>true,selectWorkflows:async()=>[{id:flow,project_id:project}],
    readStepStates:async()=>[4,5,6,7].map(ordinal=>({workflow_id:flow,ordinal,status:'succeeded',enabled:true,active:false,revision_advice_ready:adviceReady,result:ordinal===7?{decision:'repair'}:undefined})),
   },dispatch:async(_id,ordinal)=>{dispatched.push(ordinal);return{id:'synthetic-attempt',reused:false};}});
   for(const ordinal of [4,5,6]){
    const response=await app.request(`/api/projects/${project}/steps/${ordinal}/run-batch`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
    expect(response.status).toBe(202);
    const body=await response.json() as {results:{status:string;reason?:string}[]};
    expect(body.results[0]!.status).toBe(ordinal===4&&adviceReady?'queued':'not_ready');
    if(ordinal!==4)expect(body.results[0]!.reason).toContain('重新出题');
   }
   expect(dispatched).toEqual(adviceReady?[4]:[]);
  }
 }finally{await rm(root,{recursive:true,force:true});}
});
