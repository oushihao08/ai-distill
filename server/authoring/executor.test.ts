import {test,expect} from 'bun:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

import {runAuthoring} from './executor';
const draft={question:'合同金额是多少？',attachment_ids:['artifact-1'],rubric:[{id:'amount',criterion:'准确写明100元；错误得零分',max_score:1}],reference_answer:'内部标答：合同金额100元',answer_requirements:{input_mode:'text' as const,output_mode:'text' as const,tools:[]}};
const quality={passed:true,checks:{material_grounding:true,question_complete:true,rubric_consistent:true,reference_answer_complete:true,deliverables_complete:true},issues:[]};

test('authoring and independent quality review use isolated Codex calls and keep the reference answer private',async()=>{
 const root=await mkdtemp(join(tmpdir(),'authoring-executor-'));
 const calls:{directory:string;prompt:string;input:string;model:string;reasoning_effort:string}[]=[];
 try{
  const result=await runAuthoring({
   root:join(root,'not-created-yet'),input_revision:3,question:'合同金额是多少？',
   materials:[{id:'artifact-1',sha256:'a'.repeat(64),text:'合同金额100元'}],
   rules:{version_id:'rules-1',source_digest:'b'.repeat(64),files:[{path:'skill/SKILL.md',text:'根据材料出题，不得编造规则。'}, {path:'skill/assets/template.docx',bytes:new Uint8Array([80,75,3,4])}]},
   model:'fixture-model',reasoning_effort:'medium',
   execute:async(options:any)=>{
    const input=await Bun.file(join(options.directory,'input','input.json')).text();
    expect(new Uint8Array(await Bun.file(join(options.directory,'input','rules','skill','assets','template.docx')).arrayBuffer())).toEqual(new Uint8Array([80,75,3,4]));
    calls.push({directory:options.directory,prompt:options.prompt,input,model:options.model,reasoning_effort:options.reasoning_effort});
    return {result:options.validate(calls.length===1?draft:quality),session_id:`session-${calls.length}`,usage:{input_tokens:10},events_path:join(options.directory,'events.jsonl'),duration_ms:1};
   },
  });
  expect(calls).toHaveLength(2);
  expect(calls[0].directory).not.toBe(calls[1].directory);
  expect(calls[0].input).toContain('合同金额100元');
  expect(calls[1].input).toContain('内部标答：合同金额100元');
  expect(result).toMatchObject({question:'合同金额是多少？',question_version:expect.any(String),rubric_version:expect.any(String),input_revision:3,quality_check:{passed:true}});
  expect(result).not.toHaveProperty('reference_answer');
  expect(result).not.toHaveProperty('reference_answer');
  expect(JSON.stringify(result)).not.toContain('内部标答：合同金额100元');
 }finally{await rm(root,{recursive:true,force:true});}
});

