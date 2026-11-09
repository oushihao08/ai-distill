/** Skill Dependency v2 author fields and delivery validation. Used by lifecycle schema and ZIP export; no save-time gate. */
import {HTTPException} from 'hono/http-exception';
const text={type:'string',minLength:1};
export const platformDimensions=['指令遵循','内容质量-结论正确性','内容质量-数值与计算准确性','内容质量-专业规范','内容质量-分析与论证质量','内容质量-事实忠实性','结构与组织','操作与交付安全','安全合规','超预期贡献','视觉美感'] as const;
const legacyDimensions=new Set(['交付物内容质量','专业判断','交付规范','可信性']);
const list=(items:unknown,minItems=0)=>({type:'array',items,minItems});
const obj=(properties:Record<string,unknown>)=>({type:'object',additionalProperties:false,properties,required:Object.keys(properties)});
export const dependencyFields={
 delivery_contract:obj({version:{const:'skill_dependency_v2',type:'string'},input_names:list(text,1),skill_names:list(text,1),golden_names:list(text),dependency_rules:list(obj({skill_name:text,rule_locator:text,input_name:text,trigger_locator:text,expected_effect:text,without_skill_result:text,changed_rule:text,changed_result:text,unchanged_result:text,rubric_ids:list(text,1)}),1),verification:list(obj({file:text,check:{type:'string',enum:['content','open','recalculate','render']},status:{type:'string',enum:['performed','not_performed']},method:text,evidence:text}),1)}),
 platform_metadata:obj({task_id:text,task_type:{type:'string',const:'skill dependency'},domain_l1:text,domain_l2:text,domain_l3:text,domain_l4:text,capabilities:list(text,1),requires_vl:{type:'boolean'},task_description:text,required_tools:list(text),domain_knowledge:text,skill_dependency:text,complexity:{type:'string',enum:['C1','C2','C3','C4','C5']},complexity_basis:text}),
 platform_rubric:list(obj({id:text,description:text,dimension:{type:'string',enum:platformDimensions},criterion_type:{type:'string',enum:['Objective','Subjective']},criterion_necessity:{type:'string',enum:['Explicit','Implicit']},type:{type:'string',enum:['Binary','Gradient']},weight:{type:'number',enum:[10,7,3,-3,-7,-10]},levels:list(obj({score:{type:'number',enum:[0,.25,.5,.75,1]},description:text}),2)}),3),
};
export const formulaCellSchema=obj({formula:text,cached_value:{type:['number','null']}});
export const safeDeliveryName=(v:unknown):v is string=>typeof v==='string'&&v.length>0&&v.length<=160&&v.trim()===v&&!v.startsWith('.')&&!/[\\/\x00-\x1f\x7f<>:"|?*]/.test(v);
const fail=(message:string):never=>{throw new HTTPException(409,{message:`Skill Dependency交付检查：${message}`});};
const nonempty=(v:unknown)=>typeof v==='string'&&v.trim().length>0;
function strings(v:any,label:string):string[]{if(!Array.isArray(v)||v.some(x=>!nonempty(x))||new Set(v).size!==v.length)fail(`${label}须为无重复字符串清单`);return v;}
function same(a:string[],b:string[],label:string){if(a.length!==b.length||a.some(x=>!b.includes(x)))fail(`${label}与实际文件不一致`);}
/** Checks declarations and references, not legal correctness or truth of author-reported tool evidence. */
export function validateDependencyDelivery(q:any,inputNames:string[]){
 const c=q?.delivery_contract,m=q?.platform_metadata,r=q?.platform_rubric;
 if(c?.version!=='skill_dependency_v2')fail('缺少v2交付契约；旧题须重新出题，不自动补造字段');
 for(const field of ['question','reference_answer'])if(!nonempty(q[field]))fail(`缺少${field}`);
 if(!Array.isArray(q.skill_files)||q.skill_files.length<1||q.skill_files.length>3)fail('Skill数量须为1至3');
 const skills=q.skill_files.map((s:any)=>{if(!safeDeliveryName(s?.name)||!s.name.endsWith('.md')||!nonempty(s.content))fail('Skill文件名或正文无效');return s.name;});
 if(!Array.isArray(q.golden_files))fail('缺少参考成果清单');
 const golden=q.golden_files.map((f:any)=>{if(!safeDeliveryName(f?.path)||!nonempty(f.markdown))fail('参考成果文件名或正文无效');return f.path;});
 strings(skills,'Skill文件');strings(golden,'参考成果');
 same(strings(c.input_names,'输入文件'),inputNames,'输入声明');same(strings(c.skill_names,'Skill声明'),skills,'Skill声明');same(strings(c.golden_names,'成果声明'),golden,'成果声明');
 for(const n of [...inputNames,...skills,...golden])if(!q.question.includes(n))fail(`题面未明确引用文件：${n}`);
 if(!m||m.task_type!=='skill dependency'||typeof m.requires_vl!=='boolean'||!['C1','C2','C3','C4','C5'].includes(m.complexity))fail('Metadata类型或复杂度无效');
 for(const k of ['task_id','domain_l1','domain_l2','domain_l3','domain_l4','task_description','domain_knowledge','skill_dependency','complexity_basis'])if(!nonempty(m[k]))fail(`Metadata缺少${k}`);
 // 平台在建题页分配题目编号；作者提供的值仅用于本地追踪。
 if(!strings(m.capabilities,'能力标签').length)fail('缺少能力标签');strings(m.required_tools,'所需工具');
 if(m.requires_vl||q.task_requirements?.input_mode!=='text')fail('当前文字投影交付不支持视觉依赖');
 if(!['text','file'].includes(q.task_requirements?.output_mode))fail('输出能力无效');
 if(q.task_requirements.output_mode==='file'&&!golden.length)fail('文件任务缺少参考成果');
 strings(q.task_requirements.tools,'任务工具');
 if(!Array.isArray(r)||r.length<3)fail('缺少完整平台Rubric');
 const ids=strings(r.map((x:any)=>x?.id),'Rubric ID');
 if(!Array.isArray(q.rubric))fail('缺少本地Rubric投影');
 same(strings(q.rubric.map((x:any)=>x?.id),'本地Rubric ID'),ids,'两份Rubric');
 for(const x of r)if(q.rubric.find((v:any)=>v.id===x.id)?.criterion!==x.description)fail(`两份Rubric判据正文不一致：${x.id}`);
 let positive=0,negative=0,domain=0,critical=0;
 for(const x of r){
  if(!nonempty(x.description)||!platformDimensions.includes(x.dimension)&&!legacyDimensions.has(x.dimension)||!['Objective','Subjective'].includes(x.criterion_type)||!['Explicit','Implicit'].includes(x.criterion_necessity)||!['Binary','Gradient'].includes(x.type)||![10,7,3,-3,-7,-10].includes(x.weight))fail(`Rubric ${x.id}字段无效`);
  if(x.weight>0){positive+=x.weight;if(x.dimension==='交付物内容质量'||x.dimension.startsWith('内容质量-'))domain+=x.weight;if(x.weight===10)critical++;}else negative-=x.weight;
  if(!Array.isArray(x.levels)||x.levels.some((l:any)=>![0,.25,.5,.75,1].includes(l?.score)||!nonempty(l.description)))fail(`Rubric ${x.id}档位无效`);
  const scores=x.levels.map((l:any)=>l.score);
  if(new Set(scores).size!==scores.length||!scores.includes(0)||!scores.includes(1)||(x.type==='Binary'&&scores.length!==2)||(x.type==='Gradient'&&scores.length<3))fail(`Rubric ${x.id}档位不完整`);
 }
 if(critical<2||negative===0||negative>=positive*.5||domain<positive*.3)fail('Rubric关键项、负分比例或专业内容占比不符合要求');
 if(!Array.isArray(c.dependency_rules)||!c.dependency_rules.length)fail('缺少依赖检查');
 const covered=new Set<string>();
 for(const d of c.dependency_rules){
  if(!skills.includes(d.skill_name)||!inputNames.includes(d.input_name))fail('依赖检查引用了不存在的Skill或输入');
  for(const k of ['rule_locator','trigger_locator','expected_effect','without_skill_result','changed_rule','changed_result','unchanged_result'])if(!nonempty(d[k]))fail(`依赖检查缺少${k}`);
  if(d.changed_result===d.expected_effect)fail('规则改写未说明结果变化');
  if(!strings(d.rubric_ids,'依赖评分点').length||d.rubric_ids.some((id:string)=>!ids.includes(id)))fail('依赖检查引用了不存在的评分点');covered.add(d.skill_name);
 }
 if(skills.some((s:string)=>!covered.has(s)))fail('部分Skill缺少独立依赖检查');
 if(!Array.isArray(c.verification))fail('缺少成果核验记录');
 const files=['instruction.md','golden_answer.md',...golden,...skills];
 for(const v of c.verification)if(!files.includes(v.file)||!['content','open','recalculate','render'].includes(v.check)||!['performed','not_performed'].includes(v.status)||!nonempty(v.method)||!nonempty(v.evidence))fail('核验记录字段或文件引用无效');
 for(const f of q.golden_files){
  if(typeof f.requires_formulas!=='boolean'||typeof f.requires_render!=='boolean')fail('缺少成果能力声明');
  if(f.requires_formulas&&!f.path.endsWith('.xlsx'))fail('公式能力仅支持XLSX');
  if(f.path.endsWith('.xlsx')){
   if(!Array.isArray(f.sheets)||!f.sheets.length)fail(`工作簿缺少工作表：${f.path}`);
   let formulas=0;
   for(const s of f.sheets){
    if(!nonempty(s.name)||!strings(s.columns,'工作表列').length||!Array.isArray(s.rows))fail('工作表结构无效');
    for(const row of s.rows){if(!Array.isArray(row)||row.length!==s.columns.length)fail('工作表行列数不符');for(const cell of row){
     if(typeof cell==='string'&&cell.startsWith('='))fail('公式必须使用formula对象，不能写成文本');
     if(cell&&typeof cell==='object'){if(!nonempty(cell.formula)||(cell.cached_value!==null&&(typeof cell.cached_value!=='number'||!Number.isFinite(cell.cached_value))))fail('公式或缓存值无效');formulas++;}
    }}
   }
   if(f.requires_formulas&&!formulas)fail(`工作簿要求公式却未提供：${f.path}`);
  }
 }
 return {format:'skill-dependency-validation-v2',checks:'structure_and_references_passed',author_verification:c.verification,author_evidence_independently_verified:false,platform_verified:false};
}
