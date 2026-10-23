/** 使用SQL/交付器替身和临时SQLite验证持久派发、产物完成边界与失败结算；不调用业务数据库或项目模型。 */
import {test,expect} from 'bun:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import type {Pool} from 'pg';
import {enqueuePublication,runNextPublication} from './tasks';
import {withLocalQueueRoot,localQueue} from '../execution-queue/runtime';
const workflow=crypto.randomUUID(),project=crypto.randomUUID();
function fixture(){
 let job:any,step='waiting';const writes:string[]=[];
 const query=async(sql:string,values:any[]=[])=>{
  if(sql.startsWith('SELECT w.project_id'))return{rows:[{project_id:project,title:'fixture',parent_name:null,phase_name:'一期',source_key:'fixture'}]};
  if(sql.startsWith('SELECT id,input,result')&&sql.includes('ordinal=7'))return{rows:[{id:'accepted',input:{source_digest:'a'.repeat(64)},result:{decision:'accepted'}}]};
  if(sql.startsWith('SELECT status,result'))return{rows:[{status:'succeeded',result:{decision:'accepted'}}]};
  if(sql.startsWith('SELECT id,input')&&sql.includes('ordinal=8'))return{rows:job&&['waiting','running'].includes(job.status)?[job]:[]};
  if(sql.startsWith('INSERT INTO ai_distill.step_attempts')){job={id:values[1],workflow_id:values[0],input:JSON.parse(values[2]),status:'waiting'};}
  if(sql.startsWith('SELECT a.*'))return{rows:job&&['waiting','running'].includes(job.status)?[job]:[]};
  if(sql.includes("SET status='running'")){if(sql.includes('step_attempts'))job.status='running';else step='running';}
  if(sql.includes('SET status=$2'))job.status=values[1];
  if(sql.includes("SET status='failed'"))step='failed';
  writes.push(sql);return{rows:[],rowCount:1};
 };
 const pool={query,connect:async()=>({query,release(){}})} as unknown as Pool;
 return{pool,writes,get job(){return job;},get step(){return step;}};
}
test('enqueue is durable and idempotent while active; project code never runs in the request',async()=>{
 const root=await mkdtemp(join(tmpdir(),'publication-enqueue-')),before=process.env.EXECUTION_QUEUE_MODE;
 try{
  process.env.EXECUTION_QUEUE_MODE='local';const f=fixture();
  // Registration ownership must be returned by SQL substitute, not a real PG connection.
  const original=f.pool.connect.bind(f.pool);f.pool.connect=async()=>{
   const db=await original(),query=db.query.bind(db);
   return{...db,query:async(sql:string,args:any[])=>sql.startsWith('INSERT INTO ai_distill.execution_dispatches')?{rows:[{executor_id:localQueue(root).executorId}],rowCount:1}:query(sql,args)} as any;
  };
  const one=await withLocalQueueRoot(root,()=>enqueuePublication(f.pool,workflow,root,undefined,root));
  const two=await withLocalQueueRoot(root,()=>enqueuePublication(f.pool,workflow,root,undefined,root));
  expect(one.id).toBe(two.id);expect(two.reused).toBe(true);
  expect(localQueue(root).get(one.id)?.route).toBe('publish');
  expect(f.job.input.binding.source_digest).toBe('a'.repeat(64));expect(f.job.status).toBe('waiting');
  expect(f.writes.filter(s=>s.startsWith('INSERT INTO ai_distill.step_attempts'))).toHaveLength(1);
 }finally{localQueue(root).close();if(before===undefined)delete process.env.EXECUTION_QUEUE_MODE;else process.env.EXECUTION_QUEUE_MODE=before;await rm(root,{recursive:true,force:true});}
});
test('worker artifact failure settles failure and does not report successful publication',async()=>{
 const root=await mkdtemp(join(tmpdir(),'publication-worker-')),f=fixture();let publishCalls=0;
 try{
  await enqueuePublication(f.pool,workflow,root,undefined,root);
  const worked=await runNextPublication(f.pool,root,new AbortController().signal,undefined,{
   publish:async(_pool,_id,_root,_identity,deps)=>{publishCalls++;await deps!.prepareArtifacts!(f.job.input.binding);return{id:f.job.id,completed:true,reused:false};},
   docx:async()=>{throw new Error('fixture DOCX failure');},
   workbook:async()=>{throw new Error('must not execute workbook after DOCX failure');},
  });
  expect(worked).toBe(true);expect(publishCalls).toBe(1);expect(f.job.status).toBe('failed');expect(f.step).toBe('failed');
  expect(f.writes.some(s=>s.includes("status='succeeded'"))).toBe(false);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('isolated HTTP publication returns a queryable task ID while artifacts have not started',async()=>{
 const {Hono}=await import('hono');const {registerWorkflowExecutionRoutes}=await import('../workflow-execution-routes');
 const root=await mkdtemp(join(tmpdir(),'publication-http-')),f=fixture();let server:ReturnType<typeof Bun.serve>|undefined;
 try{
  const app=new Hono();registerWorkflowExecutionRoutes(app,{pool:f.pool,dispatch:(_id,ordinal)=>{if(ordinal!==8)throw new Error('unexpected stage');return enqueuePublication(f.pool,workflow,root,undefined,root);},
   waitForAttempt:async()=>({id:f.job.id,workflow_id:workflow,ordinal:8,status:f.job.status,error:null,started_at:null,finished_at:null,completed:false})});
  server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:app.fetch});const base=`http://127.0.0.1:${server.port}`;
  const response=await fetch(`${base}/api/workflows/${workflow}/publish`,{method:'POST'});expect(response.status).toBe(202);
  const result=await response.json() as {id:string};expect(result.id).toBe(f.job.id);expect(f.job.status).toBe('waiting');
  const status=await (await fetch(`${base}/api/attempts/${result.id}?view=status`)).json() as {status:string};expect(status.status).toBe('waiting');
 }finally{server?.stop(true);await rm(root,{recursive:true,force:true});}
});
