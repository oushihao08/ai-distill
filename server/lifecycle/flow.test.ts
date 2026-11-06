/** 完整迁移边界验收：固定输入对比迁移前快照，串联出题→作答输入→评分协议；材料/达标/交付使用隔离策略，不调用外部服务。 */
import {test,expect} from 'bun:test';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {captureFlowBaseline,sampleDraft} from './flow.fixture';
import {projectStepPolicies,resolveStepProjectKey} from './steps';
import {answerCapabilityIssue,authoringQuestion,buildAnswerInput} from '../answer-models/input';
import {workflowStepReadiness} from '../project-folders';
import {singleQuestionPerPackage} from '../material-library/questions';
import {validateDraft} from '../authoring/receive';
import {SyncProjectImplementations} from './project-registry';
import {lifecycle,emitProjectLifecycle} from './index';
import type {ScoreContext} from '../scoring/validate';

test('四组固定输入保留迁移基线，仅豆包阅读稿使用普通考点编号',async()=>{
 const baseline=JSON.parse(await readFile(new URL('./fixtures/flow-baseline.json',import.meta.url),'utf8'));
 // 保留原始基线文件；本次授权只改变这两处阅读稿标签，其余字段仍逐项对比。
 const doubao=baseline['豆包高经济价值'];
 const oldRubric='考点rubric\nr（1分）\n核清金额',newRubric='考点rubric\n1、核清金额';
 doubao.result.package_text=doubao.result.package_text.replace(oldRubric,newRubric);
 doubao.private_package=doubao.private_package.replace(oldRubric,newRubric);
 expect(await captureFlowBaseline()).toEqual(baseline);
});
test('项目覆盖不污染后续默认计划或输入配置，每次返回独立配置对象',()=>{
 const base=Object.freeze({type:'object',properties:Object.freeze({})});
 const options=Object.freeze({materials:[],scoring_policy:{contract:'model_report_v1'}}) as any;
 const input={options,base};
 const original=projectStepPolicies.authoringPlan.execute(null,input);
 const work=projectStepPolicies.authoringPlan.execute('Work法律全场景',input);
 expect(work.validation_options.requireHarborMetadata).toBe(true);
 expect(work.prompt_suffix).toContain('Work 出题元数据');
 work.validation_options.requireHarborMetadata=false;
 work.delivery_fields.changed=true;
 const next=projectStepPolicies.authoringPlan.execute('未知项目',input);
 expect(next).toEqual(original);
 expect(next).not.toBe(original);
 expect(next.validation_options).not.toBe(original.validation_options);
 expect(next.delivery_fields).not.toBe(original.delivery_fields);
 expect(next.schema).toBe(base);
 expect(options).not.toHaveProperty('content_contract');
});
test('项目身份解析兼容主项目名、期次、旧目录及冻结契约，不改显式key',()=>{
 for(const identity of [{parent_name:'Work法律全场景'},{project_name:'Work法律全场景 - 一期'},{workspace_path:'/tmp/Work法律全场景'},{content_contract:'work_legal_v1'}])expect(resolveStepProjectKey(identity)).toBe('Work法律全场景');
 expect(resolveStepProjectKey({project_key:'其他项目',content_contract:'work_legal_v1'})).toBe('其他项目');
 expect(resolveStepProjectKey({name:'豆包高经济价值 - 第六期'})).toBe('豆包高经济价值');expect(resolveStepProjectKey()).toBeNull();
});
test('只有Work一包一题，其他项目及无上下文维持通用能力',()=>{
 expect(singleQuestionPerPackage({parent_name:'Work法律全场景'})).toBe(true);
 for(const project of [{name:'其他项目'},{parent_name:'豆包高经济价值'},{}])expect(singleQuestionPerPackage(project)).toBe(false);
 expect(projectStepPolicies.materialQuestion.execute(null,{project:{},active:true})).toBeNull();
 expect(projectStepPolicies.materialQuestion.execute('Work法律全场景',{project:{},active:false})).toBeNull();
});
test('Work与通用项目的作答就绪/输入共用同一策略且不泄露私有字段',()=>{
 const complete=validateDraft(sampleDraft(true),[{id:'a',text:'材料'}],'model_report_v1',{contentContract:'work_legal_v1'});
 const value:any={...complete,question_version:'qv',content_status:{status:'draft',issues:['未完成']}};
 expect(answerCapabilityIssue(value)).toContain('草稿');expect(()=>authoringQuestion(value)).toThrow('草稿');
 const states=new Map<any,any>([[4,{status:'succeeded',result:value}],[5,{status:'waiting'}]]);
 expect(workflowStepReadiness(5,states).ready).toBe(false);
 value.content_status={status:'complete',issues:[]};expect(answerCapabilityIssue(value)).toBeNull();
 const input=buildAnswerInput(value,[{id:'a',kind:'redacted_markdown',sha256:'a'.repeat(64),text:'材料'}]);
 expect(JSON.stringify(input)).not.toContain('完整合成意见');expect(input).not.toHaveProperty('rubric');
 const ordinary={...value,content_contract:undefined,content_status:{status:'draft'}};
 expect(answerCapabilityIssue(ordinary)).toBeNull();
 const legacyStates=new Map<any,any>([[4,{project_key:'其他项目',status:'succeeded',result:{...value,content_status:{status:'draft'}},enabled:true,active:false}],[5,{project_key:'其他项目',status:'waiting',enabled:true,active:false}]]);
 expect(workflowStepReadiness(5,legacyStates)).toMatchObject({ready:false,reason:'Work题目仍为草稿，不能作答'});
});
test('评分新任务启用项目协议，旧无标记不补造，非Work拒绝继承Work标记',()=>{
 const work={content_contract:'work_legal_v1',scoring_policy:{contract:'model_report_v1'}} as ScoreContext;
 projectStepPolicies.scoreProtocol.execute(resolveStepProjectKey(work),{context:work});expect(work.candidate_quote_check).toBe('literal_v1');
 const historical={content_contract:'work_legal_v1',scoring_policy:{contract:'model_report_v1'}} as ScoreContext;
 projectStepPolicies.scoreProtocol.execute(resolveStepProjectKey(historical),{context:historical,frozen:{...historical}});expect(historical.candidate_quote_check).toBeUndefined();
 const generic={} as ScoreContext;expect(projectStepPolicies.scoreProtocol.execute(null,{context:generic,frozen:work})).toBe(false);
 expect(projectStepPolicies.scoreProtocol.execute(null,{context:generic})).toBe(true);expect(generic.candidate_quote_check).toBeUndefined();
});
test('同步策略失败传播且不执行其他项目或默认实现',()=>{
 const calls:string[]=[],r=new SyncProjectImplementations<number,number>(n=>{calls.push('default');return n;});
 r.register('A',()=>{calls.push('A');throw new Error('required');});r.register('B',n=>{calls.push('B');return n+1;});
 expect(()=>r.execute('A',0)).toThrow('required');expect(calls).toEqual(['A']);expect(r.execute('B',0)).toBe(1);expect(r.execute('unknown',2)).toBe(2);
});
test('各阶段可按主项目key订阅；无注册不查库，无项目材料不套项目回调',async()=>{
 const stages=['intake','extract','redact','authoring','answer','scoring','acceptance','delivery'];let reads=0;
 const pool={query:async()=>{reads++;return{rows:[{parent_name:'Work法律全场景',name:'Work法律全场景 - 一期'}]};}} as any;
 for(const stage of stages){
  const calls:string[]=[];
  const unsub=lifecycle.register({id:`flow-${stage}`,stage,event:'before',project_key:'Work法律全场景',run:context=>{expect(context.project_key).toBe('Work法律全场景');calls.push(stage);}});
  try{
   await emitProjectLifecycle(pool,'before',{stage,execution_id:'test'});expect(calls).toEqual([]);
   await emitProjectLifecycle(pool,'before',{stage,execution_id:'test',project_id:'p'});expect(calls).toEqual([stage]);
  }finally{unsub();}
 }
 expect(reads).toBe(stages.length);
 await emitProjectLifecycle(pool,'before',{stage:'future-step',execution_id:'test',project_id:'p'});expect(reads).toBe(stages.length);
});
test('公共步骤仅调用生命周期门面，项目行为不从兼容路径偷偷引入',async()=>{
 const files=['intake.ts','materials/jobs.ts','materials/redaction-jobs.ts','material-library/runner.ts','material-library/questions.ts','authoring/executor.ts','authoring/receive.ts','authoring/jobs.ts','authoring/restore.ts','answer-models/input.ts','answer-models/jobs.ts','scoring/jobs.ts','scoring/context.ts','scoring/executor.ts','decisions/jobs.ts','decisions/acceptance.ts','publishing/jobs.ts','publishing/tasks.ts','project-folders.ts','workflow-execution-routes.ts'];
 for(const file of files){
  const source=(await readFile(fileURLToPath(new URL(`../${file}`,import.meta.url)),'utf8')).replace(/^import type .*$/gm,'');
  expect(source).not.toMatch(/content_contract\s*[!=]==?\s*['"]work_legal_v1['"]/);
  expect(source).not.toMatch(/(?:from\s*|require\()\s*['"][^'"\n]*(?:projects\/Work|\.\/work-contract)['"]/);
 }
});

test('1—7顺序串联：临时材料→提取/脱敏替身→作者→答案→评分→达标→项目交付',async()=>{
 const {mkdtemp,rm}=await import('node:fs/promises');const {join}=await import('node:path');const {tmpdir}=await import('node:os');
 const {installLibraryBlob,readLibraryBlob}=await import('../material-library/storage');const {extractLocalDocument}=await import('../materials/document');
 const {runAuthoring}=await import('../authoring/executor');const {extractTextScore}=await import('../scoring/validate');const {decideAcceptance}=await import('../decisions/acceptance');
 const {LifecycleRegistry}=await import('./registry');const {executeProjectDelivery}=await import('./project-delivery');const {completeProjectPublication}=await import('./publication');
 for(const projectKey of ['普通项目','豆包高经济价值','Work法律全场景']){
  const root=await mkdtemp(join(tmpdir(),'lifecycle-chain-')),events:string[]=[],registry=new LifecycleRegistry();
  for(const stage of ['intake','redact','authoring','answer','scoring','acceptance','delivery'])for(const event of ['before','committed'] as const)registry.register({id:`${stage}-${event}`,stage,event,project_key:projectKey,run:()=>{events.push(`${stage}.${event}`);}});
  async function step<T>(stage:string,run:()=>Promise<T>):Promise<T>{
   await registry.emit('before',{stage,project_key:projectKey,execution_id:'synthetic'});
   const result=await run();await registry.emit('committed',{stage,project_key:projectKey,execution_id:'synthetic'});return result;
  }
  try{
   const extracted=await step('intake',async()=>{
    const blob=await installLibraryBlob(root,new TextEncoder().encode('张某的合成金额100元'),'text/plain','local');
    const bytes=await readLibraryBlob(root,blob.storage_path,blob.sha256);expect(bytes.byteLength).toBe(blob.size_bytes);
    return extractLocalDocument(bytes,'txt');
   });
   // 脱敏模型以固定返回值替代；真实编译/来源校验由材料库agent-redaction回归覆盖。
   const material=await step('redact',async()=>({id:'a',sha256:'a'.repeat(64),text:extracted.pages.map(p=>p.text).join('\n').replace('张某','合成当事人')}));
   const modern=projectKey==='Work法律全场景';
   const author=await step('authoring',()=>runAuthoring({root,workspace_path:root,project_name:projectKey,question:'合成任务',materials:[material],project_context:{source_digest:'b'.repeat(64),files:[{path:'skill/SKILL.md',text:'合成规则'}]},model:'fixture',reasoning_effort:'medium',...(modern?{content_contract:'work_legal_v1' as const,scoring_policy:{contract:'model_report_v1' as const,rules_text:'合成规则',reference_answer:'none' as const}}:{}),execute:async call=>({result:call.validate(sampleDraft(modern)),session_id:'synthetic',usage:null,duration_ms:1}) as any}));
   const answer=await step('answer',async()=>{const input=buildAnswerInput({...author.draft,question_version:author.question_version},[{...material,kind:'redacted_markdown'}]);expect(input.materials[0]?.text).toContain('合成当事人');return{text:'合成答复',input};});
   const score=await step('scoring',async()=>{expect(answer.text).toBe('合成答复');return modern?{score_contract:'model_report_v1' as const,evaluation_percent:0}:extractTextScore('总分：0/1',author.draft.rubric as any);});
   const acceptance=await step('acceptance',async()=>decideAcceptance({question_current:true,config:{required_models:['synthetic'],minimum_score_by_model:{synthetic:50}},models:[{model:'synthetic',answer_status:'succeeded',score_status:'succeeded',...('evaluation_percent' in score?score:{score:score.total!,max_score:score.max_score})}]}));
   expect(acceptance.decision).toBe('accepted');
   await step('delivery',async()=>{
    let prepared=false,delivered=false,archived=false,uploaded=false;
    await executeProjectDelivery(projectKey,{delivery:{mode:'noop',digest:'synthetic'},input:{question:author.draft} as any,outputDir:root,archive:{pool:{} as any,workflowId:'synthetic',storageRoot:root,frozen:{}},prepare:async()=>{prepared=true;},deliver:async()=>{expect(prepared).toBe(true);delivered=true;},checkpoint:async run=>{await run();}});
    expect(delivered).toBe(true);archived=true;
    await completeProjectPublication(projectKey,{pool:{} as any,workflowId:'synthetic',root,exportsRoot:root,signal:new AbortController().signal,sync:(async()=>{expect(archived).toBe(true);uploaded=true;return{status:'succeeded'};}) as any});
    expect(uploaded).toBe(projectKey==='豆包高经济价值');
   });
   expect(events).toEqual(['intake','redact','authoring','answer','scoring','acceptance','delivery'].flatMap(stage=>[`${stage}.before`,`${stage}.committed`]));
  }finally{await rm(root,{recursive:true,force:true});}
 }
});


test('新的项目key可接入作者转换/渲染与就绪策略，公共步骤无需新增项目分支',async()=>{
 const key='合成自定义项目';
 const removeNormalize=projectStepPolicies.normalize.register(key,({value})=>({...value,task_name:'自定义任务'}));
 const removeProjection=projectStepPolicies.packageProjection.register(key,input=>({...projectStepPolicies.packageProjection.execute(null,input),private_sections:['项目自定义部分']}));
 const removeAnswer=projectStepPolicies.answerIssue.register(key,value=>value.content_status?.status==='draft'?'项目要求先完成草稿':null);
 try{
  const value=validateDraft(sampleDraft(),[{id:'a',text:'材料'}],'legacy',{project_key:key});expect(value.task_name).toBe('自定义任务');
  const {renderPrivateQuestionPackage}=await import('../authoring/executor');
  expect(renderPrivateQuestionPackage({project_key:key,question:'合成题'},value)).toContain('项目自定义部分');
  const states=new Map<any,any>([[4,{project_key:key,status:'succeeded',result:{...value,content_status:{status:'draft'}},enabled:true,active:false}],[5,{project_key:key,status:'waiting',enabled:true,active:false}]]);
  expect(workflowStepReadiness(5,states)).toMatchObject({ready:false,reason:'项目要求先完成草稿'});
  expect(()=>authoringQuestion({...value,content_status:{status:'draft'},question_version:'qv'},{project_key:key})).toThrow('项目要求先完成草稿');
  expect(validateDraft(sampleDraft(),[{id:'a',text:'材料'}]).task_name).toBe('合成核算');
 }finally{removeNormalize();removeProjection();removeAnswer();}
});


test('可选通知身份查询失败不破坏主步骤；不猜测项目，通用回调仍执行',async()=>{
 let generic=0,scoped=0;
 const removeA=lifecycle.register({id:'identity-generic',stage:'authoring',event:'committed',run:()=>{generic++;}});
 const removeB=lifecycle.register({id:'identity-scoped',stage:'authoring',event:'committed',project_key:'Work法律全场景',run:()=>{scoped++;}});
 try{
  const main={saved:true};
  await expect(emitProjectLifecycle({query:async()=>{throw new Error('synthetic unavailable');}} as any,'committed',{stage:'authoring',execution_id:'test',project_id:'test',data:{result:main}})).resolves.toEqual([{id:'identity-generic',status:'succeeded'}]);
  expect(main.saved).toBe(true);expect(generic).toBe(1);expect(scoped).toBe(0);
 }finally{removeA();removeB();}
});
