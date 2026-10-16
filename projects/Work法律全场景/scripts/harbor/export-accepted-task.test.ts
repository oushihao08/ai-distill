/**
 * 职责：验证 Harbor 单题导出器的必填输入校验、Rubric 无损转换和六件套结构。
 * 主要验证：缺少固定脚本、专家成果、元数据或不可转换评分项时拒绝写包；完整输入生成一致目录且不伪报验收。
 */
import {test,expect} from 'bun:test';
import {chmod,mkdtemp,readFile,readdir,writeFile,rm,stat,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {exportAcceptedTask} from './export-accepted-task.ts';

const required=['instruction.md','task.toml','rubrics.json','environment/Dockerfile','environment/requirements.txt','solution/solve.sh','tests/test.sh','tests/finalize.py','tests/rubrics.toml','tests/prompt.md'];
const prompt=`[Material map]\n/app/output /app/input_files /tests/__golden_output\n[Fairness anchor]\nKeep the project fairness anchor here.\n[Reference-solution policy]\nNever award points because the reference satisfies a criterion.\nNever deduct for differing from the reference.\n[Tool usage]\nmarkitdown openpyxl python-docx python-pptx pypdf. No network access.\n{criteria}\n`;
const metadata={org:'work',domain_l2:'待补充场景登记值',capabilities:'合同审核与风险识别',vl_dependency:'否' as const,source_note:'来源和真实性保障见项目核验记录；AI 模拟成果',tools:'Word',task_complexity:'L2' as const,tool_set:['bash','python'],skill_set:[],expected_tool_dependencies:[],expected_skill_dependencies:[],deliverables:[{path:'专家备忘录.docx',description:'专家模拟交付物'}]};
const rubric=[{id:'R1-P01',criterion:'核对主体',rule:'主体身份与输入材料一致。',metadata:{statement:'核对合同主体名称与输入材料一致。',score:3,type:'binary',evaluated_files:['专家备忘录.docx'],trigger_count:null}}];

async function makeInputs(root:string){
 const official=join(root,'official'),attachment=join(root,'案卷.docx'),golden=join(root,'专家备忘录.docx');
 await mkdir(official,{recursive:true});
 await writeFile(join(official,'test.sh'),await readFile(join(import.meta.dir,'official/tests/test.sh')));
 await writeFile(join(official,'finalize.py'),await readFile(join(import.meta.dir,'official/tests/finalize.py')));
 await chmod(join(official,'test.sh'),0o755);
 await writeFile(attachment,'input');await writeFile(golden,'golden');
 return{official,attachment,golden};
}

test('缺少固定脚本时失败且不留下题包',async()=>{
 const root=await mkdtemp(join(tmpdir(),'work-export-missing-'));
 try{
  const {attachment,golden}=await makeInputs(root);
  await expect(exportAcceptedTask({outputDirectory:root,taskId:'LAW-007',title:'题目',instruction:'任务',rubric,metadata,attachments:[{relativePath:'案卷.docx',sourcePath:attachment,description:'合同正文'}],goldenFiles:[{relativePath:'专家备忘录.docx',sourcePath:golden}],judgePromptTemplate:prompt})).rejects.toThrow('缺少官方固定脚本');
  expect(await readdir(root)).not.toContain('LAW-007');
 }finally{await rm(root,{recursive:true,force:true});}
});

test('缺少专家成果时失败且不留下完整题包',async()=>{
 const root=await mkdtemp(join(tmpdir(),'work-export-golden-'));
 try{
  const {official,attachment}=await makeInputs(root);
  await expect(exportAcceptedTask({outputDirectory:root,taskId:'LAW-007',title:'题目',instruction:'任务',rubric,metadata,attachments:[{relativePath:'案卷.docx',sourcePath:attachment,description:'合同正文'}],goldenFiles:[],officialTestSh:join(official,'test.sh'),officialFinalizePy:join(official,'finalize.py'),judgePromptTemplate:prompt})).rejects.toThrow('缺少专家交付物');
  expect(await readdir(root)).not.toContain('LAW-007');
 }finally{await rm(root,{recursive:true,force:true});}
});

test('固定脚本、成果、元数据齐备时写出结构一致且不伪报通过的题包',async()=>{
 const root=await mkdtemp(join(tmpdir(),'work-export-ok-'));
 try{
  const {official,attachment,golden}=await makeInputs(root);
  const input={outputDirectory:root,taskId:'LAW-007',title:'题目',instruction:'完成合同审查。',rubric,metadata,attachments:[{relativePath:'案卷.docx',sourcePath:attachment,description:'合同正文'}],goldenFiles:[{relativePath:'专家备忘录.docx',sourcePath:golden}],officialTestSh:join(official,'test.sh'),officialFinalizePy:join(official,'finalize.py'),judgePromptTemplate:prompt};
  const first=await exportAcceptedTask(input),second=await exportAcceptedTask(input);
  expect(second.directory).toBe(first.directory);
  for(const path of required)expect(await stat(join(first.directory,path))).toBeTruthy();
  expect((await readdir(join(first.directory,'environment/input_files')))).toEqual(['案卷.docx']);
  const sha=async(path:string)=>createHash('sha256').update(await readFile(path)).digest('hex');
  expect(await sha(join(first.directory,'solution/golden_output/专家备忘录.docx'))).toBe(await sha(join(first.directory,'tests/__golden_output/专家备忘录.docx')));
  expect(await sha(join(first.directory,'tests/test.sh'))).toBe(await sha(join(official,'test.sh')));
  const instruction=await readFile(join(first.directory,'instruction.md'),'utf8');
  const taskToml=await readFile(join(first.directory,'task.toml'),'utf8');
  const rubricsToml=await readFile(join(first.directory,'tests/rubrics.toml'),'utf8');
  expect(instruction).toContain('/app/input_files/案卷.docx：合同正文');
  expect(taskToml).toContain('domain_l2 = "待补充场景登记值"');
  expect(taskToml).toContain('path = "专家备忘录.docx"');
  expect(taskToml).not.toContain('/logs/');
  expect(rubricsToml).toContain('Deliverables to inspect: output/专家备忘录.docx');
  const status=JSON.parse(await readFile(first.statusPath,'utf8')) as {oracle_score:unknown;model_mean:unknown;platform_accepted:unknown;note:string};
  expect(status.oracle_score).toBeNull();expect(status.model_mean).toBeNull();expect(status.platform_accepted).toBeNull();expect(status.note).toContain('不是通过');
 }finally{await rm(root,{recursive:true,force:true});}
});

test('无损转换不了的否决和累计扣分规则拒绝导出',async()=>{
 const root=await mkdtemp(join(tmpdir(),'work-export-rubric-'));
 try{
  const {official,attachment,golden}=await makeInputs(root);
  const base={outputDirectory:root,taskId:'LAW-007',title:'题目',instruction:'任务',metadata,attachments:[{relativePath:'案卷.docx',sourcePath:attachment,description:'合同正文'}],goldenFiles:[{relativePath:'专家备忘录.docx',sourcePath:golden}],officialTestSh:join(official,'test.sh'),officialFinalizePy:join(official,'finalize.py'),judgePromptTemplate:prompt};
  await expect(exportAcceptedTask({...base,rubric:[{id:'R0-V01',criterion:'否决',metadata:{statement:'独立否决',score:null,priority:'Veto'}}]})).rejects.toThrow('独立否决项');
  await expect(exportAcceptedTask({...base,rubric:[{id:'R1-N01',criterion:'累计扣分',metadata:{statement:'累计扣分项',score:-3,type:'binary',evaluated_files:['专家备忘录.docx'],trigger_count:'可累计，无封顶'}}]})).rejects.toThrow('累计扣分规则');
  expect(await readdir(root)).not.toContain('LAW-007');
 }finally{await rm(root,{recursive:true,force:true});}
});


test('出题可缺省的外部登记身份仍在Harbor导出时严格校验',async()=>{
 const root=await mkdtemp(join(tmpdir(),'work-export-identity-'));
 try{
  const {official,attachment,golden}=await makeInputs(root);
  const base={outputDirectory:root,taskId:'LAW-007',title:'题目',instruction:'任务',rubric,metadata,attachments:[{relativePath:'案卷.docx',sourcePath:attachment,description:'合同正文'}],goldenFiles:[{relativePath:'专家备忘录.docx',sourcePath:golden}],officialTestSh:join(official,'test.sh'),officialFinalizePy:join(official,'finalize.py'),judgePromptTemplate:prompt};
  await expect(exportAcceptedTask({...base,taskId:''})).rejects.toThrow();
  await expect(exportAcceptedTask({...base,metadata:{...metadata,org:''}})).rejects.toThrow();
  expect(await readdir(root)).not.toContain('LAW-007');
 }finally{await rm(root,{recursive:true,force:true});}
});

test('可选成果不被改为必交，原始Rubric按正式字段平铺输出',async()=>{
 const root=await mkdtemp(join(tmpdir(),'work-export-fields-'));
 try{
  const {official,attachment,golden}=await makeInputs(root),optional=join(root,'过程记录.md');await writeFile(optional,'可选过程记录');
  const result=await exportAcceptedTask({outputDirectory:root,taskId:'LAW-008',title:'题目',instruction:'依据附件1完成专家备忘录。',rubric,metadata:{...metadata,deliverables:[...metadata.deliverables,{path:'过程记录.md',description:'可选过程记录',required:false}]},attachments:[{relativePath:'案卷.docx',sourcePath:attachment,description:'合同正文',alias:'附件1'}],goldenFiles:[{relativePath:'专家备忘录.docx',sourcePath:golden},{relativePath:'过程记录.md',sourcePath:optional}],officialTestSh:join(official,'test.sh'),officialFinalizePy:join(official,'finalize.py'),judgePromptTemplate:prompt});
  const task=await readFile(join(result.directory,'task.toml'),'utf8');
  expect(task).toContain('path = "过程记录.md"\nrequired = false');
  expect(task.split('\n').find(line=>line.startsWith('artifacts ='))).toBe('artifacts = ["/app/output/专家备忘录.docx"]');
  const raw=JSON.parse(await readFile(join(result.directory,'rubrics.json'),'utf8'));
  expect(raw[0].statement).toBe(rubric[0].metadata.statement);expect(raw[0]).not.toHaveProperty('metadata');expect(raw[0]).not.toHaveProperty('criterion');
  const instruction=await readFile(join(result.directory,'instruction.md'),'utf8');
  expect(instruction).toContain('附件1：/app/input_files/案卷.docx');expect(instruction).toContain('/app/output/过程记录.md');
 }finally{await rm(root,{recursive:true,force:true});}
});
