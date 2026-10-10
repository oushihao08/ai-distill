/** 验证作答队列的输入冻结、供应商调用、结果落盘、过期隔离与取消处理。
 * 运行方式：由 Bun test 收集本文件用例；修改对应模块时针对该文件回归验证。
 */
import {test,expect} from 'bun:test';
import type {Pool} from 'pg';
import {enqueueAnswer,runNextAnswer} from './jobs';
import {inputDigest} from './input';
import {createHash} from 'node:crypto';
import {mkdtemp,writeFile,mkdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
const q={question_version:'v1',question:'题面',attachment_ids:['attachment'],quality_check:{passed:true},answer_requirements:{input_mode:'text',output_mode:'text',tools:[]}};
const config={provider:'qwen',base_url:'https://openrouter.ai/api/v1',model:'qwen/qwen-plus'};
function fake(options:{reuse?:boolean;previousByModel?:Record<string,string>;question?:unknown;inactive?:boolean;empty?:boolean;publishError?:boolean;published?:boolean;stale?:boolean;unready?:boolean;models?:any[];summary?:any[]}={}){
 const calls:{sql:string;values:any[]}[]=[];
 const input={question_attempt_id:'author',question_version:'v1',question:'题面',materials:[{name:'附件1',text:'脱敏'}],attachments:[{id:'attachment',sha256:hash('脱敏')}],input_digest:''};
 input.input_digest=inputDigest({question_version:input.question_version,question:input.question,materials:input.materials,attachments:input.attachments});
 const job={id:'answer',workflow_id:'workflow',input,config};
 const query=async(sql:string,values:any[]=[])=>{
  calls.push({sql,values});
  if(sql.startsWith('SELECT id,input,result,status FROM ai_distill.step_attempts'))return {rowCount:options.summary?.length??0,rows:options.summary??[]};
  if(sql.startsWith('SELECT s.model_id'))return {rowCount:options.models?.length??0,rows:options.models??[]};
  if(sql.startsWith('SELECT w.project_id'))return {rowCount:1,rows:[{project_id:'project'}]};
  if(sql.startsWith('SELECT a.id,a.result'))return {rowCount:options.unready?0:1,rows:options.unready?[]:[{id:'author',result:options.question??q}]};
  if(sql.startsWith('SELECT a.id,a.workflow_id,'))return {rowCount:options.stale?1:0,rows:options.stale?[{id:'stale',workflow_id:'workflow'}]:[]};
  if(sql.startsWith('SELECT ar.id,ar.kind'))return {rowCount:1,rows:[{id:'attachment',kind:'redacted_markdown',sha256:hash('脱敏'),storage_path:'source.md'}]};
  if(sql.startsWith('SELECT config'))return {rowCount:1,rows:[{config}]};
  if(sql.includes("input->>'model_set_digest' IS DISTINCT FROM"))return {rowCount:0,rows:[]};
  if(options.models?.length&&sql.startsWith('SELECT id FROM ai_distill.step_attempts')&&sql.includes("input->>'model_id' IS NOT DISTINCT FROM")){const prior=options.previousByModel?.[values[3] as string];return {rowCount:prior?1:0,rows:prior?[{id:prior}]:[]};}
  if(sql.startsWith('SELECT id FROM ai_distill.step_attempts')&&!sql.includes("status='running'"))return {rowCount:options.reuse?1:0,rows:options.reuse?[{id:'existing'}]:[]};
  if(sql.startsWith('SELECT a.*'))return {rowCount:options.empty?0:1,rows:options.empty?[]:[job]};
  if(sql.startsWith('SELECT id FROM ai_distill.step_attempts'))return {rowCount:options.inactive?0:1,rows:options.inactive?[]:[{id:'answer'}]};
  if(sql.startsWith('SELECT id FROM ai_distill.artifacts'))return {rowCount:options.published?1:0,rows:options.published?[{id:'saved'}]:[]};
  if(sql.startsWith('INSERT INTO ai_distill.artifacts')&&options.publishError)throw new Error('commit secret');
  if(sql.startsWith("UPDATE ai_distill.step_attempts SET status='failed'"))return {rowCount:options.inactive?0:1,rows:[]};
  return {rowCount:1,rows:[]};
 };
 return {pool:{query,connect:async()=>({query,release(){}})} as unknown as Pool,calls,job};
}
async function fixture(run:(root:string)=>Promise<void>){const root=await mkdtemp(join(tmpdir(),'answer-jobs-'));try{await writeFile(join(root,'source.md'),'脱敏');await run(root);}finally{await rm(root,{recursive:true,force:true});}}
const answer=async()=>({text:'答案',requested_model:'qwen/qwen-plus',model:'actual',request_id:null,completion_id:'c',usage:{total_tokens:8},started_at:'2026-10-08T00:00:00Z',finished_at:'2026-10-08T00:00:01Z',duration_ms:1000});
test('enqueue pins safe input and configuration, duplicate does not create attempt',async()=>fixture(async root=>{const a=fake();await enqueueAnswer(a.pool,'workflow',root);const inserted=a.calls.find(c=>c.sql.startsWith('INSERT INTO ai_distill.step_attempts'))!;expect(JSON.parse(inserted.values[2])).toMatchObject({question_attempt_id:'author',question_version:'v1',materials:[{name:'附件1',text:'脱敏'}]});expect(inserted.values.join(' ')).not.toContain('OPEN_ROUTER_KEY');const b=fake({reuse:true});expect(await enqueueAnswer(b.pool,'workflow',root)).toEqual({id:'existing',reused:true});expect(b.calls.some(c=>c.sql.startsWith('INSERT'))).toBe(false);}));
test('enqueue rejects changed file bytes and rolls back',async()=>fixture(async root=>{await writeFile(join(root,'source.md'),'原始私密');const {pool,calls}=fake();await expect(enqueueAnswer(pool,'workflow',root)).rejects.toThrow();expect(calls.some(c=>c.sql.startsWith('INSERT'))).toBe(false);expect(calls.at(-1)?.sql).toBe('ROLLBACK');}));
test('idle worker does not invoke provider',async()=>{const {pool}=fake({empty:true});let called=false;expect(await runNextAnswer(pool,'unused',async()=>{called=true;return answer();})).toBe(false);expect(called).toBe(false);});
test('worker persists exact answer and usage with immutable config',async()=>fixture(async root=>{const {pool,calls}=fake();await runNextAnswer(pool,root,answer);const saved=calls.find(c=>c.sql.startsWith('UPDATE ai_distill.steps SET status=$2'));expect(saved?.values[1]).toBe('succeeded');expect(JSON.parse(saved?.values[2])).toMatchObject({text:'答案',usage:{total_tokens:8},model:'actual'});}));
test.each([{inactive:true},{question:{...q,question_version:'v2'}}])('late answers cannot overwrite changed source',async options=>fixture(async root=>{const {pool,calls}=fake(options);await runNextAnswer(pool,root,answer);expect(calls.some(c=>c.sql.startsWith('UPDATE ai_distill.steps SET status=$2'))).toBe(false);expect(calls.some(c=>c.sql.startsWith('INSERT INTO ai_distill.artifacts'))).toBe(false);}));
test('provider errors are bounded and do not publish success',async()=>fixture(async root=>{const {pool,calls}=fake();await runNextAnswer(pool,root,async()=>{throw new Error('secret provider response');});expect(JSON.stringify(calls)).not.toContain('secret provider response');expect(calls.some(c=>c.values[1]==='succeeded')).toBe(false);}));
import {QwenError} from './qwen';
import {readAnswerAttachment} from './jobs';
import {symlink,readdir} from 'node:fs/promises';
test('symlinks outside storage cannot be submitted even with matching hash',async()=>fixture(async root=>{const outside=await mkdtemp(join(tmpdir(),'answer-outside-'));try{await writeFile(join(outside,'private.txt'),'私密');await symlink(join(outside,'private.txt'),join(root,'escape'));await expect(readAnswerAttachment(root,{storage_path:'escape',sha256:hash('私密')})).rejects.toThrow();}finally{await rm(outside,{recursive:true,force:true});}}));
test('publication rollback removes unpublished files and records failure',async()=>fixture(async root=>{const {pool,calls}=fake({publishError:true});await runNextAnswer(pool,root,answer);expect(calls.some(c=>c.sql==='ROLLBACK')).toBe(true);expect(calls.some(c=>c.sql.startsWith("UPDATE ai_distill.step_attempts SET status='failed'"))).toBe(true);expect(await readdir(join(root,'workflow'))).toEqual([]);}));
test('uncertain commit preserves files already referenced by artifact rows',async()=>fixture(async root=>{const {pool}=fake({publishError:true,published:true});await runNextAnswer(pool,root,answer);expect(await Bun.file(join(root,'workflow','answer','answer.txt')).text()).toBe('答案');}));
test('snapshot tampering prevents any provider request',async()=>fixture(async root=>{const {pool,job,calls}=fake();job.input.question='篡改';let requested=false;await runNextAnswer(pool,root,async()=>{requested=true;return answer();});expect(requested).toBe(false);expect(calls.some(c=>c.sql.startsWith('INSERT INTO ai_distill.artifacts'))).toBe(false);}));
test('provider failure retains structured retryability without raw response',async()=>fixture(async root=>{const {pool,calls}=fake();await runNextAnswer(pool,root,async()=>{throw new QwenError('rate_limit',true,429,'429');});const failure=calls.find(c=>c.sql.startsWith("UPDATE ai_distill.step_attempts SET status='failed'"));expect(JSON.parse(failure?.values[2])).toEqual({error:{kind:'rate_limit',retryable:true,http_status:429,provider_code:'429',request_id:null}});}));
test('unfinished authoring cannot create answer attempts',async()=>fixture(async root=>{const {pool,calls}=fake({unready:true});await expect(enqueueAnswer(pool,'workflow',root)).rejects.toThrow('质检');expect(calls.some(c=>c.sql.startsWith('INSERT'))).toBe(false);}));
test('interrupted attempts fail instead of claiming success after restart',async()=>{const {pool,calls}=fake({empty:true,stale:true});expect(await runNextAnswer(pool,'unused',answer)).toBe(false);expect(calls.some(c=>c.sql.includes("error='作答进程中断，可重试'"))).toBe(true);expect(calls.some(c=>c.values[1]==='succeeded')).toBe(false);});
test('worker uses frozen attempt config without querying project defaults',async()=>fixture(async root=>{const {pool,calls,job}=fake();job.config.model='qwen/frozen-model';await runNextAnswer(pool,root,async input=>{expect(input.config.model).toBe('qwen/frozen-model');return answer();});expect(calls.some(c=>c.sql.startsWith('SELECT config'))).toBe(false);}));
import {DomesticError} from './domestic';
test('native provider attempt uses immutable config and saves its identity',async()=>fixture(async root=>{
 const {pool,calls,job}=fake();job.config={provider:'deepseek',base_url:'https://api.deepseek.com',model:'explicit-model'} as any;
 await runNextAnswer(pool,root,async input=>{expect(input.config.provider).toBe('deepseek');return {...await answer(),requested_model:'explicit-model'};});
 const saved=calls.find(c=>c.sql.startsWith('UPDATE ai_distill.steps SET status=$2'));
 expect(JSON.parse(saved?.values[2])).toMatchObject({provider:'deepseek',mode:'provider_default',text:'答案'});
}));
test('native authentication failure preserves safe error and cannot publish success',async()=>fixture(async root=>{
 const {pool,calls}=fake();await runNextAnswer(pool,root,async()=>{throw new DomesticError('authentication',false,401);});
 const failure=calls.find(c=>c.sql.startsWith("UPDATE ai_distill.step_attempts SET status='failed'"));expect(JSON.parse(failure?.values[2]).error.kind).toBe('authentication');expect(calls.some(c=>c.values[1]==='succeeded')).toBe(false);
}));

test('project model set creates one isolated attempt per selected model with a shared frozen set',async()=>fixture(async root=>{
 const qwenRow={model_id:'11111111-1111-4111-8111-111111111111',name:'Qwen Plus',minimum_score:'8',config:{provider:'qwen',base_url:'https://openrouter.ai/api/v1',model:'qwen/qwen-plus'},enabled:true};
 const deepseekRow={model_id:'22222222-2222-4222-8222-222222222222',name:'DeepSeek',minimum_score:'7',config:{provider:'deepseek',base_url:'https://api.deepseek.com',model:'deepseek-chat'},enabled:true};
 const {pool,calls}=fake({models:[qwenRow,deepseekRow]});
 const result=await enqueueAnswer(pool,'workflow',root);
 const inserts=calls.filter(call=>call.sql.startsWith('INSERT INTO ai_distill.step_attempts'));
 expect(result.ids).toHaveLength(2);expect(inserts).toHaveLength(2);
 const first=JSON.parse(inserts[0]!.values[2]);const second=JSON.parse(inserts[1]!.values[2]);
 expect(first.model_id).toBe(qwenRow.model_id);expect(second.model_id).toBe(deepseekRow.model_id);
 expect(first.model_set_digest).toBe(second.model_set_digest);expect(first.model_set).toHaveLength(2);
 expect(inserts.map(call=>JSON.parse(call.values[3]).model)).toEqual(['qwen/qwen-plus','deepseek-chat']);
}));

test('answer retry reuses successful model attempts and queues only failed models',async()=>fixture(async root=>{
 const qwenRow={model_id:'11111111-1111-4111-8111-111111111111',name:'Qwen Plus',minimum_score:'8',config:{provider:'qwen',base_url:'https://openrouter.ai/api/v1',model:'qwen/qwen-plus'},enabled:true};
 const kimiRow={model_id:'22222222-2222-4222-8222-222222222222',name:'Kimi',minimum_score:'7',config:{provider:'kimi',base_url:'https://api.moonshot.ai/v1',model:'kimi-k2.6'},enabled:true};
 const {pool,calls}=fake({models:[qwenRow,kimiRow],previousByModel:{[qwenRow.model_id]:'qwen-succeeded'}});
 const result=await enqueueAnswer(pool,'workflow',root);
 const inserts=calls.filter(call=>call.sql.startsWith('INSERT INTO ai_distill.step_attempts'));
 expect(result.ids).toHaveLength(2);expect(result.reused).toBe(false);expect(inserts).toHaveLength(1);
 expect(inserts[0]?.values[3]).toContain('kimi-k2.6');
 expect(calls.some(call=>call.sql.startsWith('UPDATE ai_distill.steps SET implemented=true,status=\'waiting\'')&&call.values[0]==='workflow')).toBe(true);
}));

test('one model answer cannot mark the shared step complete while another required answer is pending',async()=>fixture(async root=>{
 const qwenRow={model_id:'11111111-1111-4111-8111-111111111111',name:'Qwen Plus',minimum_score:'8',config:{provider:'qwen',base_url:'https://openrouter.ai/api/v1',model:'qwen/qwen-plus'},enabled:true};
 const deepseekRow={model_id:'22222222-2222-4222-8222-222222222222',name:'DeepSeek',minimum_score:'7',config:{provider:'deepseek',base_url:'https://api.deepseek.com',model:'deepseek-chat'},enabled:true};
 const set=[{model_id:qwenRow.model_id,name:qwenRow.name,minimum_score:8,config:qwenRow.config},{model_id:deepseekRow.model_id,name:deepseekRow.name,minimum_score:7,config:deepseekRow.config}];
 const digest=createHash('sha256').update(JSON.stringify(set)).digest('hex');
 const {pool,calls,job}=fake({models:[qwenRow,deepseekRow],summary:[{id:'answer',input:{model_id:qwenRow.model_id},result:{answer_sha256:hash('答案')},status:'succeeded'},{id:'pending',input:{model_id:deepseekRow.model_id},result:null,status:'waiting'}]});
 (job as any).project_id='project';(job as any).input.model_id=qwenRow.model_id;(job as any).input.model_set=set;(job as any).input.model_set_digest=digest;
 await runNextAnswer(pool,root,answer);
 const update=calls.find(call=>call.sql.startsWith('UPDATE ai_distill.steps SET status=$2,result=$4'));
 expect(update?.values[2]).toBe('waiting');
 expect(JSON.parse(update?.values[3]).models.map((item:any)=>item.status)).toEqual(['succeeded','waiting']);
}));

test('answer enqueue invalidates scoring and publication while preserving independent redaction',async()=>fixture(async root=>{
 const {pool,calls}=fake();await enqueueAnswer(pool,'workflow',root);const invalidation=calls.find(c=>c.sql.includes("ordinal>5")&&c.sql.startsWith('UPDATE ai_distill.steps'))!;expect(invalidation.sql).toContain('ordinal<=8');
}));

test('legacy single-model enqueue does not claim membership in a project model set',async()=>fixture(async root=>{const {pool,calls}=fake();await enqueueAnswer(pool,'workflow',root);const input=JSON.parse(calls.find(c=>c.sql.startsWith('INSERT INTO ai_distill.step_attempts'))!.values[2]);expect(input.model_set).toBeUndefined();expect(input.model_set_digest).toBeUndefined();}));
