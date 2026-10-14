/**
 * 职责：把已达标的 Work 法律题目快照保存为可复核的逐题交付准备资料。
 * 关键入口：`deliver()` 在“归档达标题目”时由服务端独立进程调用。
 * 当前题目契约只有文本答案和附件身份，不能据此伪造 Harbor 六件套或宣称已提交平台。
 */
import {createHash,randomUUID} from 'node:crypto';
import {mkdir,readFile,rename,rm,writeFile} from 'node:fs/promises';
import {isAbsolute,join} from 'node:path';

interface DeliveryInput{
 version:1;
 project_id:string;
 workflow_id:string;
 title:string;
 source_digest:string;
 question_version:string;
 rubric_version:string;
 question:{task_name:unknown;task_type:unknown;header:unknown;question:unknown;attachment_ids:unknown;rubric:unknown;answer_approach:unknown;reference_answer:unknown};
 acceptance:unknown;
 attachments:{id:string;sha256:string}[];
}

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sha=/^[0-9a-f]{64}$/i;
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');

function parseInput(value:unknown):DeliveryInput{
 if(!value||typeof value!=='object')throw new Error('交付输入缺失');
 const input=value as DeliveryInput;
 if(input.version!==1||!uuid.test(input.project_id)||!uuid.test(input.workflow_id)||!sha.test(input.source_digest)||typeof input.title!=='string'||!input.title.trim()||typeof input.question_version!=='string'||!input.question_version||typeof input.rubric_version!=='string'||!input.rubric_version)throw new Error('交付身份或版本无效');
 const question=input.question;
 if(!question||typeof question.question!=='string'||!question.question.trim()||typeof question.reference_answer!=='string'||!question.reference_answer.trim()||!Array.isArray(question.rubric)||!question.rubric.length||!Array.isArray(question.attachment_ids)||!question.attachment_ids.length||!Array.isArray(input.attachments)||!input.attachments.length)throw new Error('题目快照不完整');
 if(input.attachments.some(item=>!uuid.test(item.id)||!sha.test(item.sha256))||question.attachment_ids.some(id=>typeof id!=='string'||!input.attachments.some(item=>item.id===id)))throw new Error('附件身份不一致');
 if(!input.acceptance||typeof input.acceptance!=='object'||(input.acceptance as {decision?:unknown}).decision!=='accepted')throw new Error('达标结果无效');
 return input;
}

/** 同一来源摘要只生成同一份资料；已有同名目录必须与本次快照完全一致。 */
export async function deliver(value:unknown):Promise<void>{
 const input=parseInput(value);
 const parent=process.env.AI_DISTILL_DELIVERY_PARENT_DIR;
 if(!parent||!isAbsolute(parent))throw new Error('交付持久目录未配置');
 const target=join(parent,input.source_digest);
 const snapshot=JSON.stringify(input,null,2)+'\n';
 const snapshotHash=digest(snapshot);
 const checklist=[
  '# Work 法律全场景｜逐题交付准备',
  '',
  `题目：${input.title.replace(/[\r\n]+/g,' ')}`,
  `工作流 ID：${input.workflow_id}`,
  `达标来源摘要：${input.source_digest}`,
  `题目版本：${input.question_version}`,
  `Rubric 版本：${input.rubric_version}`,
  `快照 SHA-256：${snapshotHash}`,
  '',
  '此目录仅是归档时冻结的私有题目快照，**不是 Harbor 六件套，也不是平台提交凭据**。',
  '快照含题面、Rubric、作答思路、参考答案和内部附件 ID，不得直接作为公开题包发送。',
  '',
  '## 正式提交前仍需完成',
  '',
  '- 根据已脱敏的实际附件制作 `environment/input_files/`，核查文件内容、名称和只读边界。当前脚本仅收到附件 ID 和指纹，没有附件正文。',
  '- 题目 DOCX 与项目 Excel 使用工作台已有的通用生成／导出流程；本脚本不重复生成这两类文件。',
  '- 由专家根据 Work 项目要求核定真实任务书、法律参考答案、检索轨迹和 Rubric，再完成对应 Harbor 六件套。当前归档快照只作为制作依据，不替代这些正式文件。',
  '- 按 `materials/交付规范.md` 生成并逐项核对 Harbor 六件套；固定 `tests/test.sh`、`tests/finalize.py` 必须从项目方取得完整原件，不能使用不完整的页面转录。',
  '- 核对 `task.toml` 中 artifacts 和 name/org 的项目方口径，完成镜像、Oracle、三模型及人工质检。',
  '- 确定正式供应商代号、一级场景、批次名称和提交日期后，再打包 ZIP 并按项目方指定方式提交。',
  '',
  '系统“归档达标题目”只说明本次内部达标版本已归档，不表示通过外部题包验收。',
  '',
 ].join('\n');
 await mkdir(parent,{recursive:true});
 try{
  const existing=await readFile(join(target,'题目快照.json'),'utf8');
  if(digest(existing)!==snapshotHash)throw new Error('已有同名交付快照与本次数据不一致');
  return;
 }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
 const temporary=join(parent,`.${input.source_digest}.${randomUUID()}.tmp`);
 try{
  await mkdir(temporary,{mode:0o700});
  await writeFile(join(temporary,'题目快照.json'),snapshot,{mode:0o600});
  await writeFile(join(temporary,'交付缺口.md'),checklist,{mode:0o600});
  await rename(temporary,target);
 }catch(error){
  await rm(temporary,{recursive:true,force:true});
  if(['EEXIST','ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code??'')){
   const existing=await readFile(join(target,'题目快照.json'),'utf8');
   if(digest(existing)===snapshotHash)return;
  }
  throw error;
 }
}

try{
 const input=await Bun.stdin.text();
 await deliver(JSON.parse(input));
}catch{
 // 子进程退出码通知归档失败；不向日志输出含私有题目的异常正文。
 process.exitCode=1;
}
