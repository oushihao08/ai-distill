/** 本机执行队列：API持久化意图，worker原子领取；不存凭证、不执行业务SQL。公开入口 LocalQueue。 */
import {Database} from 'bun:sqlite';
import {mkdirSync,chmodSync,readFileSync,writeFileSync,linkSync,unlinkSync} from 'node:fs';
import {homedir} from 'node:os';
import {join,resolve} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {serialize,deserialize} from 'node:v8';
export type JobKind='step'|'skill'|'library'|'hook'|'remote'|'advice';
export type Lane='agent'|'api'|'internal'|'hook'|'remote';
export type QueueState='pending_registration'|'queued'|'running'|'result_pending_commit'|'needs_review'|'committed'|'cancelled'|'failed'|'stale';
export interface QueueJob {id:string;generation:number;kind:JobKind;lane:Lane;state:QueueState;lease:string|null;pid:number|null;cancel_requested:number;cancel_synced:number;created_at:number;updated_at:number;route:string;error:string|null}
export interface QueueIntent {id:string;kind:JobKind;lane:Lane;route:string}
export class QueueCapacityError extends Error {
 readonly code='local_queue_full';
 constructor(readonly lane:Lane,readonly limit:number,readonly waiting:number,readonly requested:number){super(`本机 ${lane==='agent'?'Agent':lane==='api'?'API':lane} 待领取容量不足：上限 ${limit}，已占 ${waiting}，本次需 ${requested}；未派发`);this.name='QueueCapacityError';}
}
/** 已由业务处理器判定的终态；私有检查点仅供原任务原代次补交，不用于再次执行模型。 */
export interface StepFailure {status:'failed'|'skipped';message:string;result:unknown}
export interface LibraryFailure {status:'failed'|'cancelled';code:string;message:string;lease_token:string}
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
   CREATE TABLE IF NOT EXISTS calls(job_id TEXT NOT NULL,call_key TEXT NOT NULL,state TEXT NOT NULL,result BLOB,sha256 TEXT,PRIMARY KEY(job_id,call_key),FOREIGN KEY(job_id) REFERENCES jobs(id));
   CREATE TABLE IF NOT EXISTS admissions(job_id TEXT PRIMARY KEY,lane TEXT NOT NULL,FOREIGN KEY(job_id) REFERENCES jobs(id));`);
  if(!(this.db.query('PRAGMA table_info(jobs)').all() as {name:string}[]).some(c=>c.name==='cancel_synced'))this.db.exec('ALTER TABLE jobs ADD COLUMN cancel_synced INTEGER NOT NULL DEFAULT 0');
  if(!(this.db.query('PRAGMA table_info(jobs)').all() as {name:string}[]).some(c=>c.name==='generation'))this.db.exec('ALTER TABLE jobs ADD COLUMN generation INTEGER NOT NULL DEFAULT 0');
  this.db.exec(`CREATE INDEX IF NOT EXISTS jobs_state_created ON jobs(state,created_at,id);
   CREATE INDEX IF NOT EXISTS jobs_kind_state ON jobs(kind,state);
   CREATE INDEX IF NOT EXISTS jobs_unsynced_cancel ON jobs(created_at,id) WHERE cancel_requested=1 AND cancel_synced=0;`);
  if(!deviceToken){const home=join(homedir(),'.local','share','ai-distill');mkdirSync(home,{recursive:true,mode:0o700});const tokenPath=join(home,'device-id');const temporary=join(home,`.device-${randomUUID()}`);try{writeFileSync(temporary,randomUUID(),{flag:'wx',mode:0o600});try{linkSync(temporary,tokenPath);}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}}finally{try{unlinkSync(temporary);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}deviceToken=readFileSync(tokenPath,'utf8').trim();if(!uuid.test(deviceToken))throw new Error('本机设备标记无效，请核实运行目录而非重置活动队列');}
  const digest=createHash('sha256').update(deviceToken).digest('hex');
  this.db.query('INSERT OR IGNORE INTO identity VALUES(1,?,?)').run(randomUUID(),digest);
  const identity=this.db.query('SELECT executor_id,device_digest FROM identity WHERE id=1').get() as {executor_id:string;device_digest:string};
  if(identity.device_digest!==digest){this.db.close();throw new Error('该运行目录来自另一台电脑；不得复制活动队列，请使用新的本机运行目录');}
  this.executorId=identity.executor_id;
 }
 releaseAdmission(id:string){this.db.query("DELETE FROM admissions WHERE job_id=? AND EXISTS(SELECT 1 FROM jobs WHERE id=? AND state='pending_registration')").run(id,id);}
 intent(id:string,kind:JobKind,lane:Lane,route:string){assertJobId(id);const now=Date.now();this.db.query("INSERT OR IGNORE INTO jobs(id,kind,lane,state,route,created_at,updated_at) VALUES(?,?,?,'pending_registration',?,?,?)").run(id,kind,lane,route,now,now);const row=this.get(id)!;if(row.kind!==kind||row.lane!==lane||row.route!==route)throw new Error('同任务ID对应不同执行意图');}
 /** 整组预留待领取名额。事务中尚未登记PG的预留也占名额；历史未登记记录不自动占用或释放。 */
 reserveIntents(entries:QueueIntent[],limits:Partial<Record<Lane,number>>){
  return this.db.transaction(()=>{
   const unique=new Map<string,QueueIntent>();
   for(const entry of entries){assertJobId(entry.id);const previous=unique.get(entry.id)??this.get(entry.id);if(previous&&(previous.kind!==entry.kind||previous.lane!==entry.lane||previous.route!==entry.route))throw new Error('同任务ID对应不同执行意图');unique.set(entry.id,entry);}
   const requested=new Map<Lane,number>();
   for(const entry of unique.values()){
    const row=this.get(entry.id),reserved=this.db.query('SELECT 1 FROM admissions WHERE job_id=?').get(entry.id);
    if(!row||row.state==='pending_registration'&&!row.cancel_requested&&!reserved)requested.set(entry.lane,(requested.get(entry.lane)??0)+1);
   }
   for(const [lane,count] of requested){const limit=limits[lane];if(limit===undefined)throw new Error('本机队列缺少消费池容量配置');const capacity=this.capacity(lane,limit);if(count>capacity.available)throw new QueueCapacityError(lane,limit,capacity.waiting,count);}
   for(const entry of unique.values()){
    this.intent(entry.id,entry.kind,entry.lane,entry.route);
    const row=this.get(entry.id)!;if(row.state==='pending_registration'&&!row.cancel_requested)this.db.query('INSERT OR IGNORE INTO admissions(job_id,lane) VALUES(?,?)').run(entry.id,entry.lane);
   }
  }).immediate();
 }
 capacity(lane:Lane,limit:number){
  if(!Number.isSafeInteger(limit)||limit<1||limit>32)throw new Error('本机队列容量配置无效');
  const row=this.db.query("SELECT COALESCE(sum(state='running'),0) AS running,COALESCE(sum(state='queued' AND cancel_requested=0),0) AS queued,COALESCE(sum(state='pending_registration' AND cancel_requested=0 AND EXISTS(SELECT 1 FROM admissions a WHERE a.job_id=jobs.id)),0) AS reserved FROM jobs WHERE lane=? AND state IN ('running','queued','pending_registration')").get(lane) as {running:number;queued:number;reserved:number};
  const waiting=row.queued+row.reserved;return{lane,limit,...row,waiting,available:Math.max(0,limit-waiting)};
 }
 get(id:string){return this.db.query('SELECT * FROM jobs WHERE id=?').get(id) as QueueJob|null;}
 list(){return this.db.query('SELECT * FROM jobs ORDER BY created_at,id').all() as QueueJob[];}
 /** 周期监控只读取活动行；历史结果保留在list的显式管理入口中。 */
 activeJobs(){return this.db.query("SELECT * FROM jobs WHERE state='running' OR (state='queued' AND cancel_requested=0) ORDER BY created_at,id").all() as QueueJob[];}
 monitorJobs(){return this.db.query("SELECT * FROM jobs WHERE state IN ('pending_registration','queued','running','result_pending_commit','needs_review') ORDER BY created_at,id").all() as QueueJob[];}
 stateCounts(kind:JobKind){const rows=this.db.query('SELECT state,count(*) AS count FROM jobs WHERE kind=? GROUP BY state').all(kind) as {state:string;count:number}[];return Object.fromEntries(rows.map(row=>[row.state,row.count])) as Record<string,number>;}
 runningJobs(){return this.db.query("SELECT * FROM jobs WHERE state='running' ORDER BY created_at,id").all() as QueueJob[];}
 /** 按稳定键分页对账；不把全量历史或全部待核实行搬入JS，也不因前页长期未决饿死后页。 */
 reconciliationPage(kind:'registration'|'cancel'|'finished',after?:Pick<QueueJob,'created_at'|'id'>){
  const where=kind==='registration'?"state='pending_registration'":kind==='cancel'?"cancel_requested=1 AND cancel_synced=0":"state IN ('needs_review','result_pending_commit')";
  const read=(cursor?:Pick<QueueJob,'created_at'|'id'>)=>this.db.query(`SELECT * FROM jobs WHERE ${where}${cursor?' AND (created_at,id)>(?,?)':''} ORDER BY created_at,id LIMIT 20`).all(...(cursor?[cursor.created_at,cursor.id]:[])) as QueueJob[];
  const page=read(after);return page.length||!after?page:read();
 }

 pending(lane:Lane){return this.db.query("SELECT * FROM jobs WHERE lane=? AND cancel_requested=0 AND (state='queued' OR (state='result_pending_commit' AND updated_at<?)) ORDER BY created_at,id").all(lane,Date.now()-5000) as QueueJob[];}
 confirm(id:string,limit?:number){return this.db.transaction(()=>{
  const row=this.get(id);if(!row||row.state!=='pending_registration')return false;
  if(!row.cancel_requested&&limit!==undefined){const capacity=this.capacity(row.lane,limit),reserved=Boolean(this.db.query('SELECT 1 FROM admissions WHERE job_id=?').get(id));if(capacity.waiting+(reserved?0:1)>limit)return false;}
  this.db.query("UPDATE jobs SET state=CASE WHEN cancel_requested=1 THEN 'cancelled' ELSE 'queued' END,updated_at=? WHERE id=? AND state='pending_registration'").run(Date.now(),id);
  this.db.query('DELETE FROM admissions WHERE job_id=?').run(id);return true;
 }).immediate();}
 claim(lane:Lane,allowedIds?:string[]){if(allowedIds?.length===0)return null;for(const id of allowedIds??[])assertJobId(id);return this.db.transaction(()=>{const row=this.db.query("SELECT * FROM jobs WHERE lane=? AND (state='queued' OR (state='result_pending_commit' AND updated_at<?)) AND cancel_requested=0"+(allowedIds?` AND id IN (${allowedIds.map(()=>'?').join(',')})`:'')+" ORDER BY created_at,id LIMIT 1").get(lane,Date.now()-5000,...(allowedIds??[])) as QueueJob|null;if(!row)return null;const lease=randomUUID();this.db.query("UPDATE jobs SET state='running',lease=?,pid=?,updated_at=? WHERE id=?").run(lease,process.pid,Date.now(),row.id);return this.get(row.id);}).immediate();}
 heartbeat(id:string,lease:string){return this.db.query("UPDATE jobs SET updated_at=? WHERE id=? AND lease=? AND state='running' AND cancel_requested=0").run(Date.now(),id,lease).changes===1;}
 finish(id:string,lease:string,state:QueueState,error:string|null=null){return this.db.query('UPDATE jobs SET state=?,error=?,lease=NULL,pid=NULL,updated_at=? WHERE id=? AND lease=?').run(state,error,Date.now(),id,lease).changes===1;}
 cancel(id:string){this.db.query("UPDATE jobs SET cancel_requested=1,cancel_synced=0,state=CASE WHEN state IN ('pending_registration','queued','result_pending_commit') THEN 'cancelled' ELSE state END,updated_at=? WHERE id=? AND state NOT IN ('committed','failed','cancelled','stale')").run(Date.now(),id);}
 resolve(id:string,state:QueueState){this.db.query('UPDATE jobs SET state=?,lease=NULL,pid=NULL,updated_at=? WHERE id=?').run(state,Date.now(),id);}
 settle(id:string,state:QueueState){this.db.query("UPDATE jobs SET state=?,updated_at=? WHERE id=? AND state IN ('needs_review','result_pending_commit')").run(state,Date.now(),id);}
 rearm(id:string,generation:number,limit?:number){return this.db.transaction(()=>{
  const row=this.get(id);if(!row)throw new Error('原任务本机记录缺失');
  if(limit!==undefined){const capacity=this.capacity(row.lane,limit),counted=!row.cancel_requested&&(row.state==='queued'||row.state==='pending_registration'&&Boolean(this.db.query('SELECT 1 FROM admissions WHERE job_id=?').get(id)));if(capacity.waiting+(counted?0:1)>limit)throw new QueueCapacityError(row.lane,limit,capacity.waiting,1);}
  this.db.query("UPDATE jobs SET generation=?,state='pending_registration',lease=NULL,pid=NULL,cancel_requested=0,cancel_synced=0,error=NULL,updated_at=? WHERE id=?").run(generation,Date.now(),id);
  if(limit!==undefined)this.db.query('INSERT OR IGNORE INTO admissions(job_id,lane) VALUES(?,?)').run(id,row.lane);
 }).immediate();}
 confirmCancellation(id:string){this.db.query('UPDATE jobs SET cancel_synced=1 WHERE id=? AND cancel_requested=1').run(id);}
 recover(){
  for(const row of this.runningJobs().filter(j=>j.pid)){
   let alive=true;try{process.kill(row.pid!,0);}catch(error){if((error as NodeJS.ErrnoException).code==='ESRCH')alive=false;}
   if(alive)continue;
   try{const failure=this.stepFailure(row)||this.libraryFailure(row),unknown=this.hasUnknownCall(row.id);this.finish(row.id,row.lease!,failure||!unknown?'result_pending_commit':'needs_review',unknown&&!failure?'调用结果未完成确认，禁止自动重复调用':null);}
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
 saveLibraryFailure(job:QueueJob,failure:LibraryFailure){
  const bytes=serialize(failure),digest=createHash('sha256').update(bytes).digest('hex');
  this.db.query("INSERT OR IGNORE INTO calls(job_id,call_key,state,result,sha256) VALUES(?,?,'terminal_failure',?,?)").run(job.id,`${job.generation}:library_failure`,bytes,digest);
 }
 libraryFailure(job:QueueJob):LibraryFailure|null{
  const row=this.db.query("SELECT result,sha256 FROM calls WHERE job_id=? AND call_key=? AND state='terminal_failure'").get(job.id,`${job.generation}:library_failure`) as {result:Uint8Array;sha256:string}|null;
  if(!row)return null;
  const bytes=Buffer.from(row.result);
  if(createHash('sha256').update(bytes).digest('hex')!==row.sha256)throw new InvalidLocalCheckpoint('材料失败检查点摘要不一致');
  try{
   const value=deserialize(bytes) as LibraryFailure;
   if(!value||!['failed','cancelled'].includes(value.status)||typeof value.message!=='string'||typeof value.code!=='string'||typeof value.lease_token!=='string')throw new Error('invalid');
   return value;
  }catch{throw new InvalidLocalCheckpoint('材料失败检查点格式无效');}
 }
 close(){this.db.close();}
}
