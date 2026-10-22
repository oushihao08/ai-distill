/** 验证归档项目入口可用隔离合成输入完整生成 Siriser 五件套和 Harbor 六件套预备包。 */
import {test,expect} from 'bun:test';
import {mkdtemp,readdir,readFile,rm,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {harborMapping} from './delivery';

test('Work新结构保留成果必交标志、专业知识和实际工具集合',()=>{
 const q:any={content_contract:'work_legal_v1',delivery_identity:{task_id:'LAW-007',org:'work'},task_metadata:{domain_l2:'测试分类标签',capabilities:['证据评估'],vl_dependency:false,source_note:'测试来源',tools:['文档编辑'],professional_knowledge:['民事证据规则'],target_level:'L2'},deliverables:[{path:'意见.docx',description:'审查意见',required:true},{path:'过程.md',description:'可选过程',required:false}],input_files:[{name:'附件1',description:'卷宗'}]};
 const mapped=harborMapping(q);
 expect(mapped.metadata.deliverables[1]?.required).toBe(false);
 expect(mapped.metadata.domain_knowledge).toBe('民事证据规则');expect(mapped.metadata.tool_set).toEqual(['bash','python']);
 expect(mapped.input_files[0]?.alias).toBe('附件1');
});

test('达标归档交付入口生成五件套、六件套和内部快照',async()=>{
 const root=await mkdtemp(join(tmpdir(),'work-archive-delivery-'));
 try{
  const output=join(root,'成果');
  const harbor={task_id:'LAW-007',org:'work',metadata:{domain_l2:'合同审查',capabilities:'合同风险识别',vl_dependency:'否',source_note:'本题脱敏卷宗',tools:'Word',task_complexity:'L2',tool_set:[],skill_set:[],expected_tool_dependencies:[],expected_skill_dependencies:[],deliverables:[{path:'成果.docx',description:'法律审查意见'}]},input_files:[{path:'材料-001.md',description:'脱敏卷宗正文'}]};
  const input={version:1,project_id:'11111111-1111-4111-8111-111111111111',workflow_id:'22222222-2222-4222-8222-222222222222',title:'合同审查题目',source_digest:'a'.repeat(64),delivery_digest:'b'.repeat(64),question_version:'question-v1',rubric_version:'rubric-v1',question:{task_name:'合同审查',task_type:'F1 法律审查意见',header:{industry_l1:'法律',industry_l2:'合同审查',occupation_l1:'律师',occupation_l2:'合同律师'},question:'请审查本合同并提出法律意见。',attachment_ids:['33333333-3333-4333-8333-333333333333'],rubric:[{id:'R1-P01',criterion:'准确识别合同风险',rule:'结合材料说明风险及依据。',metadata:{statement:'准确识别合同风险并说明依据。',score:3,type:'binary',evaluated_files:['成果.docx'],project_context:{harbor}}}],answer_approach:'核对合同约定和法律依据。',reference_answer:'模拟参考答案。'},acceptance:{decision:'accepted'},attachments:[{id:'33333333-3333-4333-8333-333333333333',sha256:'c'.repeat(64),name:'材料-001.md',text:'合同约定交付日期为2026年10月30日。'}],simulation:{deliverable_type:'F1',deliverable_title:'合同法律审查意见',deliverable_markdown:'# 合同法律审查意见\n\n依据输入材料审查。',harbor_files:[{path:'成果.docx',markdown:'# 合同法律审查意见\n\n依据输入材料审查。',sheets:[]}],research_entries:[{id:'S1',query:'合同编 交付期限',title:'民法典合同编',url:'https://example.test/law',finding:'核对交付期限规则。',version_or_date:'测试数据',used_in:'交付期限分析'}],unresolved:[],generated_at:'2026-10-15T00:00:00.000Z',model:'fixture-model',reasoning_effort:'medium',actual_search_queries:['合同编 交付期限'],actually_opened_urls:['https://example.test/law']}};
  // 合成条目仅验证交付准入，不评价专业原子性。
  input.question.rubric=Array.from({length:30},(_,i)=>({...structuredClone(input.question.rubric[0]!),id:`R2-P${i+1}`}));
  const child=Bun.spawn([process.execPath,join(import.meta.dir,'delivery.ts')],{stdin:'pipe',stdout:'pipe',stderr:'pipe',env:{PATH:process.env.PATH??'',HOME:process.env.HOME??'/tmp',TMPDIR:process.env.TMPDIR??'/tmp',AI_DISTILL_DELIVERY_PARENT_DIR:output}});
  child.stdin.write(JSON.stringify(input));child.stdin.end();
  const [exitCode,stderr]=await Promise.all([child.exited,new Response(child.stderr).text()]);
  const entries=await readdir(output).catch(()=>[]);
  expect(exitCode,`${stderr}\noutput entries: ${entries.join(', ')}`).toBe(0);
  const harborRoot=join(output,'Harbor六件套','LAW-007'),fiveRoot=join(output,'Siriser五件套');
  expect((await readdir(harborRoot)).sort()).toEqual(['environment','instruction.md','rubrics.json','solution','task.toml','tests']);
  expect((await readdir(join(harborRoot,'solution/golden_output'))).sort()).toEqual(['成果.docx']);
  const styles=Bun.spawn(['unzip','-p',join(harborRoot,'solution/golden_output/成果.docx'),'word/styles.xml'],{stdout:'pipe',stderr:'pipe'});
  expect(await new Response(styles.stdout).text()).toContain('宋体');expect(await styles.exited).toBe(0);
  expect((await readdir(join(fiveRoot,(await readdir(fiveRoot))[0]!))).sort()).toEqual(['golden_output','input_files','任务说明.docx','评分要点.xlsx','题目信息表.docx']);
  expect((await readdir(join(fiveRoot,(await readdir(fiveRoot))[0]!,'golden_output'))).sort()).toEqual(['成果.docx','主成果.docx','模拟生成记录.md','法规案例检索轨迹.xlsx'].sort());
  const status=JSON.parse(await readFile(join(output,'Harbor六件套','状态','LAW-007.json'),'utf8')) as {submission_ready:boolean};
  expect(status.submission_ready).toBe(false);
  for(const path of ['题目快照.json','交付缺口.md'])expect(await stat(join(output,path))).toBeTruthy();
  const previous=await readFile(join(output,'题目快照.json'),'utf8');
  const next={...input,source_digest:'d'.repeat(64),delivery_digest:'e'.repeat(64)};
  const again=Bun.spawn([process.execPath,join(import.meta.dir,'delivery.ts')],{stdin:'pipe',stdout:'pipe',stderr:'pipe',env:{PATH:process.env.PATH??'',HOME:process.env.HOME??'/tmp',TMPDIR:process.env.TMPDIR??'/tmp',AI_DISTILL_DELIVERY_PARENT_DIR:output}});
  again.stdin.write(JSON.stringify(next));again.stdin.end();
  expect(await again.exited).toBe(0);
  expect(JSON.parse(await readFile(join(output,'题目快照.json'),'utf8')).source_digest).toBe(next.source_digest);
  const history=await readdir(join(output,'快照历史'));
  expect(history.length).toBeGreaterThanOrEqual(2);
  expect(await Promise.all(history.map(name=>readFile(join(output,'快照历史',name),'utf8')))).toContain(previous);

 }finally{await rm(root,{recursive:true,force:true});}
});
