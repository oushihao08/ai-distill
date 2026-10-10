/**
 * 职责：读取／保存 worker 并发配置，并用 STORAGE_DIR 下的 SQLite 配置与槽位表协调跨进程 Agent 调用。
 * SQLite 只保存本机并发配置及临时进程／槽位元数据，不涉及业务数据库迁移。
 */
import {Database} from 'bun:sqlite';
import {chmodSync,mkdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';

const MAX_CONCURRENCY=32;
const PROCESS_TOKEN=randomUUID();
const gateInstances=new Map<string,AgentConcurrencyGate>();

export class AgentConcurrencyConfigurationError extends Error{
 constructor(message:string){super(message);this.name='AgentConcurrencyConfigurationError';}
}

export interface WorkerConcurrencySettings{agent:number;llmApi:number}
export const SAFE_WORKER_CONCURRENCY_LIMITS={agent:4,llmApi:8} as const;

function openConcurrencyDatabase(root:string){
 const directory=join(resolve(root),'.concurrency');
 mkdirSync(directory,{recursive:true,mode:0o700});chmodSync(directory,0o700);
 const path=join(directory,'agent-slots.sqlite3'),database=new Database(path);
 database.exec('PRAGMA busy_timeout = 5000');
 database.exec(`CREATE TABLE IF NOT EXISTS worker_concurrency_settings (
  id INTEGER PRIMARY KEY CHECK(id=1),agent_limit INTEGER NOT NULL,llm_api_limit INTEGER NOT NULL,updated_at TEXT NOT NULL
 )`);
 chmodSync(path,0o600);
 return database;
}

export function readSavedWorkerConcurrencySettings(root:string):WorkerConcurrencySettings|null{
 const database=openConcurrencyDatabase(root);
 try{
  const row=database.query('SELECT agent_limit,llm_api_limit FROM worker_concurrency_settings WHERE id=1').get() as {agent_limit:number;llm_api_limit:number}|null;
  if(!row)return null;
  if(!Number.isInteger(row.agent_limit)||row.agent_limit<1||row.agent_limit>SAFE_WORKER_CONCURRENCY_LIMITS.agent||!Number.isInteger(row.llm_api_limit)||row.llm_api_limit<1||row.llm_api_limit>SAFE_WORKER_CONCURRENCY_LIMITS.llmApi)throw new Error('已保存的并发配置超出安全范围');
  return{agent:row.agent_limit,llmApi:row.llm_api_limit};
 }finally{database.close();}
}

export function saveWorkerConcurrencySettings(root:string,value:unknown):WorkerConcurrencySettings{
 if(!value||typeof value!=='object'||Array.isArray(value))throw new RangeError('并发设置格式无效');
 const settings=value as Record<string,unknown>,agent=settings.agent,llmApi=settings.llmApi;
 if(typeof agent!=='number'||!Number.isInteger(agent)||agent<1||agent>SAFE_WORKER_CONCURRENCY_LIMITS.agent)throw new RangeError(`Agent 并发数必须是 1 到 ${SAFE_WORKER_CONCURRENCY_LIMITS.agent} 之间的整数`);
 if(typeof llmApi!=='number'||!Number.isInteger(llmApi)||llmApi<1||llmApi>SAFE_WORKER_CONCURRENCY_LIMITS.llmApi)throw new RangeError(`API 并发数必须是 1 到 ${SAFE_WORKER_CONCURRENCY_LIMITS.llmApi} 之间的整数`);
 const saved={agent,llmApi},database=openConcurrencyDatabase(root);
 try{database.query(`INSERT INTO worker_concurrency_settings(id,agent_limit,llm_api_limit,updated_at) VALUES(1,?,?,?)
  ON CONFLICT(id) DO UPDATE SET agent_limit=excluded.agent_limit,llm_api_limit=excluded.llm_api_limit,updated_at=excluded.updated_at`).run(saved.agent,saved.llmApi,new Date().toISOString());}
 finally{database.close();}
 return saved;
}

function configuredLimit(value:string|undefined,name:string,fallback:number):number{
 if(value===undefined||value.trim()==='')return fallback;
 const normalized=value.trim();
 if(!/^\d+$/.test(normalized))throw new RangeError(`${name} 必须是 1 到 ${MAX_CONCURRENCY} 之间的整数`);
 const parsed=Number(normalized);
 if(!Number.isSafeInteger(parsed)||parsed<1||parsed>MAX_CONCURRENCY)throw new RangeError(`${name} 必须是 1 到 ${MAX_CONCURRENCY} 之间的整数`);
 return parsed;
}

export function readConcurrencySettings(env:NodeJS.ProcessEnv=process.env,storageRoot?:string){
 const saved=storageRoot?readSavedWorkerConcurrencySettings(storageRoot):null;
 if(saved)return saved;
 return{
  agent:configuredLimit(env.AGENT_CONCURRENCY,'AGENT_CONCURRENCY',2),
  llmApi:configuredLimit(env.LLM_API_CONCURRENCY,'LLM_API_CONCURRENCY',8),
 };
}

function processIsAlive(pid:number):boolean{
 try{process.kill(pid,0);return true;}
 catch(error){
  const code=error&&typeof error==='object'&&'code'in error?error.code:undefined;
  return code!=='ESRCH';
 }
}

function delay(ms:number,signal?:AbortSignal):Promise<void>{
 return new Promise(resolvePromise=>{
  let timer:ReturnType<typeof setTimeout>|undefined;
  const finish=()=>{if(timer)clearTimeout(timer);signal?.removeEventListener('abort',finish);resolvePromise();};
  if(signal?.aborted){finish();return;}
  timer=setTimeout(finish,ms);
  signal?.addEventListener('abort',finish,{once:true});
  if(signal?.aborted)finish();
 });
}

export class AgentConcurrencyGate{
 readonly limit:number;
 readonly root:string;
 private readonly database:Database;
 private readonly pid=process.pid;
 private readonly leaseToken=randomUUID();
 private active=0;
 private closed=false;

 constructor(root:string,limit:number){
  if(!Number.isInteger(limit)||limit<1||limit>MAX_CONCURRENCY)throw new RangeError(`Agent 并发数必须是 1 到 ${MAX_CONCURRENCY} 之间的整数`);
  this.limit=limit;
  this.root=resolve(root);
  this.database=openConcurrencyDatabase(this.root);
  try{
   this.database.exec(`
    CREATE TABLE IF NOT EXISTS agent_concurrency_owners (
     pid INTEGER PRIMARY KEY,
     token TEXT NOT NULL,
     concurrency_limit INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS agent_concurrency_slots (
     slot INTEGER PRIMARY KEY,
     owner_pid INTEGER NOT NULL,
     owner_token TEXT NOT NULL,
     lease_token TEXT NOT NULL
    );
   `);
   this.registerProcess();
  }catch(error){this.database.close();throw error;}
 }

 private transaction<T>(operation:()=>T):T{
  let open=false;
  try{
   this.database.exec('BEGIN IMMEDIATE');open=true;
   const result=operation();
   this.database.exec('COMMIT');open=false;
   return result;
  }catch(error){
   if(open){
    try{this.database.exec('ROLLBACK');}
    catch(rollbackError){throw new AggregateError([error,rollbackError],'Agent 并发状态事务回滚失败');}
   }
   throw error;
  }
 }

 private pruneStaleOwners():Map<number,{token:string;limit:number}>{
  const owners=this.database.query('SELECT pid,token,concurrency_limit FROM agent_concurrency_owners').all() as {pid:number;token:string;concurrency_limit:number}[];
  for(const owner of owners){
   if(!processIsAlive(owner.pid)||(owner.pid===this.pid&&owner.token!==PROCESS_TOKEN)){
    this.database.query('DELETE FROM agent_concurrency_slots WHERE owner_pid=?').run(owner.pid);
    this.database.query('DELETE FROM agent_concurrency_owners WHERE pid=? AND token=?').run(owner.pid,owner.token);
   }
  }
  return new Map((this.database.query('SELECT pid,token,concurrency_limit FROM agent_concurrency_owners').all() as {pid:number;token:string;concurrency_limit:number}[]).map(owner=>[owner.pid,{token:owner.token,limit:owner.concurrency_limit}]));
 }

 private registerProcess():void{
  this.transaction(()=>{
   const owners=this.pruneStaleOwners();
   for(const[pid,owner]of owners){
    if(pid!==this.pid&&owner.limit!==this.limit)throw new AgentConcurrencyConfigurationError('API 与 worker 的 AGENT_CONCURRENCY 配置不一致，请统一后再运行');
   }
   const current=owners.get(this.pid);
   if(current&&current.token===PROCESS_TOKEN&&current.limit!==this.limit)throw new AgentConcurrencyConfigurationError('本进程 Agent 并发配置已改变，请重启服务后再运行');
   this.database.query(`INSERT INTO agent_concurrency_owners(pid,token,concurrency_limit) VALUES(?,?,?)
    ON CONFLICT(pid) DO UPDATE SET token=excluded.token,concurrency_limit=excluded.concurrency_limit`).run(this.pid,PROCESS_TOKEN,this.limit);
  });
 }

 private reserveSlot():number|null{
  return this.transaction(()=>{
   const owners=this.pruneStaleOwners();
   if([...owners.values()].some(owner=>owner.limit!==this.limit))throw new AgentConcurrencyConfigurationError('API 与 worker 的 AGENT_CONCURRENCY 配置不一致，请统一后再运行');
   const occupied=new Set((this.database.query('SELECT slot FROM agent_concurrency_slots').all() as {slot:number}[]).map(row=>row.slot));
   for(let slot=0;slot<this.limit;slot++){
    if(occupied.has(slot))continue;
    this.database.query('INSERT INTO agent_concurrency_slots(slot,owner_pid,owner_token,lease_token) VALUES(?,?,?,?)').run(slot,this.pid,PROCESS_TOKEN,this.leaseToken);
    return slot;
   }
   return null;
  });
 }

 private releaseSlot(slot:number):void{
  this.transaction(()=>{this.database.query('DELETE FROM agent_concurrency_slots WHERE slot=? AND owner_pid=? AND owner_token=? AND lease_token=?').run(slot,this.pid,PROCESS_TOKEN,this.leaseToken);});
 }

 async run<T>(execute:()=>Promise<T>,options:{wait?:boolean;signal?:AbortSignal;pollMs?:number}={}):Promise<{acquired:false}|{acquired:true;value:T}>{
  const{wait=true,signal,pollMs=250}=options;
  if(!Number.isInteger(pollMs)||pollMs<1)throw new RangeError('Agent 并发等待间隔无效');
  while(!signal?.aborted){
   if(this.closed)throw new Error('Agent 并发控制器已关闭');
   const slot=this.reserveSlot();
   if(slot!==null){
    this.active++;
    let value!:T,executeError:unknown,executeFailed=false,releaseError:unknown;
    try{value=await execute();}catch(error){executeError=error;executeFailed=true;}
    try{this.releaseSlot(slot);}catch(error){releaseError=error;}
    this.active--;
    if(executeFailed&&releaseError)throw new AggregateError([executeError,releaseError],'Agent 执行和并发名额释放均失败');
    if(executeFailed)throw executeError;
    if(releaseError)throw new Error('Agent 并发名额释放失败');
    return{acquired:true,value};
   }
   if(!wait)return{acquired:false};
   await delay(pollMs,signal);
  }
  return{acquired:false};
 }

 close(){
  if(this.closed)return;
  if(this.active>0)throw new Error('Agent 并发控制器仍有运行中的任务');
  try{this.transaction(()=>{this.database.query('DELETE FROM agent_concurrency_slots WHERE owner_pid=? AND owner_token=? AND lease_token=?').run(this.pid,PROCESS_TOKEN,this.leaseToken);});}
  finally{this.closed=true;this.database.close();}
 }
}

export function createAgentConcurrencyGate(root:string,limit:number){return new AgentConcurrencyGate(root,limit);}

export function getAgentConcurrencyGate(root:string,limit:number){
 const key=resolve(root),existing=gateInstances.get(key);
 if(existing){if(existing.limit!==limit)throw new AgentConcurrencyConfigurationError('本进程 Agent 并发配置已改变，请重启服务后再运行');return existing;}
 const gate=createAgentConcurrencyGate(key,limit);
 gateInstances.set(key,gate);
 return gate;
}

export function closeAgentConcurrencyGate(root:string){
 const key=resolve(root),gate=gateInstances.get(key);
 if(gate){gate.close();gateInstances.delete(key);}
}
