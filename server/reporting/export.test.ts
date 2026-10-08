import {test,expect} from 'bun:test';
import {collectProjectResults,buildProjectExport} from './export';
const q={id:'q1',workflow_id:'w1',ordinal:4,attempt:1,status:'succeeded',input:{},result:{question:'题面',question_version:'qv1',rubric_version:'rv1',quality_check:{passed:true}},config:{},input_revision:1,started_at:'2026-10-08T00:00:00Z',finished_at:'2026-10-08T00:00:01Z'};
const answer={id:'a1',workflow_id:'w1',ordinal:5,attempt:1,status:'succeeded',input:{},result:{text:'答案',model:'qwen-plus',question_attempt_id:'q1',question_version:'qv1',usage:{prompt_tokens:100,completion_tokens:20}},config:{provider:'qwen',model:'qwen-plus'},input_revision:1,started_at:'2026-10-08T00:00:00Z',finished_at:'2026-10-08T00:00:02Z'};
const score={id:'s1',workflow_id:'w1',ordinal:6,attempt:1,status:'succeeded',input:{context:{binding:{answer_attempt_id:'a1'}}},result:{report:{total:8,max_score:10,disputes:[],items:[{id:'r1',score:8,max_score:10,reason:'有依据'}]},validation:{valid:true}},config:{},input_revision:1,started_at:'2026-10-08T00:00:00Z',finished_at:'2026-10-08T00:00:03Z'};
test('collects current deliverables and historical API costs using effective prices',async()=>{
 const pool:any={query:async(sql:string)=>sql.includes('FROM ai_distill.projects')?{rows:[{id:'p1',name:'项目'}]}:sql.includes('FROM ai_distill.workflows')?{rows:[{id:'w1',source_key:'批次1',title:'问题1',input_revision:1}]}:sql.includes('FROM ai_distill.step_attempts')?{rows:[q,answer,score,{...q,id:'d1',ordinal:7,result:{decision:'accepted'}}]}:{rows:[{provider:'qwen',model:'qwen-plus',currency:'CNY',input_per_million:2,output_per_million:8,cached_input_per_million:null,cache_write_per_million:null,valid_from:new Date('2026-10-01'),valid_until:null,source:'price sheet'}]}};
 const result=await collectProjectResults(pool,'p1');expect(result.records[0]).toMatchObject({quality:'passed',accepted:true,answers:[{model:'qwen-plus',answer:'答案',total:8,score_valid:true}],api_costs:[{input_revision:1,amount:0.00036,currency:'CNY'}]});expect(result.usage_costs).toHaveLength(1);
});
test('Excel only includes independently published current accepted results',async()=>{
 let published=false;
 const accepted={...q,id:'d1',ordinal:7,input:{source_digest:'a'.repeat(64)},result:{decision:'accepted'}};
 const released={...q,id:'p1',ordinal:8,result:{acceptance_attempt_id:'d1',source_digest:'a'.repeat(64),question_version:'qv1',rubric_version:'rv1'}};
 const pool:any={query:async(sql:string)=>sql.includes('FROM ai_distill.projects')?{rows:[{id:'project',name:'项目'}]}:sql.includes('FROM ai_distill.workflows')?{rows:[{id:'w1',title:'题目',input_revision:1,publication_status:published?'succeeded':'waiting'}]}:sql.includes('FROM ai_distill.step_attempts')?{rows:[q,answer,score,accepted,...(published?[released]:[])]}:{rows:[]}};
 expect((await buildProjectExport(pool,'project')).records).toHaveLength(0);
 published=true;expect((await buildProjectExport(pool,'project')).records).toHaveLength(1);
 released.result.rubric_version='old';expect((await buildProjectExport(pool,'project')).records).toHaveLength(0);
});

test('export keeps inherited answers and actual revision history without placeholder rows',async()=>{
 const revised={...q,id:'q2',attempt:2,result:{...q.result,answer_source_attempt_ids:['q1']}};
 const round={workflow_id:'w1',input_revision:1,round:1,issue_kind:'rubric',status:'succeeded',chain_status:'accepted',decision:{reason:'content_issue:rubric',return_step:4,content_revisions:1,technical_retries:0},before_scores:{m:{score:3}},after_scores:{m:{score:8}},spent_duration_ms:'200',calls_reserved:3};
 const pool:any={query:async(sql:string)=>sql.includes('FROM ai_distill.projects')?{rows:[{id:'project',name:'项目'}]}:sql.includes('FROM ai_distill.workflows')?{rows:[{id:'w1',input_revision:1}]}:sql.includes('FROM ai_distill.step_attempts')?{rows:[q,revised,answer,score]}:sql.includes('FROM ai_distill.revision_rounds')?{rows:[round]}:{rows:[]}};
 const record=(await collectProjectResults(pool,'project')).records[0]!;
 expect(record.answers).toHaveLength(1);expect(record.revisions[0]).toMatchObject({kind:'rubric',content_revision:1,duration_ms:200,calls:3});
 expect(record.revisions[0]?.summary).toContain('before_scores');
 round.input_revision=2;expect((await collectProjectResults(pool,'project')).records[0]?.revisions).toHaveLength(0);
});
