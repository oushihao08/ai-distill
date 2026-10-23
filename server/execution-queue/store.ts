/** 本机执行队列：API持久化意图，worker原子领取；不存凭证、不执行业务SQL。公开入口 LocalQueue。 */
import {Database} from 'bun:sqlite';
import {mkdirSync,chmodSync,readFileSync,writeFileSync,linkSync,unlinkSync} from 'node:fs';
import {homedir} from 'node:os';
import {join,resolve} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {serialize,deserialize} from 'node:v8';
export type JobKind='step'|'skill'|'library'|'hook'|'remote';
export type Lane='agent'|'api'|'internal'|'hook'|'remote';
export type QueueState='pending_registration'|'queued'|'running'|'result_pending_commit'|'needs_review'|'committed'|'cancelled'|'failed'|'stale';
export interface QueueJob {id:string;generation:number;kind:JobKind;lane:Lane;state:QueueState;lease:string|null;pid:number|null;cancel_requested:number;cancel_synced:number;created_at:number;updated_at:number;route:string;error:string|null}
/** 已由业务处理器判定的终态；私有检查点仅供原任务原代次补交，不用于再次执行模型。 */
export interface StepFailure {status:'failed'|'skipped';message:string;result:unknown}
export class InvalidLocalCheckpoint extends Error {}
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function assertJobId(id:string){if(!uuid.test(id))throw new Error('执行任务ID必须是UUID');}
export class LocalQueue {
 readonly db:Database;readonly executorId:string;readonly root:string;
 constructor(root:string,deviceToken?:string){
  this.root=resolve(root);const directory=join(this.root,'runtime');mkdirSync(directory,{recursive:true,mode:0o700});chmodSync(directory,0o700);
  const path=join(directory,'queue.sqlite3');this.db=new Database(path);chmodSync(path,0o600);
  this.db.exec(`PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;PRAGMA busy_timeout=5000;PRAGMA foreign_keys=ON;
   CREATE TABLE IF NOT EXISTS identity(id INTEGER PRIMARY KEY CHECK(id=1),executor_id TEXT NOT NULL,device_digest TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,generation INTEGER NOT NULL DEFAULT 0,kind TEXT NOT NULL,lane TEXT NOT NULL,state TEXT NOT NULL,route TEXT NOT NULL,lease TEXT,pid INTEGER,cancel_requested INTEGER NOT NULL DEFAULT 0,cancel_synced INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,error TEXT);
   CREATE INDEX IF NOT EXISTS jobs_lane_state ON jobs(lane,state,created_at);
   CREATE TABLE IF NOT EXISTS calls(job_id TEXT NOT NULL,call_key TEXT NOT NULL,state TEXT NOT NULL,result BLOB,sha256 TEXT,PRIMARY KEY(job_id,call_key),FOREIGN KEY(job_id) REFERENCES jobs(id));`);
  if(!(this.db.query('PRAGMA table_info(jobs)').all() as {name:string}[]).some(c=>c.name==='cancel_synced'))this.db.exec('ALTER TABLE jobs ADD COLUMN cancel_synced INTEGER NOT NULL DEFAULT 0');
  if(!(this.db.query('PRAGMA table_info(jobs)').all() as {name:string}[]).some(c=>c.name==='generation'))this.db.exec('ALTER TABLE jobs ADD COLUMN generation INTEGER NOT NULL DEFAULT 0');
  if(!deviceToken){const home=join(homedir(),'.local','share','ai-distill');mkdirSync(home,{recursive:true,mode:0o700});const tokenPath=join(home,'device-id');const temporary=join(home,`.device-${randomUUID()}`);try{writeFileSync(temporary,randomUUID(),{flag:'wx',mode:0o600});try{linkSync(temporary,tokenPath);}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}}finally{try{unlinkSync(temporary);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}deviceToken=readFileSync(tokenPath,'utf8').trim();if(!uuid.test(deviceToken))throw new Error('本机设备标记无效，请核实运行目录而非重置活动队列');}
  const digest=createHash('sha256').update(deviceToken).digest('hex');
  this.db.query('INSERT OR IGNORE INTO identity VALUES(1,?,?)').run(randomUUID(),digest);
  const identity=this.db.query('SELECT executor_id,device_digest FROM identity WHERE id=1').get() as {executor_id:string;device_digest:string};
  if(identity.device_digest!==digest){this.db.close();throw new Error('该运行目录来自另一台电脑；不得复制活动队列，请使用新的本机运行目录');}
  this.executorId=identity.executor_id;
 }
 intent(id:string,kind:JobKind,lane:Lane,route:string){assertJobId(id);const now=Date.now();this.db.query("INSERT OR IGNORE INTO jobs(id,kind,lane,state,route,created_at,updated_at) VALUES(?,?,?,'pending_registration',?,?,?)").run(id,kind,lane,route,now,now);const row=this.get(id)!;if(row.kind!==kind||row.lane!==lane||row.route!==route)throw new Error('同任务ID对应不同执行意图');}
 get(id:string){return this.db.query('SELECT * FROM jobs WHERE id=?').get(id) as QueueJob|null;}
 list(){return this.db.query('SELECT * FROM jobs ORDER BY created_at,id').all() as QueueJob[];}
 confirm(id:string){this.db.query("UPDATE jobs SET state=CASE WHEN cancel_requested=1 THEN 'cancelled' ELSE 'queued' END,updated_at=? WHERE id=? AND state='pending_registration'").run(Date.now(),id);}
 claim(lane:Lane){return this.db.transaction(()=>{const row=this.db.query("SELECT * FROM jobs WHERE lane=? AND (state='queued' OR (state='result_pending_commit' AND updated_at<?)) AND cancel_requested=0 ORDER BY created_at,id LIMIT 1").get(lane,Date.now()-5000) as QueueJob|null;if(!row)return null;const lease=randomUUID();this.db.query("UPDATE jobs SET state='running',lease=?,pid=?,updated_at=? WHERE id=?").run(lease,process.pid,Date.now(),row.id);return this.get(row.id);}).immediate();}
 heartbeat(id:string,lease:string){return this.db.query("UPDATE jobs SET updated_at=? WHERE id=? AND lease=? AND state='running' AND cancel_requested=0").run(Date.now(),id,lease).changes===1;}
 finish(id:string,lease:string,state:QueueState,error:string|null=null){return this.db.query('UPDATE jobs SET state=?,error=?,lease=NULL,pid=NULL,updated_at=? WHERE id=? AND lease=?').run(state,error,Date.now(),id,lease).changes===1;}
 cancel(id:string){this.db.query("UPDATE jobs SET cancel_requested=1,cancel_synced=0,state=CASE WHEN state IN ('pending_registration','queued','result_pending_commit') THEN 'cancelled' ELSE state END,updated_at=? WHERE id=? AND state NOT IN ('committed','failed','cancelled','stale')").run(Date.now(),id);}
 resolve(id:string,state:QueueState){this.db.query('UPDATE jobs SET state=?,lease=NULL,pid=NULL,updated_at=? WHERE id=?').run(state,Date.now(),id);}
 settle(id:string,state:QueueState){this.db.query("UPDATE jobs SET state=?,updated_at=? WHERE id=? AND state IN ('needs_review','result_pending_commit')").run(state,Date.now(),id);}
 rearm(id:string,generation:number){this.db.query("UPDATE jobs SET generation=?,state='pending_registration',lease=NULL,pid=NULL,cancel_requested=0,cancel_synced=0,error=NULL,updated_at=? WHERE id=?").run(generation,Date.now(),id);}
 confirmCancellation(id:string){this.db.query('UPDATE jobs SET cancel_synced=1 WHERE id=? AND cancel_requested=1').run(id);}
 recover(){
  for(const row of this.list().filter(j=>j.state==='running'&&j.pid)){
   let alive=true;try{process.kill(row.pid!,0);}catch(error){if((error as NodeJS.ErrnoException).code==='ESRCH')alive=false;}
   if(alive)continue;
   try{const failure=this.stepFailure(row),unknown=this.hasUnknownCall(row.id);this.finish(row.id,row.lease!,failure||!unknown?'result_pending_commit':'needs_review',unknown&&!failure?'调用结果未完成确认，禁止自动重复调用':null);}
   catch{this.finish(row.id,row.lease!,'needs_review','本地检查点损坏，需人工核实');}
  }
 }
 async call<T>(jobId:string,key:string,execute:()=>Promise<T>):Promise<T>{
  const prior=this.db.query('SELECT * FROM calls WHERE job_id=? AND call_key=?').get(jobId,key) as {state:string;result:Uint8Array;sha256:string}|null;
  if(prior){if(prior.state!=='completed')throw new Error('调用结果未知，需核实后再执行');const bytes=Buffer.from(prior.result);if(createHash('sha256').update(bytes).digest('hex')!==prior.sha256)throw new Error('本地结果摘要不一致');return deserialize(bytes) as T;}
  this.db.query("INSERT INTO calls(job_id,call_key,state) VALUES(?,?,'started')").run(jobId,key);
  const result=await execute();const bytes=serialize(result),digest=createHash('sha256').update(bytes).digest('hex');
  this.db.query("UPDATE calls SET state='completed',result=?,sha256=? WHERE job_id=? AND call_key=? AND state='started'").run(bytes,digest,jobId,key);return result;
 }
 hasUnknownCall(id:string){return Boolean(this.db.query("SELECT 1 FROM calls WHERE job_id=? AND state IN ('started','rejected') AND (call_key LIKE ? OR call_key NOT GLOB '[0-9]*:*') LIMIT 1").get(id,`${this.get(id)?.generation??0}:%`));}
 hasResult(id:string){return Boolean(this.db.query("SELECT 1 FROM calls WHERE job_id=? AND state='completed' AND (call_key LIKE ? OR call_key NOT GLOB '[0-9]*:*') LIMIT 1").get(id,`${this.get(id)?.generation??0}:%`));}
 saveStepFailure(job:QueueJob,failure:StepFailure){
  const bytes=serialize(failure),digest=createHash('sha256').update(bytes).digest('hex');
  this.db.query("INSERT OR IGNORE INTO calls(job_id,call_key,state,result,sha256) VALUES(?,?,'terminal_failure',?,?)").run(job.id,`${job.generation}:terminal_failure`,bytes,digest);
 }
 stepFailure(job:QueueJob):StepFailure|null{
  const row=this.db.query("SELECT result,sha256 FROM calls WHERE job_id=? AND call_key=? AND state='terminal_failure'").get(job.id,`${job.generation}:terminal_failure`) as {result:Uint8Array;sha256:string}|null;
  if(!row)return null;
  const bytes=Buffer.from(row.result);if(createHash('sha256').update(bytes).digest('hex')!==row.sha256)throw new InvalidLocalCheckpoint('失败检查点摘要不一致');
  try{const value=deserialize(bytes) as StepFailure;if(!value||!['failed','skipped'].includes(value.status)||typeof value.message!=='string')throw new Error('invalid');return value;}catch{throw new InvalidLocalCheckpoint('失败检查点格式无效');}
 }
 close(){this.db.close();}
}
