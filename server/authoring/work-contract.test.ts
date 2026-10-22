/** 验证 Work 内容契约的无损保存、判据计分、成果对应与研究隔离；不调用数据库或真实模型。 */
import {test,expect} from 'bun:test';
import {validateDraft} from './validate';
import {assertWorkSubmissionReady} from './work-contract';
const materials=[{id:'a',text:'脱敏材料'}];
export function workFixture():any{
 const row=(id:string,dimension:string,score:number|null)=>({id,metadata:{statement:'本项独立判断的具体标准',criterion_type:'Objective',criterion_necessity:'Implicit',dimension,evaluated_files:['意见.docx'],knowledge_points:[],atomic_capabilities:[],priority:score===10?'Critically Important':score===null?'Veto':'Slightly Important',score,type:'binary',points:null,trigger_count:null}});
 const value={content_contract:'work_legal_v1',task_name:'证据审查意见',task_type:'F2 审查审核',header:{industry_l1:'法律服务',industry_l2:'诉讼',task_form:'single_round',occupation_l1:'诉讼律师',occupation_l2:'律师'},question:'作为我方律师，依据附件1出具意见.docx。基准日2026年10月1日。',attachment_ids:['a'],answer_approach:'核对证据与规范，形成意见',task_metadata:{occupation:'诉讼律师',scenario:'LS02',role_perspective:'我方律师',domain_l2:'证据审查',capabilities:['证据评估','风险识别'],professional_knowledge:['证据规则'],vl_dependency:false,source_note:'本次脱敏卷宗',generation_note:'AI模拟专家生成，非真人签署',tools:[],target_level:'L2',level_basis:{documents:[{id:'d1',attachment_id:'a',locator:'第1页',description:'原始独立文书'}],necessary_steps:['核对证据来源'],estimated_hours:1,explanation:'根据本题工作估算，非外部核定'}},input_files:[{attachment_id:'a',name:'附件1',description:'脱敏材料'}],deliverables:[{id:'opinion',path:'意见.docx',format:'docx',description:'证据审查意见',required:true}],reference_outputs:[{deliverable_id:'opinion',content:'完整业务意见正文',sheets:[]}],research_records:[{id:'s1',query:'核对证据规则',source_url:'https://example.org/law',source_title:'法源正文',version:'适用版本',findings:'适用规则内容',verification_status:'verified',supports:['opinion']}],task_requirements:{input_mode:'text',output_mode:'text',tools:[]},content_status:{status:'complete',issues:[]},rubric:[row('R1-P01','1-指令遵循',3),row('R2-P01','2-交付物内容质量/Q2风险识别',10),row('R2-P02','2-交付物内容质量/Q3法源定位',10),row('R2-P03','2-交付物内容质量/Q1事实证据',3),row('R3-P01','3-体例',3),row('R4-P01','4-推理规划',3),{...row('R5-N01','5-安全合规',-7),metadata:{...row('R5-N01','5-安全合规',-7).metadata,priority:'Detrimental'}},row('R0-V01','0-一票否决',null)]};
 // 合成条目仅覆盖结构边界，不声称是独立有效的专业判据。
 while(value.rubric.length<30){const item=structuredClone(value.rubric[1]!);item.id=`R2-P${value.rubric.length+10}`;value.rubric.push(item);}
 return value;
}
test('Work 独立内容完整保存，兼容文本与计分规则由同一内容派生',()=>{
 const raw=workFixture(),result:any=validateDraft(raw,materials,'model_report_v1',{contentContract:'work_legal_v1'} as any);
 expect(result.content_contract).toBe('work_legal_v1');expect(result.reference_outputs).toEqual(raw.reference_outputs);
 expect(result.research_records).toEqual(raw.research_records);expect(result.reference_answer).toContain('完整业务意见正文');
 expect(result.rubric[1].criterion).toBe(raw.rubric[1].metadata.statement);expect(result.rubric[1].rule).toContain('10');
 expect(result.rubric[0].metadata).not.toHaveProperty('project_context');
 expect(validateDraft(JSON.parse(JSON.stringify(result)),materials,'model_report_v1',{contentContract:'work_legal_v1'} as any)).toEqual(result);
});
test('Work完整题包至少30项且使用Office成果，草稿仍保留部分结果',()=>{
 for(const count of [29,30,31]){
  const raw=workFixture();raw.rubric=raw.rubric.slice(0,count);
  raw.question=raw.question.replaceAll('意见.docx','意见.docx');raw.deliverables[0].path='意见.docx';raw.deliverables[0].format='docx';
  while(raw.rubric.length<count){const item=structuredClone(raw.rubric[1]);item.id=`R2-P${raw.rubric.length+10}`;raw.rubric.push(item);}
  raw.rubric.forEach((r:any)=>r.metadata.evaluated_files=['意见.docx']);
  const validate=()=>validateDraft(raw,materials,'model_report_v1',{contentContract:'work_legal_v1'});
  if(count===29)expect(validate).toThrow('至少30项');else expect(validate).not.toThrow();
 }
 const old=workFixture();old.rubric=old.rubric.slice(0,8);expect(()=>validateDraft(old,materials,'model_report_v1',{contentContract:'work_legal_v1'})).toThrow();
 old.content_status={status:'draft',issues:['尚未形成完整成果和独立判据']};
 expect(()=>validateDraft(old,materials,'model_report_v1',{contentContract:'work_legal_v1'})).not.toThrow();
});
test('Work完整业务成果拒绝MD，草稿可保留旧格式等待返修',()=>{
 const raw=workFixture();raw.question=raw.question.replace('意见.docx','意见.md');raw.deliverables[0].path='意见.md';raw.deliverables[0].format='md';raw.rubric.forEach((r:any)=>r.metadata.evaluated_files=['意见.md']);
 expect(()=>validateDraft(raw,materials,'model_report_v1',{contentContract:'work_legal_v1'})).toThrow('DOCX/XLSX');
 raw.content_status={status:'draft',issues:['专业成果尚待成稿']};expect(()=>validateDraft(raw,materials,'model_report_v1',{contentContract:'work_legal_v1'})).not.toThrow();
});
test('Work新交付复用成果映射校验，不改写历史对象或自动补项',()=>{
 const good=workFixture(),before=JSON.stringify(good);assertWorkSubmissionReady(good);expect(JSON.stringify(good)).toBe(before);
 for(const change of [
  (v:any)=>v.content_status={status:'draft',issues:['待补']},
  (v:any)=>v.rubric.pop(),
  (v:any)=>v.rubric[1].id=v.rubric[0].id,
  (v:any)=>v.rubric[0].metadata.statement=' ',
  (v:any)=>v.rubric[0].metadata.evaluated_files=['旧名.md'],
  (v:any)=>v.question='交付文件',
  (v:any)=>v.reference_outputs=[],
  (v:any)=>v.reference_outputs.push(structuredClone(v.reference_outputs[0])),
  (v:any)=>v.deliverables[0].format='xlsx',
  (v:any)=>{v.deliverables[0].path='核算.xlsx';v.deliverables[0].format='xlsx';v.question='交付核算.xlsx';v.rubric.forEach((r:any)=>r.metadata.evaluated_files=['核算.xlsx']);},
 ]){const value=structuredClone(good);change(value);expect(()=>assertWorkSubmissionReady(value)).toThrow();}
});
test('未提供正式二级分类时保留null，不强迫作者编造分类；知识点不接受格式占位',()=>{
 const raw=workFixture();raw.task_metadata.domain_l2=null;
 const result:any=validateDraft(raw,materials,'model_report_v1',{contentContract:'work_legal_v1'});
 expect(result.task_metadata.domain_l2).toBeNull();
 const placeholder=workFixture();placeholder.rubric[1].metadata.knowledge_points=['法律域::具体知识点'];
 expect(()=>validateDraft(placeholder,materials,'model_report_v1',{contentContract:'work_legal_v1'})).toThrow('实际法律领域');
});
test('Work 拒绝丢失成果、越界引用、重复内容源和非法分值',()=>{
 for(const change of [(v:any)=>v.reference_outputs.pop(),(v:any)=>v.rubric[1].metadata.score=5,(v:any)=>v.rubric[1].metadata.evaluated_files=['不存在.md'],(v:any)=>v.rubric[1].metadata.project_context={secret:'作者研究'},(v:any)=>v.extra_field='不能静默丢弃']){
  const value=workFixture();change(value);expect(()=>validateDraft(value,materials,'model_report_v1',{contentContract:'work_legal_v1'} as any)).toThrow();
 }
});

