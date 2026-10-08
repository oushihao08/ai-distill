export interface ScoreBinding {question_version:string;input_revision:number;input_digest:string;rubric_version:string;rubric_digest:string;answer_attempt_id:string;answer_sha256:string}
export interface RubricItem {id:string;criterion:string;max_score:number}
export interface ScoreContext {binding:ScoreBinding;question:string;materials:{name:string;text:string}[];answer:string;rubric:RubricItem[]}
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const nonblank=(value:unknown):value is string=>typeof value==='string'&&!!value.trim();
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
