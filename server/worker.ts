/**
 * 职责：后台进程入口：按 `WORKER_MODE` 启动材料、API 模型或本地 Agent 队列，并监控资源与派发。
 * 关键方法与用途：进程入口注册持久队列消费者；`api` 与 `local` 模式可把云端 API 任务和本地任务分开。
 * 使用场景：通过 `bun run server/worker.ts` 单独启动；默认 `all` 保持既有本地行为。
 */
import {storageDirectory} from './paths';
import { createPool } from './db';
import {runNextAnswer} from './answer-models/jobs';
import {createAnswerClient} from './answer-models/dispatch';
import { runNextExtraction } from './materials/jobs';
import { runNextRedaction } from './materials/redaction-jobs';
import { runNextIntake } from './intake-jobs';
import { createFairQueueHandler,runWorkerPool } from './worker-pool';
import { createWorkerMonitor } from './monitoring/worker-monitor';
import {runNextScore} from './scoring/jobs';
import {runIndependentApiScore} from './scoring/executor';
import {runNextProjectSkill} from './skill-generation/jobs';
import {runNextAuthoring} from './authoring/jobs';
import {stageHookAffinitySql,type StageWorkerMode} from './workflow-hook-jobs';
import {runNextHook} from './workflow-hook-worker';
import {runNextRemoteMaterialOperation} from './remote-material-operations';
import {configureAgentCredentialHome,readAgentCredentialHome} from './agent/config';
import {closeAgentConcurrencyGate,getAgentConcurrencyGate,readConcurrencySettings} from './concurrency';
import {classifyLogError,configureLogger,installFatalErrorLogging,logEvent} from './logging';
// The probe is a superset of each queue's claim predicate. Claiming and stale recovery
// remain protected by their existing transactions and locks.
async function hasModelApiQueueWork(pool:ReturnType<typeof createPool>,mode:StageWorkerMode='all'){
 const affinity=stageHookAffinitySql(mode);
 const result=await pool.query(`SELECT (
  EXISTS(SELECT 1 FROM ai_distill.step_attempts a WHERE a.ordinal=5 AND ${affinity} AND (a.status='waiting' OR (a.status='running' AND COALESCE(a.heartbeat_at,a.started_at)<now()-interval '5 minutes')))
  OR EXISTS(SELECT 1 FROM ai_distill.step_attempts a WHERE a.ordinal=6 AND a.config->>'provider'='api' AND ${affinity} AND (a.status='waiting' OR (a.status='running' AND COALESCE(a.heartbeat_at,a.started_at)<now()-interval '5 minutes')))
 ) AS pending`);
 return result.rows[0]?.pending===true;
}
async function hasAgentQueueWork(pool:ReturnType<typeof createPool>){
 const result=await pool.query(`SELECT (
  EXISTS(SELECT 1 FROM ai_distill.project_skill_attempts a WHERE a.status='waiting' OR (a.status='running' AND COALESCE(a.heartbeat_at,a.started_at)<now()-interval '5 minutes'))
  OR EXISTS(SELECT 1 FROM ai_distill.step_attempts a WHERE (a.ordinal=4 OR (a.ordinal=6 AND COALESCE(a.config->>'provider','codex')='codex')) AND (a.status='waiting' OR (a.status='running' AND COALESCE(a.heartbeat_at,a.started_at)<now()-interval '5 minutes')))
  OR EXISTS(SELECT 1 FROM ai_distill.step_attempts a WHERE a.ordinal=9 AND ((a.status='waiting' AND COALESCE(a.config->>'provider','codex')='codex') OR (a.status='running' AND COALESCE(a.heartbeat_at,a.started_at)<now()-interval '5 minutes')))
 ) AS pending`);
 return result.rows[0]?.pending===true;
}
const logger=configureLogger({root:storageDirectory(),service:'worker'});
installFatalErrorLogging();
const root = storageDirectory();
const workerMode=process.env.WORKER_MODE??'all';
 if(!['all','api','local','materials','server'].includes(workerMode)){await logger.close();throw new Error('WORKER_MODE 仅支持 all、api、local、materials 或 server');}