test('未命中且未采用的真实检索允许空关联，归档保留未核验状态而不伪造URL',async()=>{
 const raw=workFixture();raw.research_records.push({id:'unused',query:'核查可比案例',source_url:null,source_title:'未取得可采用正文',version:'本次基准日',findings:'未核实到可比裁判，未采用',verification_status:'unverified',supports:[]});
 const value:any=validateDraft(raw,materials,'model_report_v1',{contentContract:'work_legal_v1'});
 expect(value.research_records[1]).toEqual(raw.research_records[1]);
 const {getOrGenerateWorkSimulation}=await import('../publishing/work-simulation');
 const result=await getOrGenerateWorkSimulation({query:async()=>{throw new Error('不得重生成');}} as any,{project_id:'p',workflow_id:'w',title:'测试',question_version:'q',rubric_version:'r',question:value,attachments:[]},'/tmp','a'.repeat(64));
 expect(result.research_entries[1]?.url).toBe('');expect(result.research_entries[1]?.finding).toContain('未核验');
 expect(result.research_entries[1]?.used_in).toContain('未采用');
 const used=structuredClone(value);used.research_records[1].supports=['opinion'];
 await expect(getOrGenerateWorkSimulation({} as any,{project_id:'p',workflow_id:'w',title:'测试',question_version:'q',rubric_version:'r',question:used,attachments:[]},'/tmp','a'.repeat(64))).rejects.toThrow('未核验');
});
test('文件及检索能力需求可以保存完整题目，不由文本 runner 降级',()=>{
 const raw=workFixture();raw.task_requirements={input_mode:'text',output_mode:'file',tools:['web_search']};
 const result:any=validateDraft(raw,materials,'model_report_v1',{contentContract:'work_legal_v1'} as any);
 expect(result.task_requirements).toEqual(raw.task_requirements);
});

