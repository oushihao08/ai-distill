/**
 * 职责：验证材料整理摘要、支持范围到出题输入的传递及本期组合去重。
 * 入口：`bun test server/material-library/preparation.test.ts`；只用临时目录和数据库/Agent替身。
 * 边界：不连接业务数据库、不调用真实模型，不证明真实期次已部署或模型摘要质量。
 */
import {test,expect} from 'bun:test';
import {mkdtemp,readFile,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {preparationUnits,preparationBlocks,compilePreparation,materializePreparation,missingPreparationSummaryTasks,mergePreparationSummaryRepairs} from '../../shared/material-preparation-result';
import {findMatchingPreparation} from './preparation';
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
 const source={package_id:'p',revision_id:'r',redaction_id:'redaction',source_digest:'digest'};
 const found=await findMatchingPreparation({query} as any,source,projectId);
 expect(found).toEqual(prepared);
 const frozen:any={package_id:'p',revision_id:'r',redaction_id:'redaction',source_digest:'digest',markdown:'FULL MATERIAL',index:JSON.stringify(sourceIndex)};
 const attached=await attachPreparationContext({query} as any,frozen,projectId);
 expect(attached.markdown).toBe('FULL MATERIAL');expect(attached.material_scope?.result.package_summary).toBe(result.package_summary);
 expect(await findMatchingPreparation({query:async()=>({rows:[{available:false}]})} as any,source,projectId)).toBeUndefined();
});

test('出题Agent收到摘要和范围文件，同时保留全部材料附件并返回最终题目组合',async()=>{
 const root=await mkdtemp(join(tmpdir(),'material-scope-author-'));
 try{
  const workspace=join(root,'workspace');await mkdir(workspace);
  const scope={preparation_id:id,result,used_combinations:[{direction:'已用方向',scene:'已用场景'}]};
  const draft=sampleDraft();
  const out=await runAuthoring({root:join(root,'execution'),workspace_path:workspace,project_name:'测试项目',question:'完成法律工作',materials:[{id:'attachment-1',sha256:'a'.repeat(64),text:'完整材料正文'}],project_context:{source_digest:'rules',files:[{path:'skill/SKILL.md',text:'遵守项目Skill'}]},material_scope:scope,model:'fixture',reasoning_effort:'low',execute:async(call:any)=>{
   const scopeFile=JSON.parse(await readFile(join(call.directory,'input','material-scope.json'),'utf8'));
   expect(scopeFile.result.package_summary).toBe(result.package_summary);
   expect(scopeFile.result.documents).toHaveLength(3);
   expect(await readFile(join(call.directory,'input','attachments','附件1.txt'),'utf8')).toBe('完整材料正文');
   expect(call.prompt).toContain('避开本期已用方向+场景');
   return{result:call.validate({...draft,attachment_ids:['attachment-1'],material_scope_selection:{direction:'债务清偿核算',party:'借款人代理方',scenes:['诉前核账'],deliverables:['核账意见']}}),session_id:'fixture',usage:null,duration_ms:1,diagnostic_path:'fixture',provider:'fixture',model:'fixture'} as any;
  }});
  expect(out.draft.material_scope_selection?.direction).toBe('债务清偿核算');
 }finally{await rm(root,{recursive:true,force:true});}
});

test('已用方向与场景组合不可重复登记，其他场景可登记',async()=>{
 const saved=new Set<string>();let failDuplicate=false;
 const db={query:async(sql:string,values:any[]=[])=>{
  if(sql.includes("to_regclass('ai_distill.question_material_scope_uses')"))return{rows:[{available:true}]};
  if(sql.startsWith('INSERT INTO ai_distill.question_material_scope_uses')){const key=String(values[5]);if(saved.has(key)||failDuplicate)return{rowCount:0,rows:[]};saved.add(key);return{rowCount:1,rows:[{workflow_id:values[1]}]};}
  return{rowCount:1,rows:[]};
 }};
 const choice={direction:'债务清偿核算',party:'借款人代理方',scenes:['诉前核账'],deliverables:['核账意见']};
 await saveMaterialScopeSelection(db as any,projectId,'workflow-1','attempt-1',choice);
 failDuplicate=true;
 await expect(saveMaterialScopeSelection(db as any,projectId,'workflow-2','attempt-2',choice)).rejects.toThrow('本期已有题目使用相同方向与场景');
 failDuplicate=false;
 await saveMaterialScopeSelection(db as any,projectId,'workflow-3','attempt-3',{...choice,scenes:['执行异议审查']});
 expect(saved.size).toBe(2);
});
