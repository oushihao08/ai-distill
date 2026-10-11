/**
 * 职责：后台进程入口：启动材料、作答、Codex 和返修轮询，并以资源监控控制新任务派发。
 * 关键方法与用途：进程入口注册材料、作答、Codex、评分和返修队列的消费函数，并接入资源监控。
 * 使用场景：通过 `bun run server/worker.ts` 单独启动；API 进程不会代替 worker 执行持久任务。
 */
import { createPool } from './db';
import {runNextAnswer} from './answer-models/jobs';
import {createAnswerClient} from './answer-models/dispatch';
import { runNextExtraction } from './materials/jobs';
import { runNextRedaction } from './materials/redaction-jobs';
import { runNextIntake } from './intake-jobs';
import { createFairQueueHandler,runWorkerPool } from './worker-pool';
import { createWorkerMonitor } from './monitoring/worker-monitor';
import {runNextScore} from './scoring/jobs';
import {runNextProjectSkill} from './skill-generation/jobs';
import {runNextAuthoring} from './authoring/jobs';
import {runRevisionTick} from './decisions/revision-runner';
import {configureAgentCredentialHome,readAgentCredentialHome} from './agent/config';
import {closeAgentConcurrencyGate,getAgentConcurrencyGate,readConcurrencySettings} from './concurrency';
import {classifyLogError,configureLogger,installFatalErrorLogging,logEvent} from './logging';
const logger=configureLogger({root:process.env.STORAGE_DIR??'.storage',service:'worker'});
installFatalErrorLogging();
const root = process.env.STORAGE_DIR ?? '.storage';
const concurrency=readConcurrencySettings(process.env,root);
const materialConcurrency=2;
let pool:ReturnType<typeof createPool>;
try{pool=createPool();}catch(error){logEvent('service.start_failed',{level:'error',component:'task_worker',...classifyLogError(error)});await logger.close();throw error;}
 configureAgentCredentialHome(()=>readAgentCredentialHome(pool));
const controller = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => controller.abort());
const monitor = createWorkerMonitor(pool, root, {min_available_percent:Number(process.env.WORKER_MIN_AVAILABLE_PERCENT ?? 10)});
let agentConcurrencyGate:ReturnType<typeof getAgentConcurrencyGate>|undefined;
console.log(`材料处理进程已启动，并发数 ${materialConcurrency}。Agent ${concurrency.agent} 路，模型 API ${concurrency.llmApi} 路。`);
logEvent('service.started',{level:'info',component:'task_worker',pid:process.pid});
try {
 await monitor.start();
 agentConcurrencyGate=getAgentConcurrencyGate(root,concurrency.agent);
 const agentGate=agentConcurrencyGate;
 const dispatchAgentQueue=createFairQueueHandler([
  ()=>runNextProjectSkill(pool,root,undefined,controller.signal),
  ()=>runNextRedaction(pool,root,controller.signal,undefined,'codex'),
  ()=>runNextAuthoring(pool,root,undefined,controller.signal),
  ()=>runNextScore(pool,root,undefined,controller.signal),
 ]);
 await Promise.all([runWorkerPool(async()=>{try{await runRevisionTick(pool,root);return false;}catch(error){throw error;}},{component:'revision',concurrency:1,beforeDispatch:monitor.beforeDispatch,signal:controller.signal,idleMs:3000,errorDelayMs:5000,onError:()=>{console.error('返修接续失败，稍后重试');}}),runWorkerPool(
  async worker => {
   try {
    const root=process.env.STORAGE_DIR ?? '.storage';
    // Reserve a preferred lane for each available stage, with fallback when its queue is empty.
    return worker % 2 === 0
     ? await runNextIntake(pool,root,undefined,controller.signal) || await runNextExtraction(pool,root,undefined,undefined,controller.signal)
     : await runNextExtraction(pool,root,undefined,undefined,controller.signal) || await runNextIntake(pool,root,undefined,controller.signal);
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
 ),runWorkerPool(
  async worker=>{try{
   const answer=()=>runNextAnswer(pool,root,createAnswerClient().answer,controller.signal);
   const redact=()=>runNextRedaction(pool,root,controller.signal,undefined,'api');
   return worker%2===0?await answer()||await redact():await redact()||await answer();
  }catch(error){throw error;}},
  {component:'model_api',concurrency:concurrency.llmApi,beforeDispatch:monitor.beforeDispatch,signal:controller.signal,idleMs:3000,errorDelayMs:5000,onError:()=>{console.error('API 任务调度失败，稍后重试；未输出凭证或材料内容');}},
 ),runWorkerPool(
  async()=>{try{
   const permit=await agentGate.run(dispatchAgentQueue,{signal:controller.signal});
   return permit.acquired?permit.value:false;
  }catch(error){throw error;}},
  {component:'codex_and_scoring',concurrency:concurrency.agent,beforeDispatch:monitor.beforeDispatch,signal:controller.signal,idleMs:3000,errorDelayMs:5000,onError:()=>{console.error('评分调度失败，稍后重试；未输出凭证或材料内容');}},
 )]);
} catch(error) { logEvent('service.runtime_failed',{level:'error',component:'task_worker',...classifyLogError(error)});throw error; }
finally { logEvent('service.shutdown_requested',{level:'info'});try { await monitor.stop(); } finally { if(agentConcurrencyGate)closeAgentConcurrencyGate(root);await pool.end();logEvent('service.stopped',{level:'info'});await logger.close(); } }