test('实际渲染脚本与新Work schema一致，私有研究不进入公开题包',async()=>{
 const {runAuthoring}=await import('./executor');const {mkdtemp,rm,writeFile}=await import('node:fs/promises');const {join}=await import('node:path');const {tmpdir}=await import('node:os');
 const root=await mkdtemp(join(tmpdir(),'work-content-'));try{
  const raw=workFixture();const result=await runAuthoring({root,workspace_path:root,question:'独立Work测试',content_contract:'work_legal_v1',materials:[{id:'a',text:'脱敏材料',sha256:'a'.repeat(64)}],project_context:{source_digest:'b'.repeat(64),files:[{path:'skill/SKILL.md',text:'按Work模板出题'}]},model:'fixture',reasoning_effort:'medium',scoring_policy:{contract:'model_report_v1',rules_text:'按Work规则评分',reference_answer:'none'},execute:async(call:any)=>{
   expect(call.schema.properties).toHaveProperty('reference_outputs');expect(call.schema.properties).not.toHaveProperty('reference_answer');expect(call.prompt).toContain('work_legal_v1');
   expect(call.prompt).not.toContain('不要求被测模型调用外部工具、检索互联网或生成文件');
   const delivery=await Bun.file(join(call.directory,'input/delivery.json')).json();await writeFile(delivery.result_path,JSON.stringify(raw));const child=Bun.spawn(delivery.render_command,{stdout:'pipe',stderr:'pipe'});const err=await new Response(child.stderr).text();expect(err).toBe('');expect(await child.exited).toBe(0);
   return {result:call.validate(raw),session_id:'test',usage:null,duration_ms:1};
  }} as any);expect((result.draft as any).content_contract).toBe('work_legal_v1');expect(result.package_text).not.toContain('核对证据规则');
 }finally{await rm(root,{recursive:true,force:true});}
});