const materialExecutionTarget=process.env.MATERIAL_EXECUTION_TARGET??'local';
if(!['local','server'].includes(materialExecutionTarget)){await logger.close();throw new Error('MATERIAL_EXECUTION_TARGET 仅支持 local 或 server');}
if(['materials','server'].includes(workerMode)&&materialExecutionTarget!=='server'){await logger.close();throw new Error(`${workerMode} worker 必须设置 MATERIAL_EXECUTION_TARGET=server`);}
const concurrency=readConcurrencySettings(process.env,root);
const materialConcurrency=concurrency.llmApi;
let pool:ReturnType<typeof createPool>;
try{pool=createPool();}catch(error){logEvent('service.start_failed',{level:'error',component:'task_worker',...classifyLogError(error)});await logger.close();throw error;}
 configureAgentCredentialHome(()=>readAgentCredentialHome(pool));
const controller = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => controller.abort());
const monitor = createWorkerMonitor(pool, root, {min_available_percent:Number(process.env.WORKER_MIN_AVAILABLE_PERCENT ?? 10)});
let agentConcurrencyGate:ReturnType<typeof getAgentConcurrencyGate>|undefined;
console.log(`后台任务进程已启动，模式 ${workerMode}。材料 ${workerMode==='api'&&materialExecutionTarget!=='server'?0:materialConcurrency} 路，Agent ${workerMode==='api'||workerMode==='materials'||workerMode==='server'?0:concurrency.agent} 路，模型 API ${workerMode==='local'||workerMode==='materials'?0:concurrency.llmApi} 路。`);
logEvent('service.started',{level:'info',component:'task_worker',pid:process.pid});
try {
 await monitor.start();
 const dispatchAgentQueue=createFairQueueHandler([
  ()=>runNextProjectSkill(pool,root,undefined,controller.signal),
  ()=>runNextRedaction(pool,root,controller.signal,undefined,'codex','local'),
  ()=>runNextAuthoring(pool,root,undefined,controller.signal),
  ()=>runNextScore(pool,root,undefined,controller.signal),
 ]);
 const dispatchApiQueue=createFairQueueHandler([
  ()=>runNextAnswer(pool,root,createAnswerClient().answer,controller.signal,workerMode as StageWorkerMode,materialExecutionTarget as 'local'|'server'),
  ()=>runNextScore(pool,root,runIndependentApiScore,controller.signal,undefined,'api',workerMode as StageWorkerMode),
 ]);
 const pools:Promise<void>[]=[];
 if(workerMode==='all'||workerMode==='local')pools.push(runWorkerPool(
  async()=>{try{return await runNextHook(pool,controller.signal,workerMode as 'local'|'all');}catch(error){throw error;}},
  {component:'workflow_hooks',concurrency:1,beforeDispatch:monitor.beforeDispatch,signal:controller.signal,idleMs:3000,errorDelayMs:5000,onError:()=>{console.error('项目附加钩子执行失败，请查看对应记录');}},
 ));
 if(workerMode==='materials'||workerMode!=='api'||materialExecutionTarget==='server')pools.push(runWorkerPool(
  async worker => {
   try {
    const root=storageDirectory();
    // Reserve a preferred lane for each available stage, with fallback when its queue is empty.
    return worker % 2 === 0
     ? await runNextIntake(pool,root,undefined,controller.signal,materialExecutionTarget as 'local'|'server') || await runNextExtraction(pool,root,undefined,undefined,controller.signal,materialExecutionTarget as 'local'|'server')
     : await runNextExtraction(pool,root,undefined,undefined,controller.signal,materialExecutionTarget as 'local'|'server') || await runNextIntake(pool,root,undefined,controller.signal,materialExecutionTarget as 'local'|'server');
   } catch(error) { throw error; }
  },
  {
   component:'materials',
   concurrency:materialConcurrency,
   beforeDispatch: monitor.beforeDispatch,
   signal: controller.signal,
   idleMs: 3000,
   errorDelayMs: 5000,
   onError: () => {console.error('任务调度失败，稍后重试；未输出凭证或材料内容');},
  },
 ));
 // local 仅在同一 API 并发池内处理带本地脚本的主任务，api 则排除它们。
 if(workerMode!=='materials'&&workerMode!=='server')pools.push(runWorkerPool(
  async()=>{try{
   if(!await hasModelApiQueueWork(pool,workerMode as StageWorkerMode))return false;
   if(controller.signal.aborted)return false;
   return await dispatchApiQueue();
  }catch(error){throw error;}},
  {component:'model_api',concurrency:concurrency.llmApi,beforeDispatch:monitor.beforeDispatch,signal:controller.signal,idleMs:3000,errorDelayMs:5000,onError:()=>{console.error('API 任务调度失败，稍后重试；未输出凭证或材料内容');}},
 ));
 if(workerMode!=='local'&&materialExecutionTarget==='server')pools.push(runWorkerPool(
  ()=>runNextRedaction(pool,root,controller.signal,undefined,'api','server'),
  {component:'redaction_api',concurrency:1,beforeDispatch:monitor.beforeDispatch,signal:controller.signal,idleMs:3000,errorDelayMs:5000,onError:()=>{console.error('API 脱敏调度失败，稍后重试；未输出凭证或材料内容');}},
 ));
 if(workerMode==='server'){
  const dispatchRemoteApiQueue=createFairQueueHandler([
   ()=>runNextAnswer(pool,root,createAnswerClient().answer,controller.signal,'api','server'),
  ]);
  pools.push(runWorkerPool(
   async()=>{try{
    const pending=await pool.query("SELECT EXISTS(SELECT 1 FROM ai_distill.step_attempts a WHERE a.ordinal=5 AND a.execution_target='server' AND NOT (a.input->'hooks' IS NOT NULL AND a.input->'hooks'<>'null'::jsonb) AND (a.status='waiting' OR (a.status='running' AND COALESCE(a.heartbeat_at,a.started_at)<now()-interval '5 minutes'))) AS pending");
    if(pending.rows[0]?.pending!==true||controller.signal.aborted)return false;
    return await dispatchRemoteApiQueue();
   }catch(error){throw error;}},
   {component:'remote_model_api',concurrency:concurrency.llmApi,beforeDispatch:monitor.beforeDispatch,signal:controller.signal,idleMs:3000,errorDelayMs:5000,onError:()=>{console.error('服务器作答或脱敏调度失败，请查看任务记录');}},
  ));
 }
 if(workerMode!=='materials'&&workerMode!=='server'&&materialExecutionTarget==='local')pools.push(runWorkerPool(
  ()=>runNextRedaction(pool,root,controller.signal,undefined,'api','local'),
  {component:'redaction_api',concurrency:1,beforeDispatch:monitor.beforeDispatch,signal:controller.signal,idleMs:3000,errorDelayMs:5000,onError:()=>{console.error('API 脱敏调度失败，稍后重试；未输出凭证或材料内容');}},
 ));
 if(materialExecutionTarget==='server'&&(workerMode==='materials'||workerMode==='api'||workerMode==='server'))pools.push(runWorkerPool(
  async()=>runNextRemoteMaterialOperation(pool),
  {component:'material_operations',concurrency:1,beforeDispatch:monitor.beforeDispatch,signal:controller.signal,idleMs:3000,errorDelayMs:5000,onError:()=>{console.error('远程材料流程推进失败，请查看任务记录');}},
  ));
 if(workerMode==='all'||workerMode==='local'){
  agentConcurrencyGate=getAgentConcurrencyGate(root,concurrency.agent);
  const agentGate=agentConcurrencyGate;
  pools.push(runWorkerPool(
  async()=>{try{
   if(!await hasAgentQueueWork(pool))return false;
   if(controller.signal.aborted)return false;
   const permit=await agentGate.run(dispatchAgentQueue,{signal:controller.signal});
   return permit.acquired?permit.value:false;
  }catch(error){throw error;}},
  {component:'codex_and_scoring',concurrency:concurrency.agent,beforeDispatch:monitor.beforeDispatch,signal:controller.signal,idleMs:3000,errorDelayMs:5000,onError:()=>{console.error('评分调度失败，稍后重试；未输出凭证或材料内容');}},
  ));
 }
 await Promise.all(pools);
} catch(error) { logEvent('service.runtime_failed',{level:'error',component:'task_worker',...classifyLogError(error)});throw error; }
finally { logEvent('service.shutdown_requested',{level:'info'});try { await monitor.stop(); } finally { if(agentConcurrencyGate)closeAgentConcurrencyGate(root);await pool.end();logEvent('service.stopped',{level:'info'});await logger.close(); } }
