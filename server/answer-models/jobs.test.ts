/** 验证作答队列的输入冻结、供应商调用、结果落盘、过期隔离与取消处理。
 * 运行方式：由 Bun test 收集本文件用例；修改对应模块时针对该文件回归验证。
 */
import {test,expect} from 'bun:test';
import type {Pool} from 'pg';
import {enqueueAnswer,runNextAnswer} from './jobs';
import {inputDigest,buildAnswerInput} from './input';
import {answerModelSetDigest} from './model-set';
import {createHash} from 'node:crypto';
import {mkdtemp,writeFile,mkdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
const q={question_version:'v1',question:'题面',attachment_ids:['attachment'],quality_check:{passed:true},answer_requirements:{input_mode:'text',output_mode:'text',tools:[]}};
const config={provider:'qwen',base_url:'https://openrouter.ai/api/v1',model:'qwen/qwen-plus'};
function fake(options:{reuse?:boolean;previousByModel?:Record<string,string>;question?:unknown;content?:string;inactive?:boolean;empty?:boolean;publishError?:boolean;published?:boolean;stale?:boolean;staleInput?:any;unready?:boolean;models?:any[];summary?:any[];projectConfig?:Record<string,unknown>;localSkill?:string}={}){
 const calls:{sql:string;values:any[]}[]=[],hookRuns=new Map<string,any>();
 const input={question_attempt_id:'author',question_version:'v1',question:'题面',materials:[{name:'附件1',text:'脱敏'}],attachments:[{id:'attachment',sha256:hash('脱敏')}],input_digest:''};
 input.input_digest=inputDigest({question_version:input.question_version,question:input.question,materials:input.materials,attachments:input.attachments});
 const job:any={id:'answer',workflow_id:'workflow',input,config};
 const query=async(sql:string,values:any[]=[])=>{
  calls.push({sql,values});
  if(sql.startsWith('SELECT * FROM ai_distill.hook_runs')){const row=[...hookRuns.values()].find(r=>r.attempt_id===values[0]&&r.position===values[1]&&r.action_id===values[2]);return {rows:row?[structuredClone(row)]:[],rowCount:row?1:0};}
  if(sql.startsWith('INSERT INTO ai_distill.hook_runs')){const row={id:values[0],workflow_id:values[1],attempt_id:values[2],stage:values[3],position:values[4],action_id:values[5],mode:values[6],binding_digest:values[7],snapshot:JSON.parse(values[8]),idempotent:values[9],status:'waiting'};hookRuns.set(row.id,row);return {rows:[structuredClone(row)],rowCount:1};}
  if(sql.startsWith('UPDATE ai_distill.hook_runs')){const row=hookRuns.get(values[0]);if(!row)return {rows:[],rowCount:0};row.status=values[1];row.result=values[2]?JSON.parse(values[2]):null;row.result_digest=values[4];return {rows:[structuredClone(row)],rowCount:1};}

  if(sql.startsWith('SELECT id,input,result,status FROM (SELECT DISTINCT ON')){expect(sql).toContain("ORDER BY input->>'model_id',attempt DESC");expect(sql).toContain("input->>'input_digest'=$4");expect(sql).toContain("'text',result->'text'");}
  if(sql.startsWith('SELECT id,input,result,status FROM (SELECT DISTINCT ON'))return {rowCount:options.summary?.length??0,rows:options.summary??[]};
  if(sql.startsWith('SELECT s.model_id'))return {rowCount:options.models?.length??0,rows:options.models??[]};
  if(sql.startsWith('SELECT w.project_id'))return {rowCount:1,rows:[{project_id:'project',local_skill_path:options.localSkill}]};
  if(sql.startsWith('SELECT a.id,a.result'))return {rowCount:options.unready?0:1,rows:options.unready?[]:[{id:'author',result:options.question??q}]};
  if(sql.startsWith('SELECT a.id,a.workflow_id,'))return {rowCount:options.stale?1:0,rows:options.stale?[{id:'stale',workflow_id:'workflow',input:options.staleInput??input,config}]:[]};
  if(sql.startsWith('SELECT ar.id,ar.kind'))return {rowCount:1,rows:[{id:'attachment',kind:'redacted_markdown',sha256:hash('脱敏'),content:options.content??'脱敏',storage_path:'source.md'}]};
  if(sql.startsWith('SELECT config'))return {rowCount:1,rows:[{config:options.projectConfig??config}]};
  if(sql.includes("input->>'model_set_digest' IS DISTINCT FROM"))return {rowCount:0,rows:[]};
  if(options.models?.length&&sql.startsWith('SELECT id FROM ai_distill.step_attempts')&&sql.includes("input->>'model_id' IS NOT DISTINCT FROM")){const prior=options.previousByModel?.[values[3] as string];return {rowCount:prior?1:0,rows:prior?[{id:prior}]:[]};}
  if(sql.startsWith('SELECT id FROM ai_distill.step_attempts')&&!sql.includes("status='running'"))return {rowCount:options.reuse?1:0,rows:options.reuse?[{id:'existing'}]:[]};
  if(sql.startsWith('SELECT a.*'))return {rowCount:options.empty?0:1,rows:options.empty?[]:[job]};
  if(sql.startsWith('SELECT id FROM ai_distill.step_attempts'))return {rowCount:options.inactive?0:1,rows:options.inactive?[]:[{id:'answer'}]};
  if(sql.startsWith('SELECT id FROM ai_distill.artifacts'))return {rowCount:options.published?1:0,rows:options.published?[{id:'saved'}]:[]};
  if(sql.startsWith('INSERT INTO ai_distill.artifacts')&&options.publishError)throw new Error('commit secret');
  if(sql.startsWith("UPDATE ai_distill.step_attempts SET status='failed'"))return {rowCount:options.inactive?0:1,rows:[]};
  if(sql.startsWith('UPDATE ai_distill.step_attempts SET status=$4')&&values[3]==='failed')return {rowCount:options.inactive?0:1,rows:[]};
  return {rowCount:1,rows:[]};
 };
 return {pool:{query,connect:async()=>({query,release(){}})} as unknown as Pool,calls,job,hookRuns};
}
async function fixture(run:(root:string)=>Promise<void>){const root=await mkdtemp(join(tmpdir(),'answer-jobs-'));try{await writeFile(join(root,'source.md'),'脱敏');await run(root);}finally{await rm(root,{recursive:true,force:true});}}
const answer=async()=>({text:'答案',requested_model:'qwen/qwen-plus',model:'actual',request_id:null,completion_id:'c',usage:{total_tokens:8},started_at:'2026-10-08T00:00:00Z',finished_at:'2026-10-08T00:00:01Z',duration_ms:1000});
test('作答领取及中断恢复都按 worker 主机筛选脚本任务',async()=>{
 const f=fake({empty:true});await runNextAnswer(f.pool,'unused',answer,undefined,'api');
 for(const call of f.calls.filter(c=>c.sql.startsWith('SELECT a.*')||c.sql.startsWith('SELECT a.id,a.workflow_id,')))expect(call.sql).toContain("NOT (a.input->'hooks'");
 const local=fake({empty:true});await runNextAnswer(local.pool,'unused',answer,undefined,'local');
 expect(local.calls.find(c=>c.sql.startsWith('SELECT a.*'))?.sql).toContain("AND (a.input->'hooks'");
});
test('API 与 Codex Agent 作答 worker 按冻结 provider 分流领取和中断恢复',async()=>{
 const codex=fake({empty:true});await runNextAnswer(codex.pool,'unused',answer,undefined,'all','local','codex');
 for(const call of codex.calls.filter(c=>c.sql.startsWith('SELECT a.*')||c.sql.startsWith('SELECT a.id,a.workflow_id,')))expect(call.sql).toContain("a.config->>'provider'='codex'");
 const api=fake({empty:true});await runNextAnswer(api.pool,'unused',answer,undefined,'all','local','api');
 for(const call of api.calls.filter(c=>c.sql.startsWith('SELECT a.*')||c.sql.startsWith('SELECT a.id,a.workflow_id,')))expect(call.sql).toContain("COALESCE(a.config->>'provider','qwen')<>'codex'");
});
test('enqueue pins safe input and configuration, duplicate does not create attempt',async()=>fixture(async root=>{const a=fake();await enqueueAnswer(a.pool,'workflow',root);const inserted=a.calls.find(c=>c.sql.startsWith('INSERT INTO ai_distill.step_attempts'))!;expect(JSON.parse(inserted.values[2])).toMatchObject({question_attempt_id:'author',question_version:'v1',materials:[{name:'附件1',text:'脱敏'}]});expect(inserted.values.join(' ')).not.toContain('OPEN_ROUTER_KEY');const b=fake({reuse:true});expect(await enqueueAnswer(b.pool,'workflow',root)).toEqual({id:'existing',reused:true});expect(b.calls.some(c=>c.sql.startsWith('INSERT'))).toBe(false);}));
test('enqueue rejects changed database text and rolls back',async()=>fixture(async root=>{const {pool,calls}=fake({content:'原始私密'});await expect(enqueueAnswer(pool,'workflow',root)).rejects.toThrow('指纹不一致');expect(calls.some(c=>c.sql.startsWith('INSERT'))).toBe(false);expect(calls.at(-1)?.sql).toBe('ROLLBACK');}));
test('enqueue freezes timeout settings but disables unverified automatic score skipping',async()=>fixture(async root=>{
 const policy={request_timeout_ms:5_400_000,reasoning_threshold_ms:2_700_000,skip_scoring_on_qualified_timeout:true};
 const {pool,calls}=fake({projectConfig:{...config,answer_generation_policy:policy}});
 await enqueueAnswer(pool,'workflow',root);
 const inserted=calls.find(c=>c.sql.startsWith('INSERT INTO ai_distill.step_attempts'))!;
 expect(JSON.parse(inserted.values[2]).answer_generation_policy).toEqual({...policy,skip_scoring_on_qualified_timeout:false});
 expect(JSON.parse(inserted.values[3])).toEqual(config);
}));
test('enqueue uses the database redacted text rather than a local file copy',async()=>fixture(async root=>{await writeFile(join(root,'source.md'),'本地文件不作为脱敏正文来源');const {pool,calls}=fake();await enqueueAnswer(pool,'workflow',root);const inserted=calls.find(c=>c.sql.startsWith('INSERT INTO ai_distill.step_attempts'));expect(JSON.parse(inserted!.values[2]).materials).toEqual([{name:'附件1',text:'脱敏'}]);}));
test('idle worker does not invoke provider',async()=>{const {pool}=fake({empty:true});let called=false;expect(await runNextAnswer(pool,'unused',async()=>{called=true;return answer();})).toBe(false);expect(called).toBe(false);});
test('worker persists exact answer and usage with immutable config',async()=>fixture(async root=>{const {pool,calls}=fake();await runNextAnswer(pool,root,answer);const saved=calls.find(c=>c.sql.startsWith('UPDATE ai_distill.steps SET status=$2'));expect(saved?.values[1]).toBe('succeeded');expect(JSON.parse(saved?.values[2])).toMatchObject({text:'答案',usage:{total_tokens:8},model:'actual'});}));
test.each([{inactive:true},{question:{...q,question_version:'v2'}}])('late answers cannot overwrite changed source',async options=>fixture(async root=>{const {pool,calls}=fake(options);await runNextAnswer(pool,root,answer);expect(calls.some(c=>c.sql.startsWith('UPDATE ai_distill.steps SET status=$2'))).toBe(false);expect(calls.some(c=>c.sql.startsWith('INSERT INTO ai_distill.artifacts'))).toBe(false);}));
test('provider errors are bounded and do not publish success',async()=>fixture(async root=>{const {pool,calls}=fake();await runNextAnswer(pool,root,async()=>{throw new Error('secret provider response');});expect(JSON.stringify(calls)).not.toContain('secret provider response');expect(calls.some(c=>c.values[1]==='succeeded')).toBe(false);}));
import {QwenError} from './qwen';
import {readAnswerAttachment} from './jobs';
import {readdir} from 'node:fs/promises';
test('attachment text must come from the database rather than a storage path',async()=>fixture(async root=>{await expect(readAnswerAttachment(root,{storage_path:'source.md',sha256:hash('脱敏')})).rejects.toThrow('数据库中没有脱敏附件正文');expect(await readAnswerAttachment(root,{storage_path:'/not-an-input',sha256:hash('脱敏'),content:'脱敏'})).toBe('脱敏');}));
test('publication rollback removes unpublished files and records failure',async()=>fixture(async root=>{const {pool,calls}=fake({publishError:true});await runNextAnswer(pool,root,answer);expect(calls.some(c=>c.sql==='ROLLBACK')).toBe(true);expect(calls.some(c=>c.sql.startsWith('UPDATE ai_distill.step_attempts SET status=$4')&&c.values[3]==='failed')).toBe(true);expect(await readdir(join(root,'workflow'))).toEqual([]);}));
test('uncertain commit preserves files already referenced by artifact rows',async()=>fixture(async root=>{const {pool}=fake({publishError:true,published:true});await runNextAnswer(pool,root,answer);expect(await Bun.file(join(root,'workflow','answer','answer.txt')).text()).toBe('答案');}));
test('snapshot tampering prevents any provider request',async()=>fixture(async root=>{const {pool,job,calls}=fake();job.input.question='篡改';let requested=false;await runNextAnswer(pool,root,async()=>{requested=true;return answer();});expect(requested).toBe(false);expect(calls.some(c=>c.sql.startsWith('INSERT INTO ai_distill.artifacts'))).toBe(false);}));
test('provider failure retains structured retryability without raw response',async()=>fixture(async root=>{const {pool,calls}=fake();await runNextAnswer(pool,root,async()=>{throw new QwenError('rate_limit',true,429,'429');});const failure=calls.find(c=>c.sql.startsWith('UPDATE ai_distill.step_attempts SET status=$4')&&c.values[3]==='failed');expect(JSON.parse(failure?.values[2])).toEqual({error:{kind:'rate_limit',retryable:true,http_status:429,provider_code:'429',request_id:null,generation_id:null,reason_code:null}});}));
test('unfinished authoring cannot create answer attempts',async()=>fixture(async root=>{const {pool,calls}=fake({unready:true});await expect(enqueueAnswer(pool,'workflow',root)).rejects.toThrow('尚未出题成功');expect(calls.some(c=>c.sql.startsWith('INSERT'))).toBe(false);}));
test('interrupted attempts fail instead of claiming success after restart',async()=>{const {pool,calls}=fake({empty:true,stale:true});expect(await runNextAnswer(pool,'unused',answer)).toBe(false);expect(calls.some(c=>c.sql.includes("error='作答进程中断，可重试'"))).toBe(true);expect(calls.some(c=>c.values[1]==='succeeded')).toBe(false);});
test('interrupted model attempts refresh the current answer summary',async()=>{
 const models=[
  {model_id:'11111111-1111-4111-8111-111111111111',name:'模型一',minimum_score:50,enabled:true,config:{provider:'qwen',base_url:'https://openrouter.ai/api/v1',model:'qwen/model-1'}},
  {model_id:'22222222-2222-4222-8222-222222222222',name:'模型二',minimum_score:50,enabled:true,config:{provider:'qwen',base_url:'https://openrouter.ai/api/v1',model:'qwen/model-2'}},
 ];
 const summary=[{id:'answer-success',input:{model_id:models[0]!.model_id},result:{text:'答案',answer_sha256:hash('答案')},status:'succeeded'},{id:'stale',input:{model_id:models[1]!.model_id},result:{},status:'failed'}];
 const digest=answerModelSetDigest(models as any);
 const staleInput={question_attempt_id:'author',question_version:'v1',question:'题面',materials:[{name:'附件1',text:'脱敏'}],attachments:[{id:'attachment',sha256:hash('脱敏')}],input_digest:inputDigest({question_version:'v1',question:'题面',materials:[{name:'附件1',text:'脱敏'}],attachments:[{id:'attachment',sha256:hash('脱敏')}] }),model_set_digest:digest,model_set:models};
 const {pool,calls}=fake({empty:true,stale:true,staleInput,models,summary});
 expect(await runNextAnswer(pool,'unused',answer)).toBe(false);
 expect(calls.some(c=>c.sql.startsWith('SELECT id,input,result,status FROM (SELECT DISTINCT ON'))).toBe(true);
 const update=calls.find(c=>c.sql.startsWith('UPDATE ai_distill.steps SET status=$2,result=$3'));
 expect(update?.values[1]).toBe('failed');
 expect(JSON.parse(update?.values[2]??'{}').models).toMatchObject([{model_id:models[0]!.model_id,status:'succeeded',answer:'答案'},{model_id:models[1]!.model_id,status:'failed'}]);
});
test('interrupted recovery preserves another model that is still running',async()=>{
 const models=[
  {model_id:'11111111-1111-4111-8111-111111111111',name:'模型一',minimum_score:50,enabled:true,config:{provider:'qwen',base_url:'https://openrouter.ai/api/v1',model:'qwen/model-1'}},
  {model_id:'22222222-2222-4222-8222-222222222222',name:'模型二',minimum_score:50,enabled:true,config:{provider:'qwen',base_url:'https://openrouter.ai/api/v1',model:'qwen/model-2'}},
  {model_id:'33333333-3333-4333-8333-333333333333',name:'模型三',minimum_score:50,enabled:true,config:{provider:'qwen',base_url:'https://openrouter.ai/api/v1',model:'qwen/model-3'}},
 ];
 const summary=[
  {id:'answer-success',input:{model_id:models[0]!.model_id},result:{text:'答案',answer_sha256:hash('答案')},status:'succeeded'},
  {id:'stale',input:{model_id:models[1]!.model_id},result:{},status:'failed'},
  {id:'answer-running',input:{model_id:models[2]!.model_id},result:{},status:'running'},
 ];
 const digest=answerModelSetDigest(models as any);
 const staleInput={question_attempt_id:'author',question_version:'v1',question:'题面',materials:[{name:'附件1',text:'脱敏'}],attachments:[{id:'attachment',sha256:hash('脱敏')}],input_digest:inputDigest({question_version:'v1',question:'题面',materials:[{name:'附件1',text:'脱敏'}],attachments:[{id:'attachment',sha256:hash('脱敏')}]}),model_set_digest:digest,model_set:models};
 const {pool,calls}=fake({empty:true,stale:true,staleInput,models,summary});
 expect(await runNextAnswer(pool,'unused',answer)).toBe(false);
 const update=calls.find(c=>c.sql.startsWith('UPDATE ai_distill.steps SET status=$2,result=$3'));
 expect(update?.values[1]).toBe('running');
 const recovered=JSON.parse(update?.values[2]??'{}').models;
 expect(recovered.map((model:any)=>[model.model_id,model.status])).toEqual([[models[0]!.model_id,'succeeded'],[models[1]!.model_id,'failed'],[models[2]!.model_id,'running']]);
 expect(recovered[2].attempt_id).toBe('answer-running');
});
test('interrupted attempts from an older question cannot replace the current summary',async()=>{
 const {pool,calls}=fake({empty:true,stale:true,question:{...q,question_version:'v2'}});
 expect(await runNextAnswer(pool,'unused',answer)).toBe(false);
 expect(calls.some(c=>c.sql.startsWith('UPDATE ai_distill.step_attempts SET status=\'failed\''))).toBe(true);
 expect(calls.some(c=>c.sql.startsWith('UPDATE ai_distill.steps SET status=$2,result=$3'))).toBe(false);
});
test('worker uses frozen attempt config without querying project defaults',async()=>fixture(async root=>{const {pool,calls,job}=fake();job.config.model='qwen/frozen-model';let dispatchedModel:string|undefined;await runNextAnswer(pool,root,async input=>{dispatchedModel=input.config.model;return answer();});expect(dispatchedModel).toBe('qwen/frozen-model');expect(calls.some(c=>c.sql.startsWith('SELECT config'))).toBe(false);}));
test('worker preserves frozen timeout and does not enable reasoning observation before provider timing validation',async()=>fixture(async root=>{
 const {pool,job}=fake();job.input.answer_generation_policy={request_timeout_ms:5_400_000,reasoning_threshold_ms:2_700_000,skip_scoring_on_qualified_timeout:true};
 let dispatched:Parameters<NonNullable<Parameters<typeof runNextAnswer>[2]>>[0]|undefined;
 await runNextAnswer(pool,root,async input=>{dispatched=input;return answer();});
 expect(dispatched?.timeout_ms).toBe(5_400_000);expect(dispatched?.observe_reasoning).toBeUndefined();
}));
test('unverified reasoning stream timeout remains a technical failure and creates no fake answer artifact',async()=>fixture(async root=>{
 const {pool,calls,job}=fake();job.input.answer_generation_policy={request_timeout_ms:5_400_000,reasoning_threshold_ms:2_700_000,skip_scoring_on_qualified_timeout:true};
 const evidence={source:'dashscope_reasoning_content' as const,first_event_at:'2026-10-11T00:00:00.000Z',last_event_at:'2026-10-11T00:46:00.000Z',span_ms:2_760_000,max_gap_ms:15_000,event_count:4};
 await runNextAnswer(pool,root,async()=>{throw new QwenError('timeout',true,null,null,'provider-request', 'local_deadline',evidence,'gen-example123');});
 const saved=calls.find(c=>c.sql.startsWith('UPDATE ai_distill.step_attempts SET status=$4')&&c.values[3]==='failed');
 expect(saved).toBeTruthy();expect(JSON.parse(saved!.values[2])).toMatchObject({error:{kind:'timeout',reason_code:'local_deadline',request_id:'provider-request',generation_id:'gen-example123'}});
 expect(calls.some(c=>c.sql.startsWith('INSERT INTO ai_distill.artifacts'))).toBe(false);
}));
import {DomesticError} from './domestic';
test('native provider attempt uses immutable config and saves its identity',async()=>fixture(async root=>{
 const {pool,calls,job}=fake();job.config={provider:'deepseek',base_url:'https://api.deepseek.com',model:'explicit-model'} as any;
 await runNextAnswer(pool,root,async input=>{expect(input.config.provider).toBe('deepseek');return {...await answer(),requested_model:'explicit-model'};});
 const saved=calls.find(c=>c.sql.startsWith('UPDATE ai_distill.steps SET status=$2'));
 expect(JSON.parse(saved?.values[2])).toMatchObject({provider:'deepseek',mode:'provider_default',text:'答案'});
}));
test('native authentication failure preserves safe error and cannot publish success',async()=>fixture(async root=>{
 const {pool,calls}=fake();await runNextAnswer(pool,root,async()=>{throw new DomesticError('authentication',false,401);});
 const failure=calls.find(c=>c.sql.startsWith('UPDATE ai_distill.step_attempts SET status=$4')&&c.values[3]==='failed');expect(JSON.parse(failure?.values[2]).error.kind).toBe('authentication');expect(calls.some(c=>c.values[1]==='succeeded')).toBe(false);
}));

test('project model set creates one isolated attempt per selected model with a shared frozen set',async()=>fixture(async root=>{
 const qwenRow={model_id:'11111111-1111-4111-8111-111111111111',name:'Qwen Plus',minimum_score:'8',config:{provider:'qwen' as const,base_url:'https://openrouter.ai/api/v1',model:'qwen/qwen-plus'},enabled:true};
 const deepseekRow={model_id:'22222222-2222-4222-8222-222222222222',name:'DeepSeek',minimum_score:'7',config:{provider:'deepseek' as const,base_url:'https://api.deepseek.com',model:'deepseek-chat'},enabled:true};
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
 const qwenRow={model_id:'11111111-1111-4111-8111-111111111111',name:'Qwen Plus',minimum_score:'8',config:{provider:'qwen' as const,base_url:'https://openrouter.ai/api/v1',model:'qwen/qwen-plus'},enabled:true};
 const kimiRow={model_id:'22222222-2222-4222-8222-222222222222',name:'Kimi',minimum_score:'7',config:{provider:'kimi',base_url:'https://api.moonshot.ai/v1',model:'kimi-k2.6'},enabled:true};
 const {pool,calls}=fake({models:[qwenRow,kimiRow],previousByModel:{[qwenRow.model_id]:'qwen-succeeded'}});
 const result=await enqueueAnswer(pool,'workflow',root);
 const inserts=calls.filter(call=>call.sql.startsWith('INSERT INTO ai_distill.step_attempts'));
 expect(result.ids).toHaveLength(2);expect(result.reused).toBe(false);expect(inserts).toHaveLength(1);
 expect(inserts[0]?.values[3]).toContain('kimi-k2.6');
 expect(calls.some(call=>call.sql.startsWith('UPDATE ai_distill.steps SET implemented=true,status=\'waiting\'')&&call.values[0]==='workflow')).toBe(true);
}));

test('one model answer cannot mark the shared step complete while another required answer is pending',async()=>fixture(async root=>{
 const qwenRow={model_id:'11111111-1111-4111-8111-111111111111',name:'Qwen Plus',minimum_score:'8',config:{provider:'qwen' as const,base_url:'https://openrouter.ai/api/v1',model:'qwen/qwen-plus'},enabled:true};
 const deepseekRow={model_id:'22222222-2222-4222-8222-222222222222',name:'DeepSeek',minimum_score:'7',config:{provider:'deepseek' as const,base_url:'https://api.deepseek.com',model:'deepseek-chat'},enabled:true};
 const set=[{model_id:qwenRow.model_id,name:qwenRow.name,minimum_score:8,config:qwenRow.config},{model_id:deepseekRow.model_id,name:deepseekRow.name,minimum_score:7,config:deepseekRow.config}];
 const digest=answerModelSetDigest(set);
 const {pool,calls,job}=fake({models:[qwenRow,deepseekRow],summary:[{id:'answer',input:{model_id:qwenRow.model_id},result:{answer_sha256:hash('答案')},status:'succeeded'},{id:'pending',input:{model_id:deepseekRow.model_id},result:null,status:'waiting'}]});
 (job as any).project_id='project';(job as any).input.model_id=qwenRow.model_id;(job as any).input.model_set=set;(job as any).input.model_set_digest=digest;
 await runNextAnswer(pool,root,answer);
 const update=calls.find(call=>call.sql.startsWith('UPDATE ai_distill.steps SET status=$2,result=$3'));
 expect(update?.values[1]).toBe('waiting');
 expect(JSON.parse(update?.values[2]).models.map((item:any)=>item.status)).toEqual(['succeeded','waiting']);
}));

test('answer enqueue invalidates scoring and publication while preserving independent redaction',async()=>fixture(async root=>{
 const {pool,calls}=fake();await enqueueAnswer(pool,'workflow',root);const invalidation=calls.find(c=>c.sql.includes("ordinal>5")&&c.sql.startsWith('UPDATE ai_distill.steps'))!;expect(invalidation.sql).toContain('ordinal<=8');
}));

test('legacy single-model enqueue does not claim membership in a project model set',async()=>fixture(async root=>{const {pool,calls}=fake();await enqueueAnswer(pool,'workflow',root);const input=JSON.parse(calls.find(c=>c.sql.startsWith('INSERT INTO ai_distill.step_attempts'))!.values[2]);expect(input.model_set).toBeUndefined();expect(input.model_set_digest).toBeUndefined();}));

test('作答阶段冻结并运行前后钩子，模型只接收原题面和脱敏附件',async()=>fixture(async root=>{
 await mkdir(join(root,'hooks'));await writeFile(join(root,'hooks/check.ts'),"const p=JSON.parse(await Bun.stdin.text());console.log(JSON.stringify({data:{phase:p.position,question:p.input.question,private_fields:('rubric' in p.input)||('reference_answer' in p.input)}}));");
 const action={id:'check',script:'hooks/check.ts',files:['hooks/check.ts'],idempotent:true};
 const f=fake({localSkill:join(root,'skill'),projectConfig:{...config,workflow:{hooks:{before:[action],after:[action]}}}});
 await enqueueAnswer(f.pool,'workflow',root);
 const inserted=f.calls.find(c=>c.sql.startsWith('INSERT INTO ai_distill.step_attempts'))!;
 const frozen=JSON.parse(inserted.values[2]);expect(frozen.hooks.before[0].files[0].sha256).toHaveLength(64);
 expect(JSON.parse(inserted.values[3])).not.toHaveProperty('workflow');
 f.job.input=frozen;f.job.config=JSON.parse(inserted.values[3]);let called=0;
 await runNextAnswer(f.pool,root,async request=>{called++;expect(request.question).toBe('题面');expect(request.materials).toEqual([{name:'附件1',text:'脱敏'}]);expect(request).not.toHaveProperty('hooks');return answer();});
 expect(called).toBe(1);
 expect([...f.hookRuns.values()].filter(r=>r.position!=='main').map(r=>r.result?.data)).toEqual([{phase:'before',question:'题面',private_fields:false},{phase:'after',question:'题面',private_fields:false}]);
 const saved=f.calls.find(c=>c.sql.startsWith("UPDATE ai_distill.step_attempts SET status='succeeded'"));expect(JSON.parse(saved!.values[1]).text).toBe('答案');
}));

test('成果清单从当前题目进入实际队列快照，不泄露标答',async()=>fixture(async root=>{
 const question={...q,content_contract:'work_legal_v1',content_status:{status:'complete'},task_requirements:{input_mode:'text',output_mode:'file',tools:['计算']},deliverables:[{id:'D1',path:'意见.md',description:'法律意见',required:true}],reference_answer:'禁止泄露标答'};
 const {pool,calls}=fake({question});await enqueueAnswer(pool,'workflow',root);
 const inserted=calls.find(c=>c.sql.startsWith('INSERT INTO ai_distill.step_attempts'))!;
 const serialized=inserted.values.find(v=>typeof v==='string'&&v.includes('question_attempt_id'));
 const input=JSON.parse(serialized);expect(input.presentation?.deliverables[0].name).toBe('意见.md');expect(serialized).not.toContain('禁止泄露标答');
}));
test('实际供应商调用收到文字成果指令，且原题面保持绑定',async()=>fixture(async root=>{
 const question={...q,deliverables:[{id:'D1',path:'意见.md',description:'完整意见',required:true}]};
 const {pool,job}=fake({question});const input=buildAnswerInput(question,[{id:'attachment',kind:'redacted_markdown',sha256:hash('脱敏'),text:'脱敏'}]);
 job.input={...input,question_attempt_id:'author',input_digest:inputDigest(input)};
 let called=false;await runNextAnswer(pool,root,async req=>{called=true;expect(req.question).toContain('意见.md');expect(req.question).toContain('不代表实际创建文件');return answer();});expect(called).toBe(true);
}));