test('作者渲染命令先复用正式校验器，维度错误可在同一会话修正后再保存',async()=>{
 const {runAuthoring}=await import('./executor');const {mkdtemp,rm,writeFile}=await import('node:fs/promises');const {join}=await import('node:path');const {tmpdir}=await import('node:os');
 const root=await mkdtemp(join(tmpdir(),'work-render-validation-'));
 try{
  await runAuthoring({root,workspace_path:root,question:'Work本地修正测试',content_contract:'work_legal_v1',materials:[{id:'a',text:'脱敏材料',sha256:'a'.repeat(64)}],project_context:{source_digest:'b'.repeat(64),files:[{path:'skill/SKILL.md',text:'按Work模板出题'}]},model:'fixture',reasoning_effort:'medium',scoring_policy:{contract:'model_report_v1',rules_text:'依本题规则',reference_answer:'none'},execute:async(call:any)=>{
   const delivery=await Bun.file(join(call.directory,'input/delivery.json')).json(),raw=workFixture();
   const invalid=structuredClone(raw);invalid.rubric[1].id='R3-P09';
   await writeFile(delivery.result_path,JSON.stringify(invalid));
   const rejected=Bun.spawn(delivery.render_command,{stdout:'pipe',stderr:'pipe'});
   const stderr=await new Response(rejected.stderr).text();expect(await rejected.exited).not.toBe(0);expect(stderr).toContain('Rubric ID与维度不一致');
   await writeFile(delivery.result_path,JSON.stringify(raw));
   const accepted=Bun.spawn(delivery.render_command,{stdout:'pipe',stderr:'pipe'});
   expect(await new Response(accepted.stderr).text()).toBe('');expect(await accepted.exited).toBe(0);
   return{result:call.validate(raw),session_id:'fixture',usage:null,duration_ms:1};
  }} as any);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('Work一次返回全部ID维度错配的位置，不泄露判据正文或自动改写ID',()=>{
 const raw=workFixture();raw.rubric[1].id='R3-P09';raw.rubric[2].id='R4-P02';
 let message='';try{validateDraft(raw,materials,'model_report_v1',{contentContract:'work_legal_v1'});}catch(error){message=(error as Error).message;}
 expect(message).toContain('Rubric ID与维度不一致');
 expect(message).toContain('第2项');expect(message).toContain('R3-P09');
 expect(message).toContain('第3项');expect(message).toContain('R4-P02');
 expect(message).toContain('dimension一级=2');expect(message).not.toContain(raw.rubric[1].metadata.statement);
 expect(raw.rubric[1].id).toBe('R3-P09');expect(raw.rubric[2].id).toBe('R4-P02');
});

test('文本作答器允许业务工具要求和文件成果的文字呈现，但拒绝未完成草稿',async()=>{
 const {authoringQuestion}=await import('../answer-models/input');
 const fileTask=workFixture();fileTask.task_requirements.output_mode='file';
 const fileResult=validateDraft(fileTask,materials,'model_report_v1',{contentContract:'work_legal_v1'});
 expect(authoringQuestion({...fileResult,question_version:'v1'}).presentation?.mode).toBe('text_deliverables_v1');
 const toolTask=workFixture();toolTask.task_requirements.tools=['web_search'];
 const toolResult=validateDraft(toolTask,materials,'model_report_v1',{contentContract:'work_legal_v1'});
 expect(authoringQuestion({...toolResult,question_version:'v1'}).question_version).toBe('v1');
 const draft=workFixture();draft.content_status={status:'draft',issues:['核心法源未核验']};
 const draftResult=validateDraft(draft,materials,'model_report_v1',{contentContract:'work_legal_v1'});
 expect(()=>authoringQuestion({...draftResult,question_version:'v1'})).toThrow('Work题目仍为草稿，不能作答');
});

test('评分输入排除Rubric夹带的整题研究信息',async()=>{
 const {buildScoreFiles}=await import('../scoring/executor');
 const value:any={question:'任务',materials:[],answer:'匿名答案',rubric:[{id:'R1',criterion:'判据',rule:'规则',metadata:{statement:'判据',project_context:{research:'不可泄露',target_score:20}}}],reference_answer:'标答'};
 expect(JSON.stringify(buildScoreFiles(value))).not.toContain('不可泄露');
});

test('新Work后续成果直接读取冻结答案，不再调用数据库或模型生成',async()=>{
 const {getOrGenerateWorkSimulation}=await import('../publishing/work-simulation');
 const question:any=validateDraft(workFixture(),materials,'model_report_v1',{contentContract:'work_legal_v1'});
 const result=await getOrGenerateWorkSimulation({query:async()=>{throw new Error('不得读取模型配置');}} as any,{project_id:'p',workflow_id:'w',title:'测试',question_version:'v',rubric_version:'r',question,attachments:[]},'/tmp','a'.repeat(64));
 expect(result.harbor_files).toEqual([{path:'意见.docx',markdown:'完整业务意见正文',sheets:[]}]);expect(result.model).toBe('author_snapshot');expect(result.actual_search_queries).toEqual([]);
});


test('内容契约配置能往返并拒绝未知值，旧配置形状不变',async()=>{
 const {validateWorkflowConfig}=await import('../../shared/workflow-config');
 const existing=validateWorkflowConfig({});expect(existing).not.toHaveProperty('content_contract');
 expect(validateWorkflowConfig({content_contract:'work_legal_v1'})).toHaveProperty('content_contract','work_legal_v1');
 expect(()=>validateWorkflowConfig({content_contract:'unknown'})).toThrow();
});

test('结构化工作表保留数字与布尔，并拒绝缺工作表或错列',()=>{
 const value=workFixture();value.question=value.question.replace('意见.docx','台账.xlsx');value.deliverables[0].path='台账.xlsx';value.deliverables[0].format='xlsx';value.rubric.forEach((r:any)=>r.metadata.evaluated_files=['台账.xlsx']);value.reference_outputs[0].sheets=[{name:'明细',columns:['金额','已核对'],rows:[[100,true]]}];
 const result:any=validateDraft(value,materials,'model_report_v1',{contentContract:'work_legal_v1'});expect(result.reference_outputs[0].sheets[0].rows).toEqual([[100,true]]);
 for(const change of [(v:any)=>v.reference_outputs[0].sheets=[],(v:any)=>v.reference_outputs[0].sheets[0].rows=[[100]]]){const bad=structuredClone(value);change(bad);expect(()=>validateDraft(bad,materials,'model_report_v1',{contentContract:'work_legal_v1'})).toThrow();}
});

test('Work结构门槛分别校验，非法原子能力与缺检索不能被保存为内容完成',()=>{
 for(const change of [(v:any)=>v.rubric[1].id='R2-N01',(v:any)=>v.rubric[1].metadata.atomic_capabilities=['伪造能力名'],(v:any)=>v.research_records=[],(v:any)=>v.rubric[2].metadata.dimension='2-交付物内容质量/Q1事实证据',(v:any)=>v.rubric[1].metadata.priority='Important']){
  const value=workFixture();change(value);expect(()=>validateDraft(value,materials,'model_report_v1',{contentContract:'work_legal_v1'})).toThrow();
 }
});

test('必交成果必须在题面列出精确文件名，不能隐藏新增必交文件',()=>{
 const value=workFixture();value.deliverables.push({id:'research',path:'检索记录.docx',format:'docx',description:'研究轨迹',required:true});
 value.reference_outputs.push({deliverable_id:'research',content:'真实研究记录',sheets:[]});
 expect(()=>validateDraft(value,materials,'model_report_v1',{contentContract:'work_legal_v1'})).toThrow('必交成果未在题面列明');
 value.question+='同时交付检索记录.docx。';
 expect(()=>validateDraft(value,materials,'model_report_v1',{contentContract:'work_legal_v1'})).not.toThrow();
 value.question=value.question.replace('同时交付检索记录.docx。','');value.deliverables[1].required=false;
 expect(()=>validateDraft(value,materials,'model_report_v1',{contentContract:'work_legal_v1'})).not.toThrow();
});