test('failed independent quality review cannot produce a publishable authoring result',async()=>{
 const root=await mkdtemp(join(tmpdir(),'authoring-rejected-'));let calls=0;
 try{
  await expect(runAuthoring({root,input_revision:3,question:'题面',materials:[{id:'artifact-1',sha256:'a'.repeat(64),text:'依据'}],rules:{version_id:'rules-1',source_digest:'b'.repeat(64),files:[{path:'SKILL.md',text:'规则'}]},model:'fixture',reasoning_effort:'low',execute:async(options:any)=>({result:options.validate(++calls===1?draft:{...quality,passed:false}),session_id:`session-${calls}`,usage:null,events_path:'private',duration_ms:1})})).rejects.toThrow('独立质检');
  expect(calls).toBe(2);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('invalid draft stops before independent quality review',async()=>{
 const root=await mkdtemp(join(tmpdir(),'authoring-invalid-'));let calls=0;
 try{
  await expect(runAuthoring({root,input_revision:3,question:'题面',materials:[{id:'artifact-1',sha256:'a'.repeat(64),text:'依据'}],rules:{version_id:'rules-1',source_digest:'b'.repeat(64),files:[{path:'SKILL.md',text:'规则'}]},model:'fixture',reasoning_effort:'low',execute:async(options:any)=>({result:options.validate(++calls===1?{...draft,attachment_ids:['foreign']}:quality),session_id:`session-${calls}`,usage:null,events_path:'private',duration_ms:1})})).rejects.toThrow('附件引用无效');
  expect(calls).toBe(1);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('unsupported answer capabilities cannot be published as a successful step four result',async()=>{
 const root=await mkdtemp(join(tmpdir(),'authoring-capability-'));let calls=0;
 try{
  await expect(runAuthoring({root,input_revision:3,question:'题面',materials:[{id:'artifact-1',sha256:'a'.repeat(64),text:'依据'}],rules:{version_id:'rules-1',source_digest:'b'.repeat(64),files:[{path:'SKILL.md',text:'规则'}]},model:'fixture',reasoning_effort:'low',execute:async(options:any)=>({result:options.validate(++calls===1?{...draft,answer_requirements:{input_mode:'text',output_mode:'file',tools:[]}}:quality),session_id:`session-${calls}`,usage:null,events_path:'private',duration_ms:1})})).rejects.toThrow('当前作答执行器仅支持文字输入、文字答案且不执行工具');
  expect(calls).toBe(1);
 }finally{await rm(root,{recursive:true,force:true});}
});

for(const changed of [false,true])test(`rubric-only revision ${changed?'rejects question changes':'preserves question and keeps private evidence'}`,async()=>{
 const root=await mkdtemp(join(tmpdir(),'authoring-revision-'));let calls=0;
 try{
  const pending=runAuthoring({root,input_revision:3,question:draft.question,materials:[{id:'artifact-1',sha256:'a'.repeat(64),text:'合同金额100元'}],rules:{version_id:'rules-1',source_digest:'b'.repeat(64),files:[{path:'skill/SKILL.md',text:'规则'}]},model:'fixture',reasoning_effort:'low',revision:{mode:'rubric',source_attempt_id:'old',draft,evidence:{issues:['缺少金额评分依据']}},execute:async(options:any)=>{
   const input=JSON.parse(await Bun.file(join(options.directory,'input/input.json')).text());
   expect(input.revision.draft.reference_answer).toBe(draft.reference_answer);
   expect(options.prompt).toContain('返修');
   return {result:options.validate(++calls===1?{...draft,question:changed?'更换问题':draft.question,rubric:[{id:'amount',criterion:'写明100元且引用合同；否则零分',max_score:1}]}:quality),session_id:`s-${calls}`,usage:null,events_path:'private',duration_ms:1};
  }});
  if(changed){await expect(pending).rejects.toThrow('rubric-only');expect(calls).toBe(1);}
  else{const result=await pending;expect(result.question).toBe(draft.question);expect(JSON.stringify(result)).not.toContain(draft.reference_answer);expect(result.rubric[0]?.criterion).toContain('引用合同');}
 }finally{await rm(root,{recursive:true,force:true});}
});

test('question repair can replace historical attachment references but cannot publish unknown current attachments',async()=>{
 const root=await mkdtemp(join(tmpdir(),'material-authoring-'));let calls=0;
 try{const result=await runAuthoring({root,input_revision:3,question:draft.question,materials:[{id:'new-artifact',sha256:'a'.repeat(64),text:'重新提取并脱敏金额100元'}],rules:{version_id:'rules',source_digest:'b'.repeat(64),files:[{path:'skill/SKILL.md',text:'依材料出题'}]},model:'fixture',reasoning_effort:'low',revision:{mode:'question',source_attempt_id:'old',draft,evidence:{materials:[{material_id:'original',pages:[1]}]}},execute:async(options:any)=>({result:options.validate(++calls===1?{...draft,attachment_ids:['new-artifact']}:quality),session_id:`new-${calls}`,usage:null,events_path:'private',duration_ms:1})});expect(result.attachment_ids).toEqual(['new-artifact']);expect(calls).toBe(2);}
 finally{await rm(root,{recursive:true,force:true});}
});
