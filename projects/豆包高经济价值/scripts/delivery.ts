/**
 * 职责：豆包高经济价值各期共用的归档入口。
 * 关键入口：`deliver()` 在“归档达标题目”时由服务端独立进程调用。
 * 使用场景：只在成果目录写明当前没有正式题包；不生成 Harbor 文件，不写入题面、思路或标答。仅当 `交付成果.json` 是已知的身份摘要形状时才删除它，遇到其他内容即拒绝。
 */
import {createHash,randomUUID} from 'node:crypto';
import {mkdir,readFile,rename,rm,writeFile} from 'node:fs/promises';
import {isAbsolute,join} from 'node:path';

const digest=(value:string)=>createHash('sha256').update(value).digest('hex');

const gap=[
 '# 豆包高经济价值｜交付缺口',
 '',
 '本次归档只说明内部脚本已运行。这里没有确认稿，不是 Harbor 六件套，也不是平台验收。',
 '成果目录里的脱敏 DOCX 只是附件副本，不是 `environment/input_files/`，也不是专家 golden。',
 '题面、考点、作答思路和标准答案不写入本目录。',
 '',
 '## 仍缺的正式交付',
 '',
 '- 确认稿五项：`instruction.json`、`metadata.json`、`rubric.json`、`input_files/`、`golden_output/`。',
 '- Harbor 六件套：`instruction.md`、`task.toml`、`rubrics.json`、`environment/`、`solution/`、`tests/`。',
 '- 两份内容一致且非空的 golden，以及六处逐字节一致的交付物名称。',
 '- 来自项目方原件的 `tests/test.sh` 与 `tests/finalize.py`。页面转录不能代替字节核验。',
 '- 镜像自检、Oracle 主分大于 0.90 且 `verifier_error=0`、三个规定模型均分严格低于 0.55、人工质检。',
 '',
 '脚本退出码 0、第八步归档成功和批次组包成功，都不能代替上列验收。',
 '',
].join('\n');

/** 只移除上次误写成交付成果的身份摘要，避免留下一个假交付文件。 */
async function removeIdentityStub(parent:string){
 const path=join(parent,'交付成果.json');
 let text:string;
 try{text=await readFile(path,'utf8');}
 catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
 const value=JSON.parse(text) as Record<string,unknown>;
 const keys=Object.keys(value).sort();
 const stub=['attachment_ids','project_id','task_name','title','workflow_id'];
 if(keys.length!==stub.length||keys.some((key,index)=>key!==stub[index]))throw new Error('成果目录已有非身份摘要的交付成果.json');
 await rm(path);
}

/** 只确认这次调用来自已达标归档，不把题目正文写入成果目录。 */
function assertAccepted(value:unknown){
 if(!value||typeof value!=='object')throw new Error('交付输入缺失');
 const acceptance=(value as {acceptance?:{decision?:unknown}}).acceptance;
 if(!acceptance||acceptance.decision!=='accepted')throw new Error('达标结果无效');
}

/** 同一缺口说明重复执行保持文件不变；不删除同目录已有 DOCX。 */
export async function deliver(value:unknown):Promise<void>{
 assertAccepted(value);
 const parent=process.env.AI_DISTILL_DELIVERY_PARENT_DIR;
 if(!parent||!isAbsolute(parent))throw new Error('交付持久目录未配置');
 await mkdir(parent,{recursive:true});
 await removeIdentityStub(parent);
 const target=join(parent,'交付缺口.md');
 const record=gap;
 try{
  const existing=await readFile(target,'utf8');
  if(digest(existing)===digest(record))return;
  throw new Error('已有交付缺口与本次说明不一致');
 }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
 const temporary=join(parent,`.交付缺口.${randomUUID()}.tmp`);
 try{await writeFile(temporary,record,{mode:0o600,flag:'wx'});await rename(temporary,target);}
 finally{await rm(temporary,{force:true});}
}

try{
 const input=await Bun.stdin.text();
 await deliver(JSON.parse(input));
}catch{
 process.exitCode=1;
}
