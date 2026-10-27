/**
 * 职责：运行已授权的固定题目批次，只管理本次创建的临时worker及私有stdin。
 * 入口：bun scripts/runtime/run-scoped-batch.ts --state <状态JSON> --tick <推进脚本>。
 * 副作用：推进脚本可派发业务；worker在管道EOF后停领并排空。不接管旧PID、不发终止信号、不重试。
 */
import {openSync,closeSync} from 'node:fs';
import {mkdir,readFile,writeFile,open,unlink,stat} from 'node:fs/promises';
import {resolve,dirname,join,extname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';

/** 子进程句柄和管道只属于本次启动；即使PID复用也不按PID发送信号。 */
export async function manageTemporaryWorker(options:{command:string[];cwd:string;env:Record<string,string|undefined>;logPath:string;tick:()=>Promise<boolean>;onStarted:(pid:number)=>void|Promise<void>;onStopped:(pid:number,code:number)=>void|Promise<void>;intervalMs?:number}){
 const log=openSync(options.logPath,'a',0o600);
 try{
  const child=Bun.spawn(options.command,{cwd:options.cwd,env:options.env,stdin:'pipe',stdout:log,stderr:log,detached:true});
  let exited=false,code:number;const done=child.exited.then(value=>{exited=true;return value;});
  try{
   await options.onStarted(child.pid);
   while(true){
    if(await options.tick())break;
    if(exited)throw new Error('本批临时worker提前退出；保留原attempt，不自动重启');
    await Bun.sleep(options.intervalMs??30000);
   }
  }finally{
   // 不发送TERM；终态检查后刚领到的人工任务仍按原信号自然结算。
   try{await child.stdin.end();}
   finally{code=await done;await options.onStopped(child.pid,code);}
  }
  if(code!==0)throw new Error('临时worker非正常退出，请查看本批运行日志');
 }finally{closeSync(log);}
}

type BatchState={workflow_ids:string[];all_terminal?:boolean;main_worker_pid?:number;worker_stop?:{exited?:boolean;[key:string]:unknown};[key:string]:any};
export async function runScopedBatch(stateFile:string,tickFile:string){
 const statePath=resolve(stateFile),tickPath=resolve(tickFile),root=dirname(statePath),repo=fileURLToPath(new URL('../../',import.meta.url));
 const read=async()=>JSON.parse(await readFile(statePath,'utf8')) as BatchState;
 const save=(state:BatchState)=>writeFile(statePath,JSON.stringify(state,null,2)+'\n');
 const state=await read();if(state.all_terminal){console.log('本批已终态，不启动或停止任何worker。');return;}
 if(!(await stat(tickPath)).isFile())throw new Error('推进脚本不存在，不启动worker');
 const ids=state.workflow_ids;
 if(!Array.isArray(ids)||!ids.length||new Set(ids).size!==ids.length||ids.some(id=>typeof id!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)))throw new Error('必须是已登记、不重复的明确题目ID');
 if(state.main_worker_pid&&!state.worker_stop?.exited)throw new Error('存在尚未确认退出的旧worker，不按PID接管或停止');
 await mkdir(join(root,'evidence'),{recursive:true});
 const lockPath=join(root,'batch-run.lock'),lock=await open(lockPath,'wx',0o600);
 try{
  await lock.writeFile(String(process.pid));
  await manageTemporaryWorker({command:[process.execPath,join(repo,'server/worker.ts')],cwd:repo,
   env:{...process.env,WORKER_MODE:'all',WORKER_WORKFLOW_IDS:ids.join(','),EXECUTION_QUEUE_MODE:'local',WORKER_BATCH_STDIN:'1'},logPath:join(root,'evidence/temporary-worker.log'),
   async onStarted(pid){const s=await read();s.main_worker_pid=pid;delete s.worker_stop;s.worker_control={kind:'private_stdin',owner_pid:process.pid,workflow_ids:ids};await save(s);},
   async onStopped(pid,code){const s=await read();s.worker_stop={pid,exited:true,exit_code:code,method:'stdin_eof_drain',observed_at:new Date().toISOString()};await save(s);},
   async tick(){
    const command=extname(tickPath)==='.py'?['python3',tickPath]:[process.execPath,tickPath];
    const child=Bun.spawn(command,{cwd:repo,stdin:'ignore',stdout:'inherit',stderr:'inherit'});
    if(await child.exited!==0)throw new Error('批次推进失败，停止领取并等待在途任务收尾');
    const current=await read();if(JSON.stringify(current.workflow_ids)!==JSON.stringify(ids))throw new Error('批次范围发生变化，不扩展临时worker');
    return current.all_terminal===true;
   },
  });
 }finally{try{await lock.close();}finally{await unlink(lockPath);}}
}

if(import.meta.main){
 try{const {values}=parseArgs({args:Bun.argv.slice(2),options:{state:{type:'string'},tick:{type:'string'}}});if(!values.state||!values.tick)throw new Error('必须明确提供--state和--tick');await runScopedBatch(values.state,values.tick);}
 catch(error){console.error(error instanceof Error?error.message:'批次执行失败');process.exitCode=1;}
}
