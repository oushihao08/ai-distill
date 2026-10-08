import { createPool } from './db';
import {runNextAnswer} from './answer-models/jobs';
import {createAnswerClient} from './answer-models/dispatch';
import { runNextExtraction } from './materials/jobs';
import { runNextRedaction } from './materials/redaction-jobs';
import { runNextIntake } from './intake-jobs';
import { runWorkerPool } from './worker-pool';
import { createWorkerMonitor } from './monitoring/worker-monitor';
import {runNextScore} from './scoring/jobs';
import {runNextProjectSkill} from './skill-generation/jobs';
import {runNextAuthoring} from './authoring/jobs';
import {runRevisionTick} from './decisions/revision-runner';
import {runAutomationTick} from './automation/jobs';
import {configureRuntimeMonitor} from './monitoring/runtime';
import {configureCodexCredentialsHome} from './codex/client';
import {readCodexCredentialHome} from './codex/system-config';
const pool = createPool();
configureRuntimeMonitor(pool);
configureCodexCredentialsHome(()=>readCodexCredentialHome(pool));
const controller = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => controller.abort());
const concurrency = 2;
const root = process.env.STORAGE_DIR ?? '.storage';
const monitor = createWorkerMonitor(pool, root, {min_available_percent:Number(process.env.WORKER_MIN_AVAILABLE_PERCENT ?? 10)});
console.log(`材料处理进程已启动，并发数 ${concurrency}。`);
try {
 await monitor.start();
 await Promise.all([runWorkerPool(async()=>{try{await runRevisionTick(pool,root);await runAutomationTick(pool,root);return false;}catch(error){throw error;}},{concurrency:1,beforeDispatch:monitor.beforeDispatch,signal:controller.signal,idleMs:3000,errorDelayMs:5000,onError:()=>console.error('自动推进失败，稍后重试')}),runWorkerPool(
  async worker => {
   try {
    const root=process.env.STORAGE_DIR ?? '.storage';
    // Reserve a preferred lane for each available stage, with fallback when its queue is empty.
    return worker % 2 === 0
     ? await runNextIntake(pool,root) || await runNextExtraction(pool,root)
     : await runNextExtraction(pool,root) || await runNextIntake(pool,root);
   } catch(error) { throw error; }
  },
  {
   concurrency,
   beforeDispatch: monitor.beforeDispatch,
   signal: controller.signal,
   idleMs: 3000,
   errorDelayMs: 5000,
   onError: () => console.error('任务调度失败，稍后重试；未输出凭证或材料内容'),
  },
 ),runWorkerPool(
  async()=>{try{return await runNextAnswer(pool,process.env.STORAGE_DIR??'.storage',createAnswerClient().answer,controller.signal);}catch(error){throw error;}},
  {concurrency:4,beforeDispatch:monitor.beforeDispatch,signal:controller.signal,idleMs:3000,errorDelayMs:5000,onError:()=>console.error('作答调度失败，稍后重试；未输出凭证或材料内容')},
 ),runWorkerPool(
  async()=>{try{return await runNextProjectSkill(pool,root,undefined,controller.signal) || await runNextRedaction(pool,root,controller.signal) || await runNextAuthoring(pool,root,undefined,controller.signal) || await runNextScore(pool,root,undefined,controller.signal);}catch(error){throw error;}},
  {concurrency:1,beforeDispatch:monitor.beforeDispatch,signal:controller.signal,idleMs:3000,errorDelayMs:5000,onError:()=>console.error('评分调度失败，稍后重试；未输出凭证或材料内容')},
 )]);
} finally { try { await monitor.stop(); } finally { await pool.end(); } }
