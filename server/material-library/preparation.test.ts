/**
 * 职责：验证材料整理摘要、支持范围到出题输入的传递及本期组合去重。
 * 入口：`bun test server/material-library/preparation.test.ts`；只用临时目录和数据库/Agent替身。
 * 边界：不连接业务数据库、不调用真实模型，不证明真实期次已部署或模型摘要质量。
 */
import {test,expect} from 'bun:test';
import {mkdtemp,readFile,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {preparationUnits,preparationBlocks,completeKnownPreparationDocuments,compilePreparation,compileFixedPreparation,materializePreparation,missingPreparationSummaryTasks,mergePreparationSummaryRepairs,preparationCounts,visiblePreparationContext,visiblePreparedDocuments,renderPreparationDocuments} from '../../shared/material-preparation-result';
import {PREPARATION_PROMPT,findMatchingPreparation,runPreparationCheckpoint,resumePreparation,executePreparation,enqueuePreparation,registerPreparationRoutes} from './preparation';
import {hash} from './execution-shared';
import {Hono} from 'hono';
import {attachPreparationContext} from './questions';
import {runAuthoring} from '../authoring/executor';
import {sampleDraft} from '../lifecycle/flow.fixture';
import {saveMaterialScopeSelection} from '../authoring/jobs';

const id='11111111-1111-4111-8111-111111111111',projectId='22222222-2222-4222-8222-222222222222';
const sourceIndex={format:'redacted-index-v2',materials:[{material_id:'file-1',markdown:'借款合同正文\n付款记录\n裁判文书正文',document:{format:'redacted-structure-v1',pages:[
 {page:1,blocks:[{id:'b1',kind:'paragraph',text:'借款合同正文'}]},
 {page:2,blocks:[{id:'b2',kind:'paragraph',text:'付款记录'}]},
 {page:3,blocks:[{id:'b3',kind:'paragraph',text:'裁判文书正文'}]},
]}}]};
const units=preparationUnits(sourceIndex),blocks=preparationBlocks(units);
const raw={package_summary:'借款材料包，包含合同、付款和裁判文书。',documents:[
 {id:'D1',title:'借款合同',block_ids:[blocks[0]!.id],summary:'记载借款金额及还款约定。',document_type:'合同',tags:['借款','合同'],notes:''},
 {id:'D2',title:'付款记录',block_ids:[blocks[1]!.id],summary:'记录借款后的付款情况。',document_type:'付款凭证',tags:['付款'],notes:''},
 {id:'D3',title:'裁判文书',block_ids:[blocks[2]!.id],summary:'记载法院对争议的处理结果。',document_type:'裁判文书',tags:['裁判','既判阶段'],notes:''},
],combinations:[
 {id:'S1',direction:'债务清偿核算',party:'借款人代理方',scenes:[{scene:'诉前核账',as_of:'起诉前'},{scene:'执行异议审查',as_of:'执行阶段'}],core_work:'核实清偿范围',deliverables:['核账意见','异议申请'],document_ids:['D1','D2'],notes:''},
 {id:'S2',direction:'执行线索整理',party:'债权人代理方',scenes:[{scene:'财产线索核查',as_of:'执行阶段'}],core_work:'整理可供执行的线索',deliverables:['财产线索清单'],document_ids:['D2','D3'],notes:''},
],warnings:[]};
const result=compilePreparation(raw,units);

test('整理结果保留总摘要、每份材料摘要和多个兼容方向场景交付组合',()=>{
 expect(result.package_summary).toContain('借款材料包');
 expect(result.documents).toHaveLength(3);
 expect(result.documents.every(d=>d.summary.length>0)).toBe(true);
 expect(result.combinations).toHaveLength(2);
 expect(result.combinations[0]!.scenes).toHaveLength(2);
 expect(result.combinations[0]!.deliverables).toHaveLength(2);
});

test('可见性投影排除隐藏正文和依赖隐藏文书的范围，标题相同时不重复添加',()=>{
 const classified:any=structuredClone(raw);
 classified.documents[0]!.visibility='visible';classified.documents[0]!.visibility_reason='';
 classified.documents[1]!.visibility='visible';classified.documents[1]!.visibility_reason='';
 classified.documents[2]!.visibility='hidden';classified.documents[2]!.visibility_reason='裁判结果已完整载明';
 const compiled=compilePreparation(classified,units),context=visiblePreparationContext(compiled),visible=visiblePreparedDocuments(compiled,units);
 expect(compiled.document_count).toBe(3);expect(context.document_count).toBe(2);expect(context.documents.map(document=>document.title)).toEqual(['借款合同','付款记录']);
 expect(context.combinations.map(combination=>combination.id)).toEqual(['S1']);
 expect(visible.map(document=>document.text).join('\n')).not.toContain('裁判文书正文');
 visible[0]!.document.pages[0]!.blocks=[{id:'title',kind:'heading',text:'借款合同',level:1},{id:'body',kind:'paragraph',text:'借款合同正文'}];
 visible[0]!.text='借款合同\n\n借款合同正文';
 const rendered=renderPreparationDocuments(visible);
 expect(rendered).toStartWith('【第 1 页】\n# 借款合同\n\n借款合同正文');
 expect(rendered.match(/# 借款合同/g)).toHaveLength(1);
 expect(rendered).not.toContain('裁判文书正文');
});

test('历史整理记录只报告条目数和摘要数，不把旧数组长度当真实文书数',()=>{
 const legacy=structuredClone(result);delete legacy.document_count;delete legacy.unassigned_group_count;delete legacy.unassigned_block_count;
 for(const document of legacy.documents)delete document.unit_kind;
 expect(preparationCounts(legacy)).toEqual({known:false,entry_count:3,summary_count:3});
 const visible=visiblePreparationContext(legacy);
 expect(visible.document_count).toBeUndefined();expect(visible.unassigned_group_count).toBeUndefined();
 expect(preparationCounts({...legacy,documents:[]})).toEqual({known:false,entry_count:0,summary_count:0});
});

test('摘要缺失或分组引用无效只产生提示，所有原文结构仍可完整还原',()=>{
 const incomplete=structuredClone(raw);incomplete.package_summary='';incomplete.documents[1]!.summary='';incomplete.documents[2]!.block_ids=['missing'];
 const compiled=compilePreparation(incomplete,units),texts=materializePreparation(compiled,units).map(d=>d.text).join('\n');
 expect(compiled.warnings.some(w=>w.includes('总摘要为空'))).toBe(true);
 expect(compiled.warnings.some(w=>w.includes('摘要为空'))).toBe(true);
 expect(compiled.documents).toHaveLength(3);
 expect(texts).toContain('借款合同正文');expect(texts).toContain('付款记录');expect(texts).toContain('裁判文书正文');
});

test('缺摘要与未归类文书生成定向补摘要任务，回填后覆盖全部原结构且不采纳模型坐标',()=>{
 const incomplete=structuredClone(raw);incomplete.documents[1]!.summary='';incomplete.documents.splice(2,1);
 const tasks=missingPreparationSummaryTasks(incomplete,units);
 expect(tasks.map(task=>task.kind)).toEqual(['existing','unassigned']);
 const repaired=mergePreparationSummaryRepairs(incomplete,tasks,{documents:[
  {id:tasks[0]!.id,summary:'补充的付款记录摘要',document_type:'付款凭证',tags:['付款'],notes:''},
  {id:tasks[1]!.id,summary:'补充的裁判文书摘要',document_type:'裁判文书',tags:['裁判'],notes:'',block_ids:['not-a-real-source-block']},
 ]});
 const compiled=compilePreparation(repaired,units);
 expect(compiled.documents).toHaveLength(3);
 expect(compiled.documents.every(document=>document.summary.length>0)).toBe(true);
 expect(compiled.documents[1]!.summary).toBe('补充的付款记录摘要');
 expect(compiled.documents[2]!.block_ids).toEqual([blocks[2]!.id]);
 expect(materializePreparation(compiled,units).map(document=>document.text).join('\n')).toContain('裁判文书正文');
});

test('建题自动匹配精确来源的整理结果；无表或无匹配记录时返回空且不改材料',async()=>{
 const prepared={id,result};
 const query=async(sql:string)=>sql.includes('to_regclass')?{rows:[{available:true}]}:{rows:[prepared]};
 const source={package_id:'p',revision_id:'r',redaction_id:'redaction',extraction_job_id:'extract'};
 const found=await findMatchingPreparation({query} as any,source,projectId);
 expect(found).toEqual({...prepared,result:{...prepared.result,summary_scope:'visible'}});
 const frozen:any={package_id:'p',revision_id:'r',redaction_id:'redaction',extraction_job_id:'extract',source_digest:'digest',markdown:'FULL MATERIAL',index:JSON.stringify(sourceIndex)};
 const attached=await attachPreparationContext({query} as any,frozen,projectId);
 expect(attached.markdown).toBe('FULL MATERIAL');expect(attached.material_scope?.result.package_summary).toBe(result.package_summary);
 expect(await findMatchingPreparation({query:async()=>({rows:[{available:false}]})} as any,source,projectId)).toBeUndefined();
});

test('出题Agent收到摘要和范围文件，同时保留全部材料附件并返回最终题目组合',async()=>{
 const root=await mkdtemp(join(tmpdir(),'material-scope-author-'));
 try{
  const workspace=join(root,'workspace');await mkdir(workspace);
  const analysisResult=structuredClone(result);
  analysisResult.combinations[0]!.notes='核定范围用于后续修订；核验条款与适用条件一致，不要求新增表格。';
  analysisResult.combinations[0]!.deliverables=['供客户决定办理路径的意见及可审签修订稿'];
  const scope={preparation_id:id,result:analysisResult,used_combinations:[]};
  const draft=sampleDraft();
  const out=await runAuthoring({root:join(root,'execution'),workspace_path:workspace,project_name:'测试项目',question:'完成法律工作',materials:[{id:'attachment-1',sha256:'a'.repeat(64),text:'完整材料正文'}],project_context:{source_digest:'rules',files:[{path:'skill/SKILL.md',text:'遵守项目Skill'}]},material_scope:scope,model:'fixture',reasoning_effort:'low',execute:async(call:any)=>{
   const scopeFile=JSON.parse(await readFile(join(call.directory,'input','material-scope.json'),'utf8'));
   expect(scopeFile.result.package_summary).toBe(result.package_summary);
   expect(scopeFile.result.documents).toHaveLength(3);
   expect(scopeFile.result.combinations[0].notes).toBe(analysisResult.combinations[0]!.notes);
   expect(scopeFile.result.combinations[0].deliverables).toEqual(analysisResult.combinations[0]!.deliverables);
   expect(scopeFile.used_combinations).toEqual([]);
   expect(call.prompt).toContain('材料依据—专业处理—使用动作—实际文件—验收证据');
   expect(await readFile(join(call.directory,'input','attachments','附件1.txt'),'utf8')).toBe('完整材料正文');
   expect(call.prompt).toContain('实际生成支持该动作的业务文件');
   expect(call.schema.properties.material_scope_selection.properties.additional_combinations).toBeDefined();
   return{result:call.validate({...draft,attachment_ids:['attachment-1'],material_scope_selection:{direction:'债务清偿核算',party:'借款人代理方',scenes:['诉前核账'],deliverables:['核账意见'],additional_combinations:[{direction:'执行推进',party:'债权人',scenes:['执行阶段'],deliverables:['执行意见']}]}}),session_id:'fixture',usage:null,duration_ms:1,diagnostic_path:'fixture',provider:'fixture',model:'fixture'} as any;
  }});
  expect(out.draft.material_scope_selection?.direction).toBe('债务清偿核算');
  expect(out.draft.material_scope_selection?.additional_combinations?.[0]?.direction).toBe('执行推进');
 }finally{await rm(root,{recursive:true,force:true});}
});

test('已用方向与场景仅作参考，重复与多组合不阻断保存',async()=>{
 const saved=new Set<string>();let failDuplicate=false;
 const db={query:async(sql:string,values:any[]=[])=>{
  if(sql.includes("to_regclass('ai_distill.question_material_scope_uses')"))return{rows:[{available:true}]};
  if(sql.startsWith('INSERT INTO ai_distill.question_material_scope_uses')){const key=String(values[5]);if(saved.has(key)||failDuplicate)return{rowCount:0,rows:[]};saved.add(key);return{rowCount:1,rows:[{workflow_id:values[1]}]};}
  return{rowCount:1,rows:[]};
 }};
 const choice={direction:'债务清偿核算',party:'借款人代理方',scenes:['诉前核账'],deliverables:['核账意见']};
 await saveMaterialScopeSelection(db as any,projectId,'workflow-1','attempt-1',choice);
 failDuplicate=true;
 await saveMaterialScopeSelection(db as any,projectId,'workflow-2','attempt-2',{...choice,additional_combinations:[{...choice,direction:'执行推进'}]});
 failDuplicate=false;
 await saveMaterialScopeSelection(db as any,projectId,'workflow-3','attempt-3',{...choice,scenes:['执行异议审查']});
 expect(saved.size).toBe(2);
 await saveMaterialScopeSelection({query:async()=>({rows:[{available:false}]})} as any,projectId,'workflow-4','attempt-4',undefined);
});

test('材料整理页面接口完整返回候选分析，旧结果无说明仍可读取且不查询原文',async()=>{
 for(const notes of ['前项审查用于后项修订；成果供委托方审签并核验适用条件','']){
  const stored=structuredClone(result);stored.combinations[0]!.notes=notes;
  const app=new Hono();
  registerPreparationRoutes(app,{query:async(sql:string)=>{
   if(sql.includes('to_regclass'))return{rows:[{available:true}]};
   if(sql.includes('SELECT * FROM ai_distill.library_preparations'))return{rows:[{id,result:stored}]};
   if(sql.includes('SELECT id,job_id,revision_id'))return{rows:[{id,result:stored}]};
   throw new Error('不应扩读材料或其他题包：'+sql);
  }} as any,'/unused');
  const detail=await app.request(`/api/material-library/preparations/${id}`);
  expect(detail.status).toBe(200);expect((await detail.json()).result.combinations).toEqual(stored.combinations);
  const list=await app.request(`/api/material-library/packages/${id}/preparations`);
  expect(list.status).toBe(200);expect((await list.json()).items[0].result.combinations).toEqual(stored.combinations);
 }
});


test('已有完整分册补回漏选的空白和正文块并重补摘要，不产生同名未归类碎片',()=>{
 const source=preparationUnits({prepared_documents:[{id:'known',title:'证据材料',document:{pages:[{page:1,blocks:[{id:'a',kind:'paragraph',text:'正文'},{id:'b',kind:'paragraph',text:''},{id:'c',kind:'paragraph',text:'遗漏证据'}]}]}}]});
 const sourceBlocks=preparationBlocks(source);
 const original={package_summary:'摘要',documents:[{id:'D',title:'证据材料',block_ids:[sourceBlocks[0]!.id],summary:'不完整摘要',tags:[],notes:'',visibility:'visible'}],combinations:[]};
 const repaired=completeKnownPreparationDocuments(original,source),tasks=missingPreparationSummaryTasks(repaired,source);
 expect(repaired.documents[0].block_ids).toEqual(sourceBlocks.map(block=>block.id));
 expect(tasks).toHaveLength(1);expect(tasks[0]!.kind).toBe('existing');
 const merged=mergePreparationSummaryRepairs(repaired,tasks,{documents:[{id:tasks[0]!.id,summary:'包含正文与遗漏证据',tags:['证据'],visibility:'visible'}]});
 const compiled=compilePreparation(merged,source);
 expect(compiled.document_count).toBe(1);expect(compiled.unassigned_block_count).toBe(0);
 expect(materializePreparation(compiled,source)[0]!.text).toContain('遗漏证据');
 // 原文件边界不等于文书边界，不擅自扩充模型划分。
 expect(completeKnownPreparationDocuments(original,source.map(unit=>({...unit,boundary:undefined}))).documents[0].block_ids).toHaveLength(1);
});

test('整份已知分册未返回时补摘要沿用完整文书身份，不把未知文件冒充文书',()=>{
 const known=preparationUnits({prepared_documents:[{id:'known',title:'原件',text:'全部正文'}]});
 const tasks=missingPreparationSummaryTasks({documents:[]},known);expect(tasks[0]!.kind).toBe('document');
 const merged=mergePreparationSummaryRepairs({package_summary:'包',documents:[],combinations:[]},tasks,{documents:[{id:tasks[0]!.id,summary:'完整摘要',visibility:'visible'}]});
 expect(compilePreparation(merged,known).document_count).toBe(1);
 expect(missingPreparationSummaryTasks({documents:[]},units)[0]!.kind).toBe('unassigned');
});

test('模型正常说明不成为警告，文书具体疑点保留在notes',()=>{
 const source:any=structuredClone(raw);source.warnings=['全部保留','未生成题目'];
 source.documents.forEach((document:any)=>document.visibility='visible');source.documents[0].notes='手写日期辨识不清';
 const compiled=compilePreparation(source,units);expect(compiled.warnings).toEqual([]);expect(compiled.documents[0]!.notes).toContain('日期辨识不清');
});


test('显式恢复复用已完整返回的检查点，不因提示词、模型或引擎变化阻断',async()=>{
 const root=await mkdtemp(join(tmpdir(),'preparation-resume-'));
 try{
  const old=join(root,'old'),next=join(root,'next');await mkdir(old);await mkdir(next);
  let calls=0;const execute=async()=>({result:{value:++calls}});
  expect(await runPreparationCheckpoint(old,undefined,execute)).toEqual({result:{value:1}});
  expect(await runPreparationCheckpoint(next,old,execute)).toEqual({result:{value:1}});expect(calls).toBe(1);
  expect(await runPreparationCheckpoint(next,old,execute)).toEqual({result:{value:1}});expect(calls).toBe(1);
  let failures=0;
  const empty=join(root,'empty');await mkdir(empty);
  await expect(runPreparationCheckpoint(empty,undefined,async()=>{failures++;throw new Error('provider unknown');})).rejects.toThrow('provider unknown');expect(failures).toBe(1);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('恢复拒绝活动或成功任务，HTTP拒绝未知字段而不派发',async()=>{
 for(const status of ['running','queued','succeeded']){
  const pool={query:async()=>({rows:[{status}]})};
  await expect(resumePreparation(pool as any,'/unused',id,{request_key:projectId})).rejects.toThrow('仅可显式续作');
 }
 const app=new Hono();registerPreparationRoutes(app,{query:async()=>{throw new Error('不应查询');}} as any,'/unused');
 const response=await app.request(`/api/material-library/jobs/${id}/prepare-resume`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({request_key:projectId,automatic:true})});expect(response.status).toBe(400);
});

test('查库正文直接进入单次请求，不落输入文件且完整检查点可复用',async()=>{
 const root=await mkdtemp(join(tmpdir(),'preparation-run-'));
 try{
  const source={format:'redacted-index-v2',prepared_documents:[{id:'unit',title:'执行依据',text:'判决记载执行依据'}]};const index=JSON.stringify(source);
  let published:any,updates=0;const phases:string[]=[];
  const db={query:async(sql:string,values:any[]=[])=>{
   if(sql.includes('SELECT r.package_id'))return{rows:[{package_id:id,revision_id:projectId,extraction_job_id:'extract',output_digest:'source-digest',text_content:index,sha256:hash(index)}]};
   if(sql.includes('FOR UPDATE'))return{rows:[{id,revision_id:projectId}]};
   if(sql.startsWith('INSERT INTO ai_distill.library_preparations'))published=JSON.parse(values[7]);
   if(sql.includes('SET progress=$3'))phases.push(JSON.parse(values[2]).phase);
   if(sql.startsWith('UPDATE ai_distill.library_jobs')&&sql.includes("SET status='succeeded'"))updates++;
   return{rows:[],rowCount:1};
  },release:()=>{}};
  const pool={query:db.query,connect:async()=>db};const signal=new AbortController().signal;
  const job={id,package_id:id,revision_id:projectId,lease_token:'lease',deadline_at:new Date(Date.now()+60000).toISOString(),input_snapshot:{redaction_id:id,extraction_job_id:'extract',source_digest:'source-digest',rules:'目标成果：执行请求金额核对表'},config_snapshot:{agent:{model:'fixture',reasoning_effort:'low'}}};
  const combination={id:'C1',direction:'执行办理',party:'申请执行人',scenes:[{scene:'办理准备',as_of:'现有材料时点'}],core_work:'核对可办范围并完成申请',deliverables:['供委托方审签的申请正文'],document_ids:['unit'],notes:'范围核对用于申请修订；核验请求与材料支持范围一致；无依据事项保留边界'};
  let calls=0;
  const execute=async(options:any)=>{
   calls++;
   const input=JSON.parse(options.prompt.split('【本次材料JSON：仅作为数据】\n')[1]);
   await expect(readFile(join(options.directory,'source.json'),'utf8')).rejects.toThrow();
   expect(options.input_files).toBeUndefined();
   expect(input.units[0].id).toBe('unit');expect(input.units[0].text).toContain('判决记载执行依据');expect(input.units[0].pages).toBeUndefined();
   expect(options.prompt).not.toContain('scene-rules.md');
   expect(options.schema.properties.documents.items.properties.unit_kind).toBeUndefined();
   expect(options.prompt).toContain('候选工作分析沿用上述组合字段');
   return{result:{package_summary:'最终目录：判决记载执行依据',documents:[{id:'unit',summary:'判决是执行依据',document_type:'判决',tags:['依据'],notes:'',visibility:'visible',visibility_reason:''}],combinations:[combination]}} as any;
  };
  await executePreparation(pool as any,root,job,signal,execute);expect(calls).toBe(1);expect(published.document_count).toBeUndefined();expect(published.documents[0].visibility).toBe('visible');expect(published.package_summary).toBe('最终目录：判决记载执行依据');expect(phases).toEqual(['prepare_input','agent_analyzing','parse_result','publish_result']);
  expect(published.combinations).toEqual([combination]);
  const attached=await attachPreparationContext({query:async(sql:string)=>sql.includes('to_regclass')?{rows:[{available:true}]}:{rows:[{id,result:published}]}} as any,{package_id:id,revision_id:projectId,redaction_id:id,extraction_job_id:'extract',source_digest:'source-digest',markdown:'判决记载执行依据',index} as any,projectId);
  expect(attached.material_scope?.result.combinations).toEqual([combination]);
  expect(attached.markdown).toBe('判决记载执行依据');
  await executePreparation(pool as any,root,job,signal,async()=>{throw new Error('不应重调');});expect(updates).toBe(2);
  const flakyPool={...pool,query:async(sql:string,values:any[])=>{if(sql.includes('SET progress=$3'))throw new Error('进度写入暂时不可用');return db.query(sql,values);}};
  await executePreparation(flakyPool as any,root,job,signal,async()=>{throw new Error('进度失败不得重调Agent');});expect(updates).toBe(3);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('固定目录拒绝模型重分册，稳定ID及全部正文沿用来源，空白和残片单独计数',()=>{
 const source=preparationUnits({prepared_documents:[
  {id:'evidence',title:'原证据',document:{pages:[{page:1,blocks:[{id:'a',kind:'paragraph',text:'原证据正文'},{id:'b',kind:'paragraph',text:'第二段正文'}]}]}},
  {id:'blank',title:'空白扫描',text:''},
  {id:'fragment',title:'身份扫描残片',text:'姓名某某'},
  {id:'target',title:'现成目标成果',text:'已完成证据目录及逐项证明目的说明'},
 ]});
 const description=(id:string,kind='document',visibility='visible',reason='')=>({id,summary:`${id}摘要`,document_type:'材料',tags:['材料'],notes:'',unit_kind:kind,visibility,visibility_reason:reason});
 const r=compileFixedPreparation({package_summary:'案件与证据概况',documents:[
  {...description('evidence','document','hidden'),title:'模型改名',block_ids:['u1p1b1']},
  description('invented'),description('blank'),description('fragment','unassigned'),description('target','document','hidden','已完成要求生成的证据目录及证明目的说明'),
 ],combinations:[{id:'valid',direction:'诉讼举证',party:'原告',scenes:[{scene:'举证准备',as_of:'庭前'}],core_work:'整理证据证明目的',deliverables:['证据目录'],document_ids:['evidence'],notes:''},{...raw.combinations[0],id:'hidden-reference',document_ids:['target']}]},source);
 expect(r.documents.map(d=>d.id)).toEqual(source.map(d=>d.id));expect(r.documents[0]!.title).toBe('原证据');expect(r.documents[0]!.block_ids).toEqual(['u1p1b1','u1p1b2']);
 expect(r.documents[0]!.visibility).toBe('visible');expect(r.documents[3]!.visibility).toBe('hidden');
 expect(r.document_count).toBe(2);expect(r.unassigned_group_count).toBe(2);expect(r.documents).toHaveLength(4);expect(r.combinations.map(c=>c.id)).toEqual(['valid']);
 expect(r.documents.flatMap(d=>d.block_ids)).toHaveLength(preparationBlocks(source).length);
 expect(materializePreparation(r,source)[0]!.text).toContain('第二段正文');expect(visiblePreparedDocuments(r,source).map(d=>d.id)).not.toContain('target');
});

test('提示词联合判断候选与可见性，无有效候选时程序恢复全部材料可见',()=>{
 expect(PREPARATION_PROMPT).toContain('没有有效候选组合时全部材料标visible');
 expect(PREPARATION_PROMPT).toContain('混有待考结果与不可拆分必要案件事实');
 expect(PREPARATION_PROMPT).toContain('内容相同或实质重复的文书采用一致visibility');
 const source=preparationUnits({prepared_documents:[
  {id:'judgment',title:'判决书',text:'记载案件主体、金额与裁判结果'},
  {id:'notice',title:'执行通知',text:'记载执行金额和程序节点'},
 ]});
 const result=compileFixedPreparation({package_summary:'案件结果材料',documents:[
  {id:'judgment',summary:'判决结果',document_type:'判决',tags:['裁判'],notes:'',visibility:'hidden',visibility_reason:'透露结论'},
  {id:'notice',summary:'执行进度',document_type:'通知',tags:['执行'],notes:'',visibility:'hidden',visibility_reason:'包含结果'},
 ],combinations:[]},source,true);
 expect(result.documents.map(document=>document.visibility)).toEqual(['visible','visible']);
 expect(result.documents.every(document=>document.visibility_reason==='')).toBe(true);
 expect(result.warnings).toContain('无有效候选组合，隐藏标记已按可见处理');
});

test('整包出题支持度由五维分数确定状态并约束危险候选，历史缺失字段保持兼容',()=>{
 expect(PREPARATION_PROMPT).toContain('出题支持度question_support');
 const source=preparationUnits({prepared_documents:[{id:'evidence',title:'合同与付款记录',text:'合同、付款及催收事实'}]});
 const document={id:'evidence',summary:'合同履行证据',document_type:'证据',tags:['合同'],notes:'',visibility:'visible',visibility_reason:''};
 const combination={id:'scope',direction:'合同履行审查',party:'债权人',scenes:[{scene:'诉前核验',as_of:'起诉前'}],core_work:'核验欠款',deliverables:['法律意见'],document_ids:['evidence'],notes:''};
 const support=(dimensions:Record<string,number>)=>({dimensions,reason:'能够形成证据核验任务',allowed_task_types:['证据核验'],unsupported_conclusions:['确定最终余额']});
 const usable=compileFixedPreparation({package_summary:'合同材料',documents:[document],combinations:[combination],question_support:support({task_actor:2,factual_basis:2,professional_judgment:2,deliverable_viability:2,information_boundary:1})},source,true);
 expect(usable.question_support).toMatchObject({score:9,status:'usable'});expect(usable.combinations).toHaveLength(1);
 const dangerous=compileFixedPreparation({package_summary:'材料不足',documents:[document],combinations:[combination],question_support:support({task_actor:1,factual_basis:1,professional_judgment:1,deliverable_viability:1,information_boundary:1})},source,true);
 expect(dangerous.question_support).toMatchObject({score:5,status:'dangerous'});expect(dangerous.combinations).toEqual([]);expect(dangerous.documents[0]!.visibility).toBe('visible');expect(dangerous.warnings).toContain('出题支持度为危险，候选组合已忽略');
 const missingCandidate=compileFixedPreparation({package_summary:'材料充分',documents:[document],combinations:[],question_support:support({task_actor:2,factual_basis:2,professional_judgment:2,deliverable_viability:2,information_boundary:2})},source,true);
 expect(missingCandidate.question_support).toMatchObject({score:10,status:'preparation_error'});
 const legacy=compileFixedPreparation({package_summary:'旧结果',documents:[document],combinations:[]},source,true);expect(legacy.question_support).toBeUndefined();
});


test('整理入队与显式恢复冻结预算、模型和稳定来源；规则、模型或引擎变化不阻断续作',async()=>{
 const before=process.env.EXECUTION_QUEUE_MODE;process.env.EXECUTION_QUEUE_MODE='legacy';
 try{
  const source=JSON.stringify({prepared_documents:[{id:'source',title:'材料',text:'正文'}]});const jobs:any[]=[];
  const db={query:async(sql:string,values:any[]=[])=>{
   if(sql.includes("to_regclass('ai_distill.library_preparations')"))return{rows:[{available:true}]};
   if(sql.includes('SELECT r.package_id'))return{rows:[{package_id:id,revision_id:projectId,extraction_job_id:'extract',output_digest:'digest',text_content:source,sha256:hash(source)}]};
   if(sql.includes("WHERE id=$1 AND kind='prepare'"))return{rows:jobs.filter(job=>job.id===values[0])};
   if(sql.includes('SELECT status,input_snapshot'))return{rows:jobs.filter(job=>job.id===values[0])};
   if(sql.includes('WHERE package_id=$1 AND request_key=$2'))return{rows:jobs.filter(job=>job.request_key===values[1])};
   if(sql.includes("j.status IN ('queued','running','succeeded')"))return{rows:[]};
   if(sql.includes('SELECT id FROM ai_distill.library_packages'))return{rows:[{id}]};
   if(sql.startsWith('INSERT INTO ai_distill.library_jobs')){jobs.push({id:values[0],revision_id:values[2],request_key:values[3],status:'queued',input_snapshot:JSON.parse(values[5]),config_snapshot:JSON.parse(values[7]),previous_job_id:values[8]});}
   return{rows:[],rowCount:1};
  },release:()=>{}};
  const pool={query:db.query,connect:async()=>db};
  const request={request_key:id,redaction_id:id,agent_settings:{model:'gpt-6-luna',reasoning_effort:'high'}};
  const first=await enqueuePreparation(pool as any,'/unused',projectId,request);expect(jobs).toHaveLength(1);expect(jobs[0].config_snapshot.settings.execution.task_timeout_ms).toBe(1800000);
  expect((await enqueuePreparation(pool as any,'/unused',projectId,request)).id).toBe(first.id);expect(jobs).toHaveLength(1);
  jobs[0].status='cancelled';
  const next=await resumePreparation(pool as any,'/unused',first.id,{request_key:projectId,execution_timeout_ms:3600000});
  expect(next.id).not.toBe(first.id);expect(jobs[1].previous_job_id).toBe(first.id);expect(jobs[1].input_snapshot.previous_job_id).toBe(first.id);expect(jobs[1].config_snapshot.agent).toEqual(request.agent_settings);expect(jobs[1].config_snapshot.settings.execution.task_timeout_ms).toBe(3600000);
  jobs[0].input_snapshot.engine_version='old-engine';
  const thirdKey='33333333-3333-4333-8333-333333333333';
  expect((await resumePreparation(pool as any,'/unused',first.id,{request_key:thirdKey})).id).not.toBe(first.id);expect(jobs).toHaveLength(3);
  await expect(enqueuePreparation(pool as any,'/unused',projectId,{...request,execution_timeout_ms:0})).rejects.toThrow('执行预算');
 }finally{if(before===undefined)delete process.env.EXECUTION_QUEUE_MODE;else process.env.EXECUTION_QUEUE_MODE=before;}
});


test('来源分册有多个模型划分时不擅自合并；缺少参考索引不丢弃整理上下文',async()=>{
 const known=preparationUnits({prepared_documents:[{id:'known',title:'材料',document:{pages:[{page:1,blocks:[{id:'a',kind:'paragraph',text:'甲'},{id:'b',kind:'paragraph',text:'乙'},{id:'c',kind:'paragraph',text:'丙'}]}]}}]});
 const b=preparationBlocks(known),r={documents:[{id:'one',block_ids:[b[0]!.id]},{id:'two',block_ids:[b[1]!.id]}]};
 expect(completeKnownPreparationDocuments(r,known).documents).toEqual(r.documents);
 const db={query:async(sql:string)=>sql.includes('library_preparations')&&sql.includes('to_regclass')?{rows:[{available:true}]}:sql.includes('question_material_scope_uses')?{rows:[{available:false}]}:{rows:[{id,result}]}};
 expect((await findMatchingPreparation(db as any,{package_id:id,revision_id:id,redaction_id:id,extraction_job_id:'extract'},projectId))?.id).toBe(id);
 await saveMaterialScopeSelection({query:async()=>({rows:[{available:true}]})} as any,projectId,id,id,undefined);
});

test('可见摘要投影保留Agent总摘要，不用逐份拼接替代',()=>{
 const result=compileFixedPreparation({package_summary:'可见事实形成的整包法律关系摘要',documents:units.map(u=>({id:u.id,summary:'逐份说明',document_type:'证据',tags:['证据'],visibility:'visible'})),combinations:[]},units,true);
 expect(visiblePreparationContext(result).package_summary).toBe('可见事实形成的整包法律关系摘要');
 expect(result.document_count).toBeUndefined();
});

test('项目专属结果优先且建题按稳定提取或脱敏来源匹配，不限定整理引擎',async()=>{
 let sqlText='',parameters:any[]=[];
 const db={query:async(sql:string,values:any[]=[])=>{if(sql.includes('to_regclass'))return{rows:[{available:true}]};sqlText=sql;parameters=values;return{rows:[]};}};
 await findMatchingPreparation(db as any,{package_id:id,revision_id:projectId,redaction_id:id,extraction_job_id:'extract'},projectId);
 expect(sqlText).toContain('DESC NULLS LAST');expect(sqlText).toContain('p.extraction_job_id=$4');expect(sqlText).not.toContain('engine_version');expect(parameters[3]).toBe('extract');
});

test('历史纯正文索引经共用模型正文投影不丢失材料',()=>{
 const u=preparationUnits({materials:[{material_id:'legacy',markdown:'历史证据100元'}]});
 const r=compileFixedPreparation({package_summary:'事实',documents:[{id:'legacy',summary:'100元',document_type:'证据',tags:['金额'],visibility:'visible'}]},u,true);
 expect(renderPreparationDocuments(materializePreparation(r,u))).toContain('历史证据100元');
});
