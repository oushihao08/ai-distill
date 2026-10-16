/**
 * 职责：将已冻结的题面、完整 Harbor 元数据、脱敏材料和模拟／核定成果组装成单题六件套。
 * 关键入口：`exportAcceptedTask()` 生成可审查题目目录；遇到不能无损表达的 Rubric 或元数据缺口时拒绝写包。
 * 使用场景：由 Work 项目归档入口在资料齐全时生成内部预备包；脚本不生成法律结论，也不代表 Oracle、模型或平台验收通过。
 */
import {createHash,randomUUID} from 'node:crypto';
import {chmod,lstat,mkdir,readdir,readFile,rename,rm,writeFile} from 'node:fs/promises';
import {isAbsolute,join,resolve} from 'node:path';
import {WORK_RUBRIC_FIELDS} from '../../../../server/authoring/work-contract';

export interface ExportFile {relativePath:string;sourcePath:string;description?:string;alias?:string}
export interface HarborDeliverable {path:string;description:string;required?:boolean}
export interface HarborTaskMetadata {
 org:string;
 domain_l2:string;
 capabilities:string;
 vl_dependency:'是'|'否';
 source_note:string;
 tools:string;
 task_complexity:'L2'|'L3'|'L4'|'L5';
 tool_set:string[];
 skill_set:string[];
 expected_tool_dependencies:string[];
 expected_skill_dependencies:string[];
 domain_knowledge?:string;
 expected_pass_rate?:number;
 agent_timeout_sec?:number;
 verifier_env?:Record<string,string>;
 environment?:{os?:string;allowed_hosts?:string[];build_timeout_sec?:number;docker_image?:string;cpus?:number;memory_mb?:number;storage_mb?:number;env?:Record<string,string>;healthcheck?:Record<string,string|number|boolean|string[]>};
 deliverables:HarborDeliverable[];
}
export interface ExportAcceptedTaskInput {
 outputDirectory:string;taskId:string;title:string;instruction:string;rubric:unknown;
 metadata?:HarborTaskMetadata;attachments:ExportFile[];goldenFiles:ExportFile[];
 officialTestSh?:string;officialFinalizePy?:string;judgePromptTemplate?:string;
}
export interface ExportAcceptedTaskResult {directory:string;statusPath:string}
/** 与本导出器Dockerfile预装的执行入口对应；不包含作者Skill。 */
export const HARBOR_TOOL_SET=['bash','python'] as const;

const taskIdPattern=/^LAW-\d{3,}$/;
const allowedWeights=new Set([3,7,10]);
const sha=(value:Uint8Array|string)=>createHash('sha256').update(value).digest('hex');
const pageCodeBlockDigests={
 'tests/test.sh':'6f5ae2143066893f5f3270023b82b4126a8ec65699f4397606e85a1290349119',
 'tests/finalize.py':'33f01df3f44dad8a1f986185e9426a0758802313d100d25cf4fe53c771bccc67',
} as const;
const tomlString=(value:string)=>JSON.stringify(value);
const tomlArray=(values:string[])=>`[${values.map(tomlString).join(', ')}]`;

function assertRelative(path:string){
 if(!path||Buffer.byteLength(path,'utf8')>200||path.includes('\\')||path.startsWith('/')||path.split('/').some(part=>!part||part==='.'||part==='..')||/[\u0000-\u001f\u007f]/.test(path))throw new Error(`交付文件名无效：${path}`);
}

async function readRegular(path:string|undefined,label:string):Promise<Uint8Array>{
 if(!path||!path.trim())throw new Error(`缺少官方固定脚本：${label}`);
 if(path.includes('页面转录'))throw new Error('页面转录不能充当已核验的官方固定脚本');
 const info=await lstat(path).catch(()=>{throw new Error(`缺少官方固定脚本：${label}`);});
 if(!info.isFile()||info.isSymbolicLink()||info.size===0)throw new Error(`缺少官方固定脚本：${label}`);
 const bytes=await readFile(path);
 const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
 if(text.includes('\r')||text.includes('\0'))throw new Error(`官方固定脚本 ${label} 必须是 UTF-8 且使用 LF`);
 return bytes;
}

