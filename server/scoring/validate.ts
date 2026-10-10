/**
 * 职责：评分报告程序校验：核对版本绑定、逐项证据、覆盖范围和分数合计，不替代模型判断。
 * 关键方法与用途：`extractTextScore()` 从评分原文提取总分；`validateScore()` 兼容旧结构化报告校验，不替代评分模型的专业判断。
 * 使用场景：评分 executor 与上下文校验在发布评分结果前调用。
 */
export interface ScoreBinding {question_version:string;input_digest:string;rubric_version:string;rubric_digest:string;answer_attempt_id:string;answer_sha256:string}
export interface RubricItem {id:string;criterion:string;max_score:number}
export interface ScoreContext {project_name?:string;question_id?:string;binding:ScoreBinding;question:string;materials:{name:string;text:string}[];answer:string;rubric:RubricItem[];answer_approach:string;reference_answer:string;step_prompt?:string;project_prompt?:{workspace_path:string;skill_path:string;source_digest:string;files:{path:string;sha256:string;size_bytes:number}[]};project_rules?:{version_id:string;source_digest:string;snapshot_path:string;files:{path:string;sha256:string;size_bytes:number}[]}}
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const nonblank=(value:unknown):value is string=>typeof value==='string'&&!!value.trim();
/** 回复返回后提取明确总分；有歧义时保留原文，不改分或重新评分。 */
export function extractTextScore(text:string,rubric:RubricItem[]){
 const max_score=Number(rubric.reduce((sum,item)=>sum+item.max_score,0).toFixed(8));
 const candidates=new Set<number>();
 for(const rawLine of text.split('\n')){
  const line=rawLine.replace(/\*\*/g,'').trim();
  if(/假设|如果|若|补充后|修订后|改进后|例如|可能达到/.test(line))continue;
  const match=line.match(/^(?:最终总分|最终得分|总分|合计得分|得分)\s*[:：]?\s*(\d+(?:\.\d+)?)\s*(?:[／/]\s*(\d+(?:\.\d+)?)\s*分?|分\s*[（(]?满分\s*(\d+(?:\.\d+)?)\s*分?[）)]?)\s*$/);
  if(match){
   const denominator=Number(match[2]??match[3]);
   if(denominator===max_score)candidates.add(Number(match[1]));
  }
 }
 const value=candidates.size===1?[...candidates][0]:undefined;
 const issues:string[]=[];
 let itemTotal=0;
 if(rubric.length&&rubric.every(item=>item.max_score===1)){
  const byId=new Map(rubric.map(item=>[item.id,item]));
  const found=new Set<string>();
  for(const rawLine of text.split('\n')){
   const line=rawLine.replace(/\*\*/g,'').trim();
   const item=rubric.find(candidate=>line.startsWith(`${candidate.id}：`)||line.startsWith(`${candidate.id}:`));
   if(!item)continue;
   const escaped=item.id.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
   const match=line.match(new RegExp(`^${escaped}\\s*[：:]\\s*(?:得分\\s*)?(\\d+(?:\\.\\d+)?)\\s*[／/]\\s*(\\d+(?:\\.\\d+)?)(?:\\s*分)?(?:\\s|[，。；;|]|$)`));
   if(!match||found.has(item.id)){
    issues.push(`${item.id}：条目评分格式缺失或重复`);
    continue;
   }
   found.add(item.id);
   const score=Number(match[1]),denominator=Number(match[2]);
   if((score!==0&&score!==1)||denominator!==1){issues.push(`${item.id}：每项满分1分且得分只能为0或1`);continue;}
   itemTotal+=score;
  }
  if(found.size!==byId.size)issues.push('rubric条目评分缺失或重复');
 }
 const totalValid=value!==undefined&&Number.isFinite(value)&&value>=0&&value<=max_score;
 if(!totalValid)issues.push(candidates.size>1?'评分原文存在多个不同总分':'未能从评分原文明确提取合法总分');
 if(totalValid&&rubric.length&&rubric.every(item=>item.max_score===1)&&value!==itemTotal)issues.push('最终总分与逐项二元评分合计不一致');
 const valid=totalValid&&issues.length===0;
 return {valid,total:valid?value:null,max_score,issues,mode:'text_score_extraction' as const};
}
// Checks traceability and arithmetic. Whether an answer satisfies a criterion remains the independent grader's responsibility.
export function validateScore(raw:unknown,context:ScoreContext){
 const issues:string[]=[];let total=0;let max_score=0;
 const problem=(message:string)=>{if(issues.length<100)issues.push(message);};
 if(!context.rubric.length||context.rubric.length>500||new Set(context.rubric.map(r=>r.id)).size!==context.rubric.length||context.rubric.some(r=>!nonblank(r.id)||!nonblank(r.criterion)||!Number.isFinite(r.max_score)||r.max_score<=0))problem('rubric条目无效');
 else max_score=context.rubric.reduce((sum,r)=>sum+r.max_score,0);
 if(!object(raw))return {valid:false,total,max_score,issues:['评分结果须为JSON对象']};
 if(!object(raw.binding)||Object.entries(context.binding).some(([key,value])=>(raw.binding as Record<string,unknown>)[key]!==value))problem('题目、附件、rubric或作答版本不一致');
 if(raw.assessment_valid!==true)problem('独立评分有效性未确认');
 if(!Array.isArray(raw.disputes)||raw.disputes.length>0)problem('评分存在争议或缺少争议声明');
 if(!Array.isArray(raw.items)||raw.items.length!==context.rubric.length||raw.items.length>500)problem('评分条目数量与rubric不一致');
 const found=new Set<string>();
 if(Array.isArray(raw.items))for(const item of raw.items.slice(0,500)){
  if(!object(item)||!nonblank(item.id)){problem('评分条目格式无效');continue;}
  const rubric=context.rubric.find(r=>r.id===item.id);
  if(!rubric||found.has(item.id)){problem('评分条目未知或重复');continue;}found.add(item.id);
  const score=item.score;
  if(typeof score!=='number'||!Number.isFinite(score)||score<0||score>rubric.max_score){problem(`${item.id}：得分超出范围`);continue;}total+=score;
  if(!nonblank(item.reason))problem(`${item.id}：缺少评分理由`);
  let answerEvidence=false;
  if(!Array.isArray(item.evidence)||item.evidence.length>100){problem(`${item.id}：证据格式无效`);continue;}
  for(const evidence of item.evidence){
   if(!object(evidence)||!nonblank(evidence.quote)){problem(`${item.id}：缺少原文引文`);continue;}
   const source=evidence.source;
   let text:string|undefined;
   if(source==='answer')text=context.answer;
   else if(source==='question')text=context.question;
   else if(source==='rubric')text=rubric.criterion;
   else if(source==='material'&&Number.isInteger(evidence.material_index))text=context.materials[evidence.material_index as number]?.text;
   if(text===undefined||!text.includes(evidence.quote)){problem(`${item.id}：引文不在指定原文中`);continue;}
   if(source==='answer')answerEvidence=true;
  }
  if(score>0&&item.missing===true)problem(`${item.id}：正分与未找到声明冲突`);
  if(score>0&&!answerEvidence)problem(`${item.id}：正分缺少作答原文证据`);
  if(score===0&&!answerEvidence&&item.missing!==true)problem(`${item.id}：零分须记录反证或明确未找到`);
 }
 if(found.size!==context.rubric.length)problem('rubric条目未完整评分');
 total=Number(total.toFixed(8));max_score=Number(max_score.toFixed(8));
 if(typeof raw.total!=='number'||!Number.isFinite(raw.total)||Math.abs(raw.total-total)>1e-8)problem('报告总分与逐项合计不一致');
 if(typeof raw.max_score!=='number'||!Number.isFinite(raw.max_score)||Math.abs(raw.max_score-max_score)>1e-8)problem('报告满分与rubric合计不一致');
 return {valid:issues.length===0,total,max_score,issues};
}
