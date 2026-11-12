/** 验证网页Agent通道(lane=web)的容量独立性、槽位上限夹取、worker模式规则及064迁移约束；只用临时SQLite与静态文件，不连接PG、不调用浏览器或模型。 */
import {test,expect} from 'bun:test';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {LocalQueue,QueueCapacityError,type QueueJob} from './store';
import {localQueueLimits,webAgentSlotLimit} from './runtime';

function fixture(run:(q:LocalQueue,root:string)=>unknown){const root=mkdtempSync(join(tmpdir(),'queue-web-lane-')),q=new LocalQueue(root,'test-device');return Promise.resolve().then(()=>run(q,root)).finally(()=>{q.close();rmSync(root,{recursive:true,force:true});});}
const intent=(lane:'agent'|'web')=>({id:randomUUID(),kind:'step' as const,lane,route:'authoring'});

test('web lane capacity is independent: a full agent lane does not block web and the seventh web task is rejected with lane=web',()=>fixture(q=>{
 const agents=[intent('agent'),intent('agent')];q.reserveIntents(agents,{agent:2,web:6});for(const item of agents)q.confirm(item.id,2);
 expect(()=>q.reserveIntents([intent('agent')],{agent:2,web:6})).toThrow(QueueCapacityError);
 const web=Array.from({length:6},()=>intent('web'));q.reserveIntents(web,{agent:2,web:6});for(const item of web)expect(q.confirm(item.id,6)).toBe(true);
 expect(q.capacity('web',6)).toMatchObject({lane:'web',queued:6,waiting:6,available:0});expect(q.capacity('agent',2)).toMatchObject({queued:2,waiting:2,available:0});
 let error:unknown;try{q.reserveIntents([intent('web')],{agent:2,web:6});}catch(caught){error=caught;}
 expect(error).toBeInstanceOf(QueueCapacityError);expect((error as QueueCapacityError).lane).toBe('web');expect((error as Error).message).toContain('网页Agent');expect((error as QueueCapacityError).limit).toBe(6);
 // 通道各自领取：agent领取不消耗web，web领取只取web。
 expect(q.claim('agent')?.lane).toBe('agent');const claimed=q.claim('web');expect(claimed?.lane).toBe('web');
 expect(q.capacity('web',6)).toMatchObject({running:1,queued:5});expect(q.capacity('agent',2)).toMatchObject({running:1,queued:1});
}));

test('mixed agent and web admission is all-or-nothing per lane limit',()=>fixture(q=>{
 const full=Array.from({length:6},()=>intent('web'));q.reserveIntents(full,{agent:2,web:6});
 const agent=intent('agent'),web=intent('web');
 expect(()=>q.reserveIntents([agent,web],{agent:2,web:6})).toThrow(QueueCapacityError);
 expect(q.get(agent.id)).toBeNull();expect(q.capacity('agent',2).waiting).toBe(0);
}));

test('webAgentSlotLimit clamps WEB_AGENT_SLOTS to 1..6 and falls back to six',()=>{
 expect(webAgentSlotLimit({})).toBe(6);expect(webAgentSlotLimit({WEB_AGENT_SLOTS:''})).toBe(6);expect(webAgentSlotLimit({WEB_AGENT_SLOTS:' 3 '})).toBe(3);
 expect(webAgentSlotLimit({WEB_AGENT_SLOTS:'0'})).toBe(1);expect(webAgentSlotLimit({WEB_AGENT_SLOTS:'-4'})).toBe(1);expect(webAgentSlotLimit({WEB_AGENT_SLOTS:'99'})).toBe(6);expect(webAgentSlotLimit({WEB_AGENT_SLOTS:'abc'})).toBe(6);
});

test('localQueueLimits reads WEB_AGENT_SLOTS and the live web gate before the environment',()=>fixture(async (q,root)=>{
 const {getAgentConcurrencyGate,closeAgentConcurrencyGate}=await import('../concurrency');
 const before=process.env.WEB_AGENT_SLOTS,gateRoot=join(root,'.execution-web-slots');
 try{
  delete process.env.WEB_AGENT_SLOTS;expect(localQueueLimits(q).web).toBe(6);
  process.env.WEB_AGENT_SLOTS='2';expect(localQueueLimits(q).web).toBe(2);
  process.env.WEB_AGENT_SLOTS='50';expect(localQueueLimits(q).web).toBe(6);
  // 已登记的消费者上限优先，改环境变量未重启时不虚增待领取容量。
  getAgentConcurrencyGate(gateRoot,3);process.env.WEB_AGENT_SLOTS='6';expect(localQueueLimits(q).web).toBe(3);
  expect(localQueueLimits(q)).toMatchObject({hook:1,remote:1});
 }finally{closeAgentConcurrencyGate(gateRoot);if(before===undefined)delete process.env.WEB_AGENT_SLOTS;else process.env.WEB_AGENT_SLOTS=before;}
}));

test('canRunLocalTask consumes web lane only in local/all worker modes',async()=>{
 const {canRunLocalTask}=await import('./worker');
 const base:QueueJob={id:randomUUID(),generation:0,kind:'step',lane:'web',state:'queued',lease:null,pid:null,cancel_requested:0,cancel_synced:0,created_at:0,updated_at:0,route:'authoring',error:null};
 const raw={workflow_id:'w',ordinal:4,execution_target:'local'};
 for(const job of [base,{...base,kind:'library' as const,route:'library:redact'}]){
  const row=job.kind==='library'?{execution_target:'local'}:raw;
  expect(canRunLocalTask('local',job,row,'local')).toBe(true);expect(canRunLocalTask('all',job,row,'local')).toBe(true);
  for(const mode of ['api','server','materials'])expect(canRunLocalTask(mode,job,row,'local')).toBe(false);
 }
 // 范围限定的临时worker仍只领取所列工作流的出题步骤。
 expect(canRunLocalTask('local',base,raw,'local',['w'])).toBe(true);expect(canRunLocalTask('local',base,raw,'local',['other'])).toBe(false);
});

test('064 migration widens lane and library executor checks for web without touching history',()=>{
 const sql=readFileSync(join(import.meta.dir,'../../migrations/064_web_agent_lane.sql'),'utf8');
 expect(sql).toContain("execution_dispatches_lane_check CHECK(lane IN ('agent','api','internal','hook','remote','web'))");
 expect(sql).toContain("library_jobs_executor_kind_check CHECK (executor_kind IN ('internal','api','agent','web'))");
 expect(sql).toContain("library_jobs_executor_target CHECK (executor_kind NOT IN ('agent','web') OR execution_target='local')");
 expect(sql).toContain("(kind='redact' AND executor_kind IN ('internal','api','agent','web'))");
 expect(sql).toContain("(kind='prepare' AND executor_kind IN ('agent','api','web') AND execution_target='local')");
 expect(sql).toContain("(kind='extract' AND executor_kind IN ('internal','api'))");expect(sql).toContain("(kind='intake' AND executor_kind='internal')");
 expect(sql).not.toMatch(/\b(UPDATE|DELETE|INSERT)\b/i);
 const readme=readFileSync(join(import.meta.dir,'../../migrations/README.md'),'utf8');expect(readme).toContain('064_web_agent_lane.sql');
});