async function readSourceFile(item:ExportFile,label:string){
 const info=await lstat(item.sourcePath).catch(()=>{throw new Error(`${label}不存在：${item.relativePath}`);});
 if(info.isSymbolicLink()||!info.isFile())throw new Error(`${label}必须是普通文件：${item.relativePath}`);
 const bytes=await readFile(item.sourcePath);
 if(!bytes.byteLength)throw new Error(`${label}为空：${item.relativePath}`);
 return bytes;
}

function validateMetadata(metadata:HarborTaskMetadata|undefined,taskId:string,goldenPaths:string[]){
 if(!metadata)throw new Error('Harbor 元数据缺失：需要从题目 project_context 显式映射完整 metadata');
 if(typeof metadata.org!=='string'||!/^[a-z0-9][a-z0-9-]{1,31}$/.test(metadata.org))throw new Error('Harbor 元数据 org 必须是已确认的小写平台组织代号');
 for(const [key,value] of Object.entries({domain_l2:metadata.domain_l2,capabilities:metadata.capabilities,source_note:metadata.source_note,tools:metadata.tools}))if(typeof value!=='string'||!value.trim())throw new Error(`Harbor 必填元数据缺失：${key}`);
 if(!['是','否'].includes(metadata.vl_dependency))throw new Error('Harbor 元数据 vl_dependency 必须为“是”或“否”');
 if(!['L2','L3','L4','L5'].includes(metadata.task_complexity))throw new Error('Harbor 元数据 task_complexity 必须为 L2–L5');
 for(const key of ['tool_set','skill_set','expected_tool_dependencies','expected_skill_dependencies'] as const){
  const list=metadata[key];
  if(!Array.isArray(list)||list.some(item=>typeof item!=='string'||!item.trim())||new Set(list).size!==list.length)throw new Error(`Harbor 元数据 ${key} 必须是无重复字符串数组`);
 }
 if(metadata.skill_set.length)throw new Error('Harbor skill_set 非空，但归档输入未提供对应的 environment/skills 原件；拒绝生成不完整题包');
 if(metadata.expected_tool_dependencies.some(item=>!metadata.tool_set.includes(item))||metadata.expected_skill_dependencies.some(item=>!metadata.skill_set.includes(item)))throw new Error('Harbor 必要工具／Skill 依赖必须是实际提供集合的子集');
 if(metadata.expected_pass_rate!==undefined&&(!Number.isFinite(metadata.expected_pass_rate)||metadata.expected_pass_rate<0||metadata.expected_pass_rate>1))throw new Error('Harbor 元数据 expected_pass_rate 必须在 0–1');
 if(metadata.agent_timeout_sec!==undefined&&(!Number.isInteger(metadata.agent_timeout_sec)||metadata.agent_timeout_sec<=0))throw new Error('Harbor 元数据 agent_timeout_sec 无效');
 if(!metadata.deliverables.length)throw new Error('Harbor deliverables 不能为空');
 const paths=metadata.deliverables.map(item=>item.path);
 for(const item of metadata.deliverables){assertRelative(item.path);if(typeof item.description!=='string'||!item.description.trim())throw new Error(`Harbor deliverable 缺少说明：${item.path}`);if(item.required!==undefined&&typeof item.required!=='boolean')throw new Error('Harbor required 必须为布尔');}
 if(!metadata.deliverables.some(item=>item.required!==false))throw new Error('Harbor 至少需要一份必交成果');
 if(new Set(paths).size!==paths.length||JSON.stringify([...paths].sort())!==JSON.stringify([...goldenPaths].sort()))throw new Error('task.toml deliverables 必须与两份 golden 的相对路径完全一致');
 if(!taskIdPattern.test(taskId))throw new Error('Harbor task_id 无效');
 if(metadata.environment?.cpus!==undefined&&metadata.environment.cpus<=0)throw new Error('Harbor environment.cpus 必须大于 0');
 for(const key of ['memory_mb','storage_mb','build_timeout_sec'] as const)if(metadata.environment?.[key]!==undefined&&(!Number.isInteger(metadata.environment[key])||metadata.environment[key]!<=0))throw new Error(`Harbor environment.${key} 必须为正整数`);
 for(const key of Object.keys(metadata.environment?.env??{}))if(/^JUDGE_/i.test(key)||/KEY|TOKEN|SECRET|PASSWORD/i.test(key))throw new Error(`Harbor 候选环境变量不得包含评分变量或凭据：${key}`);
 for(const [key,value] of Object.entries(metadata.verifier_env??{})){
  if(!['JUDGE_API_KEY','JUDGE_BASE_URL','JUDGE_MODEL','JUDGE_PROVIDER','JUDGE_API_PROTOCOL','LITELLM_DROP_PARAMS','EVAL_API_KEY','EVAL_API_BASE'].includes(key))throw new Error(`Harbor verifier.env 包含未核对的变量：${key}`);
  if(/(API_KEY|BASE_URL)$/.test(key)&&value&&!/^\$\{(?:JUDGE|EVAL)_/.test(value))throw new Error(`Harbor verifier.env ${key} 不得写入真实凭据或地址`);
  if(['JUDGE_MODEL','JUDGE_PROVIDER','JUDGE_API_PROTOCOL','LITELLM_DROP_PARAMS'].includes(key)&&!/^\$\{[A-Z0-9_]+:-.+\}$/.test(value))throw new Error(`Harbor verifier.env ${key} 必须保留默认值表达式`);
 }
 for(const [key,value] of Object.entries(metadata.verifier_env??{})){
  if(!['JUDGE_API_KEY','JUDGE_BASE_URL','JUDGE_MODEL','JUDGE_PROVIDER','JUDGE_API_PROTOCOL','LITELLM_DROP_PARAMS','EVAL_API_KEY','EVAL_API_BASE'].includes(key))throw new Error(`Harbor verifier.env 包含未核对的变量：${key}`);
  if(/(API_KEY|BASE_URL)$/.test(key)&&value&&!/^\$\{(?:JUDGE|EVAL)_/.test(value))throw new Error(`Harbor verifier.env ${key} 不得写入真实凭据或地址`);
 }
}

interface Criterion {id:string;description:string;type:'binary'|'likert';weight:number;negate:boolean;points?:5}
function mapRubric(rubric:unknown,paths:string[]):Criterion[]{
 if(!Array.isArray(rubric)||!rubric.length)throw new Error('Rubric 为空，不能生成 Harbor 评分器');
 const ids=new Set<string>();
 const mapped=rubric.map((value,index)=>{
  if(!value||typeof value!=='object')throw new Error(`Rubric 第 ${index+1} 项无效`);
  const row=value as Record<string,unknown>,metadata=row.metadata&&typeof row.metadata==='object'?row.metadata as Record<string,unknown>:{};
  const id=typeof row.id==='string'?row.id.trim():'';
  const statement=typeof metadata.statement==='string'?metadata.statement:typeof row.statement==='string'?row.statement:typeof row.criterion==='string'?row.criterion:'';
  const rawType=metadata.type;
  const score=metadata.score;
  if(!id||ids.has(id)||!statement.trim())throw new Error(`Rubric 第 ${index+1} 项缺少唯一 ID 或完整 statement`);
  ids.add(id);
 if(score===null||metadata.priority==='Veto')throw new Error(`Rubric ${id} 是独立否决项；Harbor 当前评分输出没有经确认的无损承载方式，拒绝导出`);
  if(typeof score!=='number'||!Number.isFinite(score)||!allowedWeights.has(Math.abs(score)))throw new Error(`Rubric ${id} 的 score 必须是 ±3、±7 或 ±10`);
  if(rawType!=='binary'&&rawType!=='likert')throw new Error(`Rubric ${id} 的 metadata.type 必须是 binary 或 likert`);
  const type:Criterion['type']=rawType;
  const trigger=metadata.trigger_count;
  if(typeof trigger==='string'&&/可累计|无封顶|累计/.test(trigger))throw new Error(`Rubric ${id} 有累计扣分规则，当前 Harbor 转换会改变计分，需先明确映射口径`);
  const evaluated=metadata.evaluated_files;
  const criterionPaths=Array.isArray(evaluated)&&!evaluated.includes('all')?evaluated.filter((name):name is string=>typeof name==='string'):paths;
  if(!criterionPaths.length||criterionPaths.some(path=>!paths.includes(path)))throw new Error(`Rubric ${id} 的 evaluated_files 未映射到 golden 文件`);
  const rule=typeof row.rule==='string'?row.rule.trim():'';
  const description=[statement.trim(),rule&&rule!==statement.trim()?`判定与计分规则：${rule}`:'',type==='likert'?'按 metadata.statement／rule 中列明的 5／4／3／2／1 锚点评分，不得自行补档。':'',`Deliverables to inspect: ${criterionPaths.map(path=>`output/${path}`).join(', ')}`].filter(Boolean).join('\n\n');
  if(type==='likert'&&!/5[／/|]4[／/|]3[／/|]2[／/|]1/.test(description))throw new Error(`Rubric ${id} 是 likert，但完整 5/4/3/2/1 档位未出现在判据中`);
  return{id,description,type,weight:Math.abs(score),negate:score<0,...(type==='likert'?{points:5 as const}:{})};
 });
 if(!mapped.some(item=>!item.negate))throw new Error('Harbor 主分至少需要一项正向 Rubric');
 return mapped;
}

function renderTaskToml(input:ExportAcceptedTaskInput,metadata:HarborTaskMetadata,criteria:Criterion[],goldenPaths:string[]){
 const deliverables=metadata.deliverables.map(item=>[
  '[[metadata.deliverables]]',`path = ${tomlString(item.path)}`,`required = ${item.required!==false}`,`desc = ${tomlString(item.description)}`,
 ].join('\n')).join('\n\n');
 const env=metadata.environment??{};
 const environmentLines=[
  '[environment]',...(env.os?[`os = ${tomlString(env.os)}`]:[]),'network_mode = "public"',
  ...(env.allowed_hosts? [`allowed_hosts = ${tomlArray(env.allowed_hosts)}`]:[]),
  ...(env.build_timeout_sec!==undefined?[`build_timeout_sec = ${env.build_timeout_sec}`]:[]),
  ...(env.docker_image?[`docker_image = ${tomlString(env.docker_image)}`]:[]),
  `cpus = ${env.cpus??2}`,`memory_mb = ${env.memory_mb??8192}`,`storage_mb = ${env.storage_mb??30720}`,
  ...(env.env&&Object.keys(env.env).length?['','[environment.env]',...Object.entries(env.env).map(([key,value])=>`${key} = ${tomlString(value)}`)]:[]),
  ...(env.healthcheck&&Object.keys(env.healthcheck).length?['','[environment.healthcheck]',...Object.entries(env.healthcheck).map(([key,value])=>`${key} = ${typeof value==='string'?tomlString(value):JSON.stringify(value)}`)]:[]),
 ].join('\n');
 const verifierEnv={JUDGE_API_KEY:'${JUDGE_API_KEY}',JUDGE_BASE_URL:'${JUDGE_BASE_URL}',JUDGE_MODEL:'${JUDGE_MODEL:-GPT-5.5}',JUDGE_PROVIDER:'${JUDGE_PROVIDER:-anthropic}',JUDGE_API_PROTOCOL:'${JUDGE_API_PROTOCOL:-anthropic}',LITELLM_DROP_PARAMS:'${LITELLM_DROP_PARAMS:-true}',...metadata.verifier_env};
 const verifierEnvText=['[verifier.env]',...Object.entries(verifierEnv).map(([key,value])=>`${key} = ${tomlString(value)}`)].join('\n');
 const taskToml=[
  'schema_version = "1.4"',`artifacts = ${tomlArray(metadata.deliverables.filter(item=>item.required!==false).map(item=>`/app/output/${item.path}`))}`,'',
  '[task]',`name = ${tomlString(`${metadata.org}/${input.taskId}`)}`,'version = "1.0.0"',`description = ${tomlString(input.title.trim())}`,
  `keywords = ${tomlArray(['LAW','office',metadata.task_complexity])}`,'',
  '[metadata]',`task_id = ${tomlString(input.taskId)}`,'domain = "法律"',`domain_l2 = ${tomlString(metadata.domain_l2)}`,
  `capabilities = ${tomlString(metadata.capabilities)}`,`vl_dependency = ${tomlString(metadata.vl_dependency)}`,
  `source_note = ${tomlString(metadata.source_note)}`,`tools = ${tomlString(metadata.tools)}`,
  ...(metadata.domain_knowledge?.trim()?[`domain_knowledge = ${tomlString(metadata.domain_knowledge)}`]:[]),
  `task_complexity = ${tomlString(metadata.task_complexity)}`,`tool_set = ${tomlArray(metadata.tool_set)}`,
  `skill_set = ${tomlArray(metadata.skill_set)}`,`expected_tool_dependencies = ${tomlArray(metadata.expected_tool_dependencies)}`,
  `expected_skill_dependencies = ${tomlArray(metadata.expected_skill_dependencies)}`,
  ...(metadata.expected_pass_rate!==undefined?[`expected_pass_rate = ${metadata.expected_pass_rate}`]:[]),
  '',deliverables,'','[agent]',`timeout_sec = ${metadata.agent_timeout_sec??72000}`,'',
  '[verifier]','timeout_sec = 18000.0','user = "root"','',verifierEnvText,'',environmentLines,'',
 ].join('\n');
 return{taskToml,criteria};
}

const dockerfile=[
 'FROM python:3.12-slim','',
 'RUN useradd -m -u 1000 agent','',
 'RUN apt-get update && apt-get install -y --no-install-recommends \\',
 '        ca-certificates curl git bash jq ripgrep unzip nodejs npm \\',
 '        libreoffice-calc libreoffice-writer fonts-noto-cjk \\',
 '    && rm -rf /var/lib/apt/lists/*','',
 'RUN npm install -g @anthropic-ai/claude-code@2.1.114 \\',
 '    && mkdir -p /root/.local/bin \\',
 '    && ln -sf "$(which claude)" /root/.local/bin/claude \\',
 '    && claude --version | grep -Fq 2.1.114','',
 'RUN pip install --no-cache-dir \\',
 '        "harbor-rewardkit[all]==0.1.7" markitdown \\',
 '        openpyxl pandas python-docx pypdf python-pptx PyYAML chardet matplotlib','',
 'COPY requirements.txt /tmp/requirements.txt',
 'RUN pip install --no-cache-dir -r /tmp/requirements.txt','',
 'COPY input_files/ /app/input_files/',
 'RUN chown -R root:root /app/input_files && chmod -R a-w /app/input_files','',
 'WORKDIR /app',
 'RUN mkdir -p /app/output && chown -R agent:agent /app/output','',
 'USER agent','',
 ].join('\n');

/** 校验输入后原子写入题目目录；只有结构、字段与评分转换均可追溯时才生成。 */
export async function exportAcceptedTask(input:ExportAcceptedTaskInput):Promise<ExportAcceptedTaskResult>{
 if(!taskIdPattern.test(input.taskId))throw new Error('题目目录编号无效');
 if(!input.outputDirectory||!isAbsolute(input.outputDirectory))throw new Error('导出目录无效');
 if(!input.instruction.trim()||!Array.isArray(input.rubric)||input.rubric.length===0)throw new Error('题目快照不完整');
 if(!input.attachments.length)throw new Error('缺少可复制的已有附件');
 const officialTest=await readRegular(input.officialTestSh,'tests/test.sh');
 const officialFinalize=await readRegular(input.officialFinalizePy,'tests/finalize.py');
 if(sha(officialTest)!==pageCodeBlockDigests['tests/test.sh']||sha(officialFinalize)!==pageCodeBlockDigests['tests/finalize.py'])throw new Error('Harbor 固定评分脚本与当前规范页面代码块摘要不一致');
 if(!input.goldenFiles.length)throw new Error('缺少专家交付物：快照没有可直接复制的专家文件');
 const judgePrompt=input.judgePromptTemplate;
 if(!judgePrompt||!judgePrompt.includes('{criteria}')||!/^\s*\[Material map\]/mi.test(judgePrompt)||!/^\s*\[Fairness anchor\][\s\S]+?\[Reference-solution policy\]/mi.test(judgePrompt)||!judgePrompt.includes('Never award points because the reference satisfies a criterion')||!judgePrompt.includes('Never deduct for differing from the reference')||!/^\s*\[Tool usage/m.test(judgePrompt)||!judgePrompt.includes('markitdown')||!judgePrompt.includes('openpyxl')||!judgePrompt.includes('No network access'))throw new Error('Harbor Judge prompt 模板不完整：必须提供项目确认的完整 Fairness、Material map、Reference policy 和工具提示模板');
 const goldenBytes=await Promise.all(input.goldenFiles.map(async item=>{
  assertRelative(item.relativePath);const bytes=await readSourceFile(item,'专家交付物');
  return{path:item.relativePath,bytes};
 }));
 const goldenPaths=goldenBytes.map(item=>item.path);
 if(new Set(goldenPaths).size!==goldenPaths.length)throw new Error('专家交付物路径重复');
 validateMetadata(input.metadata,input.taskId,goldenPaths);
 const criteria=mapRubric(input.rubric,goldenPaths);
 const attachmentBytes=await Promise.all(input.attachments.map(async item=>{
  assertRelative(item.relativePath);
  if(typeof item.description!=='string'||!item.description.trim())throw new Error(`输入材料缺少内容／字段／口径说明：${item.relativePath}`);
  const bytes=await readSourceFile(item,'输入材料');
  if(item.alias!==undefined&&(typeof item.alias!=='string'||!item.alias.trim()||/[\r\n]/.test(item.alias)))throw new Error('输入材料别名无效');
  return{path:item.relativePath,description:item.description.trim(),alias:item.alias,bytes};
 }));
 if(new Set(attachmentBytes.map(item=>item.path)).size!==attachmentBytes.length)throw new Error('输入材料路径重复');
 const metadata=input.metadata!;
 const instruction=['# 任务书','',input.instruction.trim(),'','## 可使用的源文件',...attachmentBytes.map(item=>`- ${item.alias?`${item.alias}：`:''}/app/input_files/${item.path}：${item.description}`),'','## 交付清单','成果写入 /app/output/；以下文件名和必交标志为任务固定要求。',...metadata.deliverables.map(item=>`- /app/output/${item.path}（${item.required===false?'可选':'必交'}）：${item.description}`),''].join('\n');
 const {taskToml}=renderTaskToml(input,metadata,criteria,goldenPaths);
 const rubricsToml=[
  '[judge]','judge = "claude-code"','prompt_template = "prompt.md"','model = "GPT-5.5"','timeout = 7200','mode = "individual"','weight = 1.0','',
  ...criteria.flatMap(item=>[
   '[[criterion]]',`id = ${tomlString(item.id)}`,`name = ${tomlString(item.id)}`,`description = ${tomlString(item.description)}`,
   `type = ${tomlString(item.type)}`,...(item.points?[`points = ${item.points}`]:[]),`weight = ${item.weight}.0`,...(item.negate?['negate = true']:[]),'',
  ]),'[scoring]','aggregation = "weighted_mean"','',
 ].join('\n');
 if(Buffer.byteLength(judgePrompt,'utf8')+criteria.reduce((sum,item)=>sum+Buffer.byteLength(item.description,'utf8'),0)>=100_000)throw new Error('prompt.md 与全部 criterion description 总量达到或超过 100 KB');
 if(Buffer.byteLength(instruction,'utf8')>1024*1024||Buffer.byteLength(taskToml,'utf8')>1024*1024)throw new Error('instruction.md 或 task.toml 超过 1 MiB');
 if(Buffer.byteLength(rubricsToml,'utf8')>2*1024*1024)throw new Error('tests/rubrics.toml 超过 2 MiB');
 const solve='#!/bin/bash\nset -euo pipefail\nmkdir -p /app/output\ncp -R /solution/golden_output/. /app/output/\n';
 const totalBytes=[...attachmentBytes,...goldenBytes,...goldenBytes].reduce((sum,item)=>sum+item.bytes.byteLength,0)+officialTest.byteLength+officialFinalize.byteLength+Buffer.byteLength(instruction)+Buffer.byteLength(taskToml)+Buffer.byteLength(rubricsToml)+Buffer.byteLength(judgePrompt)+Buffer.byteLength(dockerfile)+Buffer.byteLength(solve);
 if(totalBytes>2_000_000_000)throw new Error('单题题包超过 2 GB');
 const status={files_written:true,official_fixed_scripts_byte_verified:false,official_fixed_scripts_match_page_code_blocks:true,official_fixed_script_source:'current authenticated DingTalk document code blocks A.1/A.2; standalone original attachments unavailable',judge_prompt_source_verified:false,submission_ready:false,oracle_score:null,verifier_error:null,model_mean:null,platform_accepted:null,note:'固定脚本仅与当前规范页面代码块摘要一致，未与可下载官方原件做字节核验；Judge 提示词来源、Oracle、三模型评测、人工复核和平台验收尚未全部核验。空值不是通过。'};
 const outputRoot=resolve(input.outputDirectory),directory=join(outputRoot,input.taskId),statusPath=join(outputRoot,'状态',`${input.taskId}.json`);
 const existing=await lstat(directory).catch(()=>undefined);
 if(existing){
  const state=JSON.parse(await readFile(statusPath,'utf8')) as {input_fingerprint?:string};
  const fingerprint=sha(JSON.stringify({taskId:input.taskId,instruction,rubric:input.rubric,metadata,attachments:attachmentBytes.map(item=>[item.path,sha(item.bytes)]),golden:goldenBytes.map(item=>[item.path,sha(item.bytes)]),officialTest:sha(officialTest),officialFinalize:sha(officialFinalize),judgePrompt:sha(judgePrompt)}));
  if(state.input_fingerprint!==fingerprint)throw new Error('已有 Harbor 题包与本次冻结输入不一致');
  return{directory,statusPath};
 }
 const staleStatus=await lstat(statusPath).catch(()=>undefined);
 if(staleStatus)throw new Error('Harbor 题包目录不存在，但已存在同 ID 状态文件；拒绝覆盖');
 const temporary=join(resolve(input.outputDirectory),`.${input.taskId}.${randomUUID()}.tmp`);
 await mkdir(temporary,{recursive:true});let published=false,statusWritten=false;
 try{
  await mkdir(join(temporary,'environment/input_files'),{recursive:true});
  await mkdir(join(temporary,'solution/golden_output'),{recursive:true});
  await mkdir(join(temporary,'tests/__golden_output'),{recursive:true});
  await writeFile(join(temporary,'instruction.md'),instruction);
  await writeFile(join(temporary,'task.toml'),taskToml);
  // 内部兼容字段不进入原始Rubric；正式字段保持原值，不重写判据或分值。
  const originalRubric=(input.rubric as any[]).map(row=>{const source=row.metadata??row;return{id:row.id,...Object.fromEntries(WORK_RUBRIC_FIELDS.filter(key=>Object.hasOwn(source,key)).map(key=>[key,source[key]]))};});
  await writeFile(join(temporary,'rubrics.json'),JSON.stringify(originalRubric,null,2)+'\n');
  await writeFile(join(temporary,'environment/Dockerfile'),dockerfile);
  await writeFile(join(temporary,'environment/requirements.txt'),'');
  for(const file of attachmentBytes)await writeFile(join(temporary,'environment/input_files',file.path),file.bytes);
  await writeFile(join(temporary,'solution/solve.sh'),solve);await chmod(join(temporary,'solution/solve.sh'),0o755);
  for(const file of goldenBytes){await writeFile(join(temporary,'solution/golden_output',file.path),file.bytes);await writeFile(join(temporary,'tests/__golden_output',file.path),file.bytes);}
  await writeFile(join(temporary,'tests/test.sh'),officialTest);await chmod(join(temporary,'tests/test.sh'),0o755);
  await writeFile(join(temporary,'tests/finalize.py'),officialFinalize);
  await writeFile(join(temporary,'tests/rubrics.toml'),rubricsToml);
  await writeFile(join(temporary,'tests/prompt.md'),judgePrompt);
  const topLevel=(await readdir(temporary)).sort();
  if(JSON.stringify(topLevel)!==JSON.stringify(['environment','instruction.md','rubrics.json','solution','task.toml','tests'].sort()))throw new Error('Harbor 六件套顶层结构不完整或包含额外文件');
  await mkdir(join(outputRoot,'状态'),{recursive:true,mode:0o700});
  await rename(temporary,directory);
  published=true;
  const fingerprint=sha(JSON.stringify({taskId:input.taskId,instruction,rubric:input.rubric,metadata,attachments:attachmentBytes.map(item=>[item.path,sha(item.bytes)]),golden:goldenBytes.map(item=>[item.path,sha(item.bytes)]),officialTest:sha(officialTest),officialFinalize:sha(officialFinalize),judgePrompt:sha(judgePrompt)}));
  await writeFile(statusPath,JSON.stringify({...status,input_fingerprint:fingerprint},null,2)+'\n',{mode:0o600,flag:'wx'});
  statusWritten=true;
 }catch(error){await rm(temporary,{recursive:true,force:true});if(statusWritten)await rm(statusPath,{force:true});if(published)await rm(directory,{recursive:true,force:true});throw error;}
 return{directory,statusPath};
}

