/** 文件职责：用合成题目、附件和匿名答案调用真实 Codex 独立评分，保存结构校验及评分证据。
 * 执行入口与用途：`bun scripts/verification/verify-independent-score.ts`；构造合成题目、附件和匿名答案，调用 Codex 独立评分后校验报告并保存证据。
 */
import {mkdtemp,rm,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {runIndependentScore} from '../../server/scoring/executor';
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const root=await mkdtemp(join(tmpdir(),'real-grading-'));
const rubric=[{id:'amount',criterion:'回答欠款金额100元；金额错误或缺失为0分。',max_score:1}];
const ruleText='本期规则：只依据附件回答欠款金额，评分按题面rubric执行。';
const rulesRoot=join(root,'rules');
let evidence:Record<string,unknown>={checked_at:new Date().toISOString(),input_kind:'synthetic anonymous question/material/answer',real_codex_call:true};
try{
 await mkdir(join(rulesRoot,'skill'),{recursive:true});await writeFile(join(rulesRoot,'skill','SKILL.md'),ruleText);
 const result=await runIndependentScore({binding:{question_version:'fixture-v1',input_digest:hash('fixture-input'),rubric_version:'fixture-r1',rubric_digest:hash(JSON.stringify(rubric)),answer_attempt_id:crypto.randomUUID(),answer_sha256:hash('欠款100元。')},question:'根据附件，欠款金额是多少？',materials:[{name:'附件1',text:'合同记载甲公司尚欠乙公司100元。'}],answer:'欠款100元。',answer_approach:'依据合同记载提取欠款金额。',reference_answer:'100元。',rubric,project_rules:{version_id:'fixture-rules-v1',source_digest:hash(ruleText),snapshot_path:rulesRoot,files:[{path:'skill/SKILL.md',sha256:hash(ruleText),size_bytes:Buffer.byteLength(ruleText)}]}},{root,model:process.env.SCORE_SMOKE_MODEL??'gpt-6.1-sol',reasoning_effort:'low',timeout_ms:120000});
 evidence={...evidence,status:result.validation.valid?'passed':'invalid_assessment',session_id:result.session_id,duration_ms:result.duration_ms,usage:result.usage,validation:result.validation,report:result.report};
 if(!result.validation.valid)process.exitCode=1;
}catch{evidence={...evidence,status:'failed',reason:'Codex authentication, execution or output validation failed; no private diagnostic exported'};process.exitCode=1;}
finally{await rm(root,{recursive:true,force:true});await mkdir('docs/evidence',{recursive:true});await writeFile('docs/evidence/independent-score-smoke-results.json',JSON.stringify(evidence,null,2)+'\n');console.log(JSON.stringify({status:evidence.status,duration_ms:evidence.duration_ms}));}
