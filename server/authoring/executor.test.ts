/** 验证出题分文件输入、指令顺序、标答保密及返修边界；使用注入执行器，不调用真实模型。 */
import {test,expect} from 'bun:test';
import {mkdtemp,rm,mkdir,writeFile,realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {runAuthoring,renderPrivateQuestionPackage} from './executor';

const draft={task_name:'合同金额核算',task_type:'金额计算',header:{industry_l1:'待确认',industry_l2:'待确认',task_form:'single_round' as const,occupation_l1:'待确认',occupation_l2:'待确认'},question:'合同金额是多少？',attachment_ids:['artifact-1'],rubric:[{id:'amount',criterion:'准确写明100元；错误得零分',max_score:1}],answer_approach:'核对合同金额条款',reference_answer:'内部标答：合同金额100元',answer_requirements:{input_mode:'text' as const,output_mode:'text' as const,tools:[]}};
async function finish(call:any,result:any){
 if(call.execution_profile==='fresh_authoring'&&result?.result){
  const input=await Bun.file(join(call.directory,'input/input.json')).json();
  await mkdir(join(call.directory,'output'),{recursive:true});
  await writeFile(join(call.directory,'output/result.json'),JSON.stringify(result.result));
  await writeFile(join(call.directory,'output/题目.md'),renderPrivateQuestionPackage({question:input.task,question_id:input.question_id,source_files:input.source_files},result.result));
 }
 return result;
}
const options=(root:string,execute:(options:any)=>Promise<any>)=>({root,workspace_path:root,question:'合同金额是多少？',materials:[{id:'artifact-1',sha256:'a'.repeat(64),text:'合同金额100元'}],rules:{version_id:'rules-1',source_digest:'b'.repeat(64),files:[{path:'skill/SKILL.md',text:'根据材料和本期规则出题，不得编造规则。'}, {path:'skill/assets/template.docx',bytes:new Uint8Array([80,75,3,4])}]},model:'fixture-model',reasoning_effort:'medium',execute:async(call:any)=>finish(call,await execute(call))});
test('上传附件没有目录清单时，索引和真实渲染器使用附件原文件名',async()=>{
 const root=await mkdtemp(join(tmpdir(),'author-upload-name-'));
 try{
  const task=options(root,async()=>{throw new Error('unexpected');});
  const result=await runAuthoring({...task,materials:[{...task.materials[0]!,source_names:['上传判决.docx']}],execute:async call=>{
   const input=await Bun.file(join(call.directory,'input/input.json')).json();
   expect(input.source_files).toEqual([{name:'上传判决.docx'}]);
   const contract=await Bun.file(join(call.directory,'input/delivery.json')).json();
   expect(contract.input_files).toBeUndefined();
   await Bun.write(contract.result_path,JSON.stringify(draft));
   expect(await Bun.spawn(contract.render_command,{stdout:'pipe',stderr:'pipe'}).exited).toBe(0);
   return {result:call.validate(draft),session_id:'fixture',usage:null,duration_ms:1,diagnostic_path:'private',provider:'fixture',model:'fixture'};
  }});
  expect(result.package_text).toContain('输入附件：\n上传判决.docx');
  expect(result.package_text).not.toContain('项目目录未登记');
 }finally{await rm(root,{recursive:true,force:true});}
});
test('新契约出题执行、实际渲染脚本与返回题包保留扣分规则',async()=>{
 const root=await mkdtemp(join(tmpdir(),'author-model-report-'));
 try{
  const value={...draft,rubric:[{id:'deduct',criterion:'金额错误',rule:'金额错误扣7分；否决独立判断',metadata:{score:-7}}]};
  const task=options(root,async()=>{throw new Error('unexpected');});
  const result=await runAuthoring({...task,scoring_policy:{contract:'model_report_v1',rules_text:'按项目规则判断加扣分，否决独立记录',reference_answer:'calibration'},execute:async(call:any)=>{
   expect(call.schema.properties.rubric.items.properties).toHaveProperty('rule');
   expect(call.schema.properties.rubric.items.properties).not.toHaveProperty('max_score');
   expect(call.prompt).toContain('按项目规则判断加扣分，否决独立记录');
   const contract=await Bun.file(join(call.directory,'input/delivery.json')).json();
   await writeFile(contract.result_path,JSON.stringify(value));
   const child=Bun.spawn(contract.render_command,{stdout:'pipe',stderr:'pipe'});
   expect(await child.exited).toBe(0);
   return {result:call.validate(value),session_id:'fixture',usage:null,duration_ms:1,diagnostic_path:'private',provider:'fixture',model:'fixture'};
  }});
  expect(result.draft.rubric).toEqual(value.rubric);
  expect(result.package_text).toContain(value.rubric[0].rule);
  expect(result.package_text).not.toContain('undefined分');
 }finally{await rm(root,{recursive:true,force:true});}
});

test('ordinary authoring cannot silently accept a historical feedback package',async()=>{
 const root=await mkdtemp(join(tmpdir(),'author-feedback-'));let called=false;
 try{await expect(runAuthoring({...options(root,async()=>{called=true;return{result:draft};}),evaluation_feedback:{previous_question:{question:'旧题'}}} as any)).rejects.toThrow('历史反馈');expect(called).toBe(false);}
 finally{await rm(root,{recursive:true,force:true});}
});
test('Work 法律全场景缺少 model_report_v1 时不启动出题模型',async()=>{
 const root=await mkdtemp(join(tmpdir(),'author-work-contract-'));let called=false;
 try{
  const task=options(root,async()=>{called=true;return{result:draft};});
  await expect(runAuthoring({...task,project_name:'Work法律全场景 - 首批筹备'})).rejects.toThrow('必须配置 model_report_v1');
  expect(called).toBe(false);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('Work 出题保留提示说明但不因缺少Harbor映射拒收',async()=>{
 const root=await mkdtemp(join(tmpdir(),'author-work-harbor-'));let prompt='';
 const value={...draft,rubric:[{id:'amount',criterion:'准确核算',rule:'按材料核算',metadata:{score:3}}]};
 try{
  const task=options(root,async()=>{throw new Error('unexpected');});
  await expect(runAuthoring({...task,project_name:'Work法律全场景 - 首批筹备',scoring_policy:{contract:'model_report_v1',rules_text:'保留正负分规则',reference_answer:'calibration'},execute:(async(call:any)=>{prompt=call.prompt;return{result:value,session_id:'fixture',usage:null,duration_ms:1,diagnostic_path:'private',provider:'fixture',model:'fixture'};}) as any})).resolves.toMatchObject({draft:value});
  expect(prompt).toContain('未提供可省略或为 null');
 }finally{await rm(root,{recursive:true,force:true});}
});
test.each(['missing','mismatch','symlink'])('ordinary authoring accepts %s Markdown without reading it',async(mode)=>{
 const root=await mkdtemp(join(tmpdir(),'author-document-'));
 try{
  const task=options(root,async()=>{throw new Error('unexpected');});
  // Bypass the successful fixture's file writer to exercise missing and invalid artifacts.
  await expect(runAuthoring({...task,execute:async(call:any)=>{
   await mkdir(join(call.directory,'output'),{recursive:true});
   if(mode==='mismatch')await writeFile(join(call.directory,'output/题目.md'),'另一道题');
   if(mode==='symlink'){const fs=await import('node:fs/promises');await writeFile(join(root,'foreign.md'),'外部文件');await fs.symlink(join(root,'foreign.md'),join(call.directory,'output/题目.md'));}
   return{result:call.validate(draft),session_id:'fixture',usage:null,duration_ms:1,diagnostic_path:'private',provider:'fixture',model:'fixture'};
  }})).resolves.toMatchObject({draft});
  expect(await Bun.file(join(root,'draft.json')).json()).toEqual(draft);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('ordinary authoring delivery renderer works in an actual local process',async()=>{
 const root=await mkdtemp(join(tmpdir(),'author-renderer-'));
 try{
  const task=options(root,async()=>{throw new Error('unexpected');});
  const result=await runAuthoring({...task,execute:async(call:any)=>{
   const contract=await Bun.file(join(call.directory,'input/delivery.json')).json();
   expect(contract.note).toContain('可选阅读稿');expect(contract.note).toContain('不阻止保存');
   expect(call.prompt).toContain('result.json即可交卷');
   await writeFile(contract.result_path,JSON.stringify(draft));
   const child=Bun.spawn(contract.render_command,{stdout:'pipe',stderr:'pipe'});
   expect(await child.exited).toBe(0);expect(await new Response(child.stderr).text()).toBe('');
   return{result:call.validate(draft),session_id:'renderer',usage:null,duration_ms:1,diagnostic_path:'private',provider:'fixture',model:'fixture'};
  }});
  expect(result.draft).toEqual(draft);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('authoring writes a private complete draft and public package omits private answers',async()=>{
 const root=await mkdtemp(join(tmpdir(),'authoring-executor-'));let authorDirectory='';
 try{
  const author=await runAuthoring(options(join(root,'author'),async(call:any)=>{
   authorDirectory=call.directory;
   const input=await Bun.file(join(call.directory,'input','input.json')).text();
   expect(new Uint8Array(await Bun.file(join(call.directory,'input','rules','skill','assets','template.docx')).arrayBuffer())).toEqual(new Uint8Array([80,75,3,4]));
   expect(input).not.toContain('合同金额100元');
   expect(await Bun.file(join(call.directory,'input/attachments/附件1.txt')).text()).toBe('合同金额100元');
   return {result:call.validate(draft),session_id:'author-session',usage:{input_tokens:10},events_path:join(call.directory,'events.jsonl'),duration_ms:1};
  }));
  expect(author).toMatchObject({question_version:expect.any(String),rubric_version:expect.any(String)});
  expect(author.package_text).not.toContain('内部标答：合同金额100元');expect(author.package_text).not.toContain('作答思路');
  expect(await Bun.file(join(authorDirectory,'input/attachments/附件1.txt')).exists()).toBe(false);
  expect(await Bun.file(join(authorDirectory,'input/input.json')).exists()).toBe(true);
  expect(await Bun.file(join(authorDirectory,'output/result.json')).exists()).toBe(true);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('ordinary authoring removes temporary attachment text after execution fails',async()=>{
 const root=await mkdtemp(join(tmpdir(),'authoring-cleanup-'));let authorDirectory='';
 try{
  await expect(runAuthoring(options(root,async(call:any)=>{
   authorDirectory=call.directory;
   expect(await Bun.file(join(authorDirectory,'input/attachments/附件1.txt')).text()).toBe('合同金额100元');
   throw new Error('fixture author failed');
  }))).rejects.toThrow('fixture author failed');
  expect(await Bun.file(join(authorDirectory,'input/attachments/附件1.txt')).exists()).toBe(false);
  expect(await Bun.file(join(authorDirectory,'input/input.json')).exists()).toBe(true);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('foreign attachment references are preserved for downstream handling',async()=>{
 const root=await mkdtemp(join(tmpdir(),'authoring-invalid-'));let calls=0;
 try{
  await expect(runAuthoring(options(root,async(call:any)=>({result:call.validate({...draft,attachment_ids:['foreign']}),session_id:'author',usage:null,events_path:'private',duration_ms:1})))).resolves.toMatchObject({draft:{attachment_ids:['foreign']}});
  calls++;expect(calls).toBe(1);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('business answer capabilities do not block saving an authored question',async()=>{
 const root=await mkdtemp(join(tmpdir(),'authoring-capability-'));
 try{
  await expect(runAuthoring(options(root,async(call:any)=>({result:call.validate({...draft,answer_requirements:{input_mode:'text',output_mode:'file',tools:[]}}),session_id:'author',usage:null,events_path:'private',duration_ms:1})))).resolves.toMatchObject({draft:{answer_requirements:{output_mode:'file'}}});
 }finally{await rm(root,{recursive:true,force:true});}
});

test('ordinary authoring schema only allows capabilities supported by the answer runner',async()=>{
 const root=await mkdtemp(join(tmpdir(),'authoring-answer-capabilities-'));
 try{
  await runAuthoring(options(root,async(call:any)=>{
   const requirements=call.schema.properties.answer_requirements.properties;
   expect(requirements.input_mode.enum).toEqual(['text']);
   expect(requirements.output_mode.enum).toEqual(['text']);
   expect(requirements.tools.maxItems).toBe(0);
   return{result:call.validate(draft),session_id:'author',usage:null,events_path:'private',duration_ms:1};
  }));
 }finally{await rm(root,{recursive:true,force:true});}
});


test('project task inputs preserve skill files and put task instructions before skill and attachment paths',async()=>{
 const root=await mkdtemp(join(tmpdir(),'project-authoring-'));
 const files=[{path:'skill/SKILL.md',text:'入口：读取 references/method.md'}, {path:'skill/references/method.md',text:'当前项目方法'}];
 const {rules:_rules,...base}=options(root,async()=>{throw new Error('unexpected executor');});
 const task={...base,project_name:'测试期项目',question_id:'题目1',source_files:[{name:'原件.pdf',path:join(root,'original.pdf')}],project_context:{source_digest:'c'.repeat(64),files}};
 try{
  const author=await runAuthoring({...task,step_prompt:'本次重点检查金额口径',execute:async(call:any)=>{
   const input=await Bun.file(join(call.directory,'input/input.json')).json();
   expect(input).toMatchObject({project_name:'测试期项目',question_id:'题目1',step:'出题',project_authoring_prompt:'本次重点检查金额口径',materials:[{id:task.materials[0].id,sha256:task.materials[0].sha256,name:'附件1',path:'input/attachments/附件1.txt'}]});
   expect(input.system_authoring_prompt).toContain('<固定通用出题规则>');
   expect(await Bun.file(join(call.directory,input.materials[0].path)).text()).toBe(task.materials[0].text);
   expect(input.source_files).toEqual([{name:'原件.pdf'}]);
   expect(await Bun.file(join(call.directory,'input/render-package.cjs')).text()).not.toContain(join(root,'original.pdf'));
   expect(JSON.stringify(input)).not.toContain(root);
   expect(call.prompt.startsWith(input.system_authoring_prompt+'\n\n<项目可配置出题提示词>')).toBe(true);
   expect(call.prompt).toContain('本次重点检查金额口径');
   expect(call.execution_profile).toBe('fresh_authoring');expect(call.working_directory).toBe(await realpath(root));
   expect(call.prompt.indexOf('skill：')).toBeLessThan(call.prompt.indexOf('附件（'));
   expect(call.prompt).toContain(`skill：${join(call.directory,'input/project-context/skill/SKILL.md')}`);
   expect(call.prompt).toContain(`"path":"${join(call.directory,'input/attachments/附件1.txt')}"`);
   expect(call.prompt).not.toContain('只修有证据支持');expect(call.prompt).toContain('允许按skill导航读取其引用的案例卡');
   expect(call.prompt.match(/skill\/SKILL\.md/g)).toHaveLength(1);
   for(const file of files)expect(await Bun.file(join(call.directory,'input/project-context',file.path)).text()).toBe(file.text);
   return finish(call,{result:call.validate(draft),session_id:'author',usage:null,duration_ms:1,diagnostic_path:'private',provider:'codex' as const,model:'fixture'});
  }});
  const privatePackage=await Bun.file(join(root,'draft-package.txt')).text();
  for(const section of ['表头','任务名称','任务类型','prompt','考点rubric','作答思路','标准答案-文本'])expect(privatePackage).toContain(`\n\n${section}\n`);
  expect(privatePackage).not.toContain('脱敏附件记录ID');
  expect(author.package_text).not.toContain(draft.reference_answer);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('library question accepts relative source manifest paths used only as display metadata',async()=>{
 const root=await mkdtemp(join(tmpdir(),'author-library-source-path-'));
 try{
  const task=options(root,async()=>{throw new Error('unexpected');});
  const result=await runAuthoring({...task,source_files:[{name:'(2023)渝0104民初2679号.pdf',path:'91239d42/redacted_markdown.md'}],execute:async call=>finish(call,{result:call.validate(draft),session_id:'fixture',usage:null,duration_ms:1})});
  expect(result.package_text).toContain('(2023)渝0104民初2679号.pdf');
 }finally{await rm(root,{recursive:true,force:true});}
});

test('ordinary authoring cannot include unrelated project materials as task inputs',async()=>{
 const root=await mkdtemp(join(tmpdir(),'author-skill-only-'));let called=false;
 try{const task=options(root,async()=>{called=true;throw new Error('unexpected');});await expect(runAuthoring({...task,project_context:{source_digest:'a'.repeat(64),files:[{path:'materials/old-question.md',text:'历史题目'}]}})).rejects.toThrow('仅接受指定skill');expect(called).toBe(false);}
 finally{await rm(root,{recursive:true,force:true});}
});

test('Work交付说明冻结附件映射名称，作者不依赖不存在的模板',async()=>{
 const root=await mkdtemp(join(tmpdir(),'author-work-input-map-'));
 try{
  const task=options(root,async()=>{throw new Error('unexpected');});
  await expect(runAuthoring({...task,content_contract:'work_legal_v1',scoring_policy:{contract:'model_report_v1',rules_text:'保留正负分规则',reference_answer:'calibration'},execute:async(call:any)=>{
   const contract=await Bun.file(join(call.directory,'input/delivery.json')).json();
   expect(contract.input_files).toEqual([{attachment_id:'artifact-1',name:'附件1',description:'由作者依据本份材料填写完整用途说明'}]);
   expect(call.prompt).toContain('原文件名只作显示，不替换映射名称');
   expect(call.prompt).toContain('若有模板则按其导航读取');
   expect(call.prompt).not.toContain('完整读取指定Skill中的题目模板');
   throw new Error('fixture-inspected');
  }})).rejects.toThrow('fixture-inspected');
 }finally{await rm(root,{recursive:true,force:true});}
});

test('无材料整理时独立提供批次参考，元数据不进入公开或完整题包正文',async()=>{
 const root=await mkdtemp(join(tmpdir(),'author-batch-'));
 const batch={captured_at:'2026-10-30T00:00:00Z',total:1,included:1,missing:0,truncated:false,selections:[{direction:'诉讼',party:'被告',scenes:['举证'],deliverables:['意见']}]};
 try{
  const value={...draft,material_scope_selection:{direction:'内部方向标记',party:'内部主体标记',scenes:[],deliverables:[],core_work:'内部工作标记'}};
  const result=await runAuthoring({...options(root,async(call:any)=>{
   expect(await Bun.file(join(call.directory,'input/batch-context.json')).json()).toEqual(batch);
   expect(await Bun.file(join(call.directory,'input/material-scope.json')).exists()).toBe(false);
   expect(call.prompt).toContain('本期设计参考');
   const delivery=await Bun.file(join(call.directory,'input/delivery.json')).json();expect(delivery.schema.properties.material_scope_selection.properties).toHaveProperty('core_work');
   return{result:value,session_id:'fixture',usage:null,duration_ms:1};
  }),batch_context:batch});
  expect(result.draft.material_scope_selection).toEqual(value.material_scope_selection);
  expect(result.package_text).not.toContain('内部方向标记');expect(renderPrivateQuestionPackage({question:'题'},result.draft)).not.toContain('内部工作标记');
 }finally{await rm(root,{recursive:true,force:true});}
});
