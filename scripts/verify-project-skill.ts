/** 文件职责：使用首期真实规则和完整模板调用 Codex 生成 skill 候选；不自动采用或发布。
 * 执行入口与用途：`bun scripts/verify-project-skill.ts`；读取指定真实规则和完整模板，调用 Codex 生成候选并保存冒烟摘要；不执行采用或发布。
 */
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {generateProjectSkill} from '../server/skill-generation/generate';
let evidence:Record<string,unknown>={checked_at:new Date().toISOString(),scope:'real first-project rules + full read-only company-legal-task template; candidate only, no publication',real_codex_call:false};
try{
 evidence.real_codex_call=true;
 const result=await generateProjectSkill({project:resolve('projects/豆包高经济价值/第五期'),materialsRoot:resolve('projects/豆包高经济价值/materials'),template:'/Users/jack/Documents/codes/lvgou/豆包高经/company-legal-task',root:resolve(process.env.STORAGE_DIR??'.storage','skill-generation-smoke'),model:process.env.SKILL_SMOKE_MODEL??'gpt-6-luna',reasoning_effort:'low'});
 evidence={...evidence,status:result.publishable?'candidate_checked':'candidate_has_issues',...result};
}catch{evidence={...evidence,status:'failed',reason:'input snapshot, Codex invocation or candidate validation failed; private content not exported'};process.exitCode=1;}
finally{await mkdir('docs/evidence',{recursive:true});await writeFile('docs/evidence/project-skill-smoke-results.json',JSON.stringify(evidence,null,2)+'\n');console.log(JSON.stringify({status:evidence.status,publishable:evidence.publishable,candidate_path:evidence.candidate_path}));}
