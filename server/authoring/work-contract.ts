/**
 * 职责：Work 法律题目的内容 schema、专业字段校验及兼容文本投影。
 * 入口：workQuestionSchema / normalizeWorkQuestion 供出题执行器使用；assertWorkSubmissionReady / assertWorkBusinessRequirements 供本项目交付准入复用；projectReference / projectRule 供同源渲染使用。
 * 边界：只校验确定性结构，不认定法律正确、原子性、工作量或正式难度。
 */
export const WORK_CONTENT_CONTRACT='work_legal_v1' as const;
/** Work本批项目方反馈的交付下限；不适用于其他内容契约，不证明判据专业有效。 */
export const WORK_MIN_RUBRIC_ITEMS=30;
export interface WorkInstruction {background:string;requests:string[];baseline_date:string|null;hard_constraints:string[]}
/** 新题使用完整维度名；历史题读取仍按既有数字/Q身份校验，不重写原判据。 */
export const WORK_DIMENSIONS=['0-一票否决','1-指令遵循与任务理解','2-交付物内容质量/Q1事实与证据梳理准确性','2-交付物内容质量/Q2风险与问题识别准确性','2-交付物内容质量/Q3法源定位与援引准确性','2-交付物内容质量/Q4法律适用与涵摄定性准确性','2-交付物内容质量/Q5量化计算与门槛判断准确性','2-交付物内容质量/Q6结论确定性与方案可执行性','2-交付物内容质量/Q7内部逻辑一致性','3-交付物体例规范与可读性','4-推理与规划','5-安全合规','6-协作体验','7-反偷懒与反模板'];
export interface WorkContent {
 content_contract:typeof WORK_CONTENT_CONTRACT;
 task_metadata:{instruction?:WorkInstruction;occupation:string;scenario:string;role_perspective:string;domain_l2:string|null;capabilities:string[];professional_knowledge:string[];vl_dependency:boolean;source_note:string;generation_note:string;tools:string[];target_level:'L2'|'L3'|'L4'|'L5';level_basis:{documents:{id:string;attachment_id:string;locator:string;description:string}[];necessary_steps:string[];estimated_hours:number|null;explanation:string}};
 input_files:{attachment_id:string;name:string;description:string}[];
 deliverables:{id:string;path:string;format:string;description:string;required:boolean}[];
 reference_outputs:{deliverable_id:string;content:string;sheets:{name:string;columns:string[];rows:(string|number|boolean)[][]}[]}[];
 research_records:{id:string;query:string;source_url:string|null;source_title:string;version:string;findings:string;verification_status:'verified'|'unverified';supports:string[]}[];
 task_requirements:{input_mode:'text'|'image';output_mode:'text'|'file';tools:string[]};
 content_status:{status:'complete'|'draft';issues:string[]};
}
export const WORK_ATOMIC_CAPABILITIES=['类案检索','法条检索','其他法律信息检索','法条效力核查','法律概念理解','法律要素提取','结构化要素分解','争议焦点识别','证据评估','法律解释论证','体系解释','目的解释','规范含义论证','演绎推理','归纳推理','类比推理','溯因推理','反事实推理','法律后果推定','冲突化解','论证链构建','论证强度评估','证据论证链','战略风险排序','纠纷与履约风险评估','内部合规风险识别','法律风险评估','司法价值判断','行政价值判断','法律文书格式化','单文书摘要','多文书综合摘要','法律术语规范','案件全流程规划','庭审排期与期限监控','计费与诉讼预算管理'];
const str={type:'string'},strings={type:'array',items:str},nullableString={type:['string','null']};
const obj=(properties:Record<string,unknown>)=>({type:'object',additionalProperties:false,properties,required:Object.keys(properties)});
const arr=(items:unknown)=>({type:'array',items});
export const WORK_RUBRIC_FIELDS=['statement','criterion_type','criterion_necessity','dimension','evaluated_files','knowledge_points','atomic_capabilities','priority','score','type','points','trigger_count'] as const;
export function workQuestionSchema(base:any){
 const metadata=obj({statement:str,criterion_type:{enum:['Objective','Subjective'],type:'string'},criterion_necessity:{enum:['Explicit','Implicit'],type:'string'},dimension:{type:'string',enum:WORK_DIMENSIONS},evaluated_files:strings,knowledge_points:strings,atomic_capabilities:arr({type:'string',enum:WORK_ATOMIC_CAPABILITIES}),priority:{type:'string',enum:['Critically Important','Important','Slightly Important','Slightly Detrimental','Detrimental','Critically Detrimental','Veto']},score:{type:['number','null'],enum:[10,7,3,-3,-7,-10,null]},type:{type:'string',enum:['binary','likert']},points:{type:['integer','null'],enum:[5,null]},trigger_count:nullableString});
 const {reference_answer,answer_requirements,question,...properties}=base.properties;void reference_answer;void answer_requirements;void question;
 return obj({...properties,content_contract:{type:'string',enum:[WORK_CONTENT_CONTRACT]},rubric:{...arr(obj({id:str,metadata})),description:`Work完整题包至少${WORK_MIN_RUBRIC_ITEMS}项独立判据；draft可保留部分结果，不为数量凑项。`},
 task_metadata:obj({instruction:obj({background:str,requests:strings,baseline_date:nullableString,hard_constraints:strings}),occupation:str,scenario:str,role_perspective:str,domain_l2:nullableString,capabilities:strings,professional_knowledge:strings,vl_dependency:{type:'boolean'},source_note:str,generation_note:str,tools:strings,target_level:{type:'string',enum:['L2','L3','L4','L5']},level_basis:obj({documents:arr(obj({id:str,attachment_id:str,locator:str,description:str})),necessary_steps:strings,estimated_hours:{type:['number','null']},explanation:str})}),
 input_files:arr(obj({attachment_id:str,name:str,description:str})),deliverables:arr(obj({id:str,path:str,format:str,description:str,required:{type:'boolean'}})),
 reference_outputs:arr(obj({deliverable_id:str,content:str,sheets:arr(obj({name:str,columns:strings,rows:arr(arr({type:['string','number','boolean']}))}))})),
 research_records:arr(obj({id:str,query:str,source_url:nullableString,source_title:str,version:str,findings:str,verification_status:{type:'string',enum:['verified','unverified']},supports:strings})),
 task_requirements:obj({input_mode:{type:'string',enum:['text','image']},output_mode:{type:'string',enum:['text','file']},tools:strings}),content_status:obj({status:{type:'string',enum:['complete','draft']},issues:strings})});
}
/** 同一结构生成公开题面；不让作者维护另一份可能冲突的question。 */
export function renderWorkInstruction(instruction:WorkInstruction,deliverables:WorkContent['deliverables']):string{
 keys(instruction,['background','requests','baseline_date','hard_constraints'],'任务说明');text(instruction.background,'背景');names(instruction.requests,'委托诉求',1);names(instruction.hard_constraints,'硬性约束');
 const date=instruction.baseline_date;
 if(date!==null&&(typeof date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(Date.parse(date))||new Date(date).toISOString().slice(0,10)!==date))fail('基准日须为真实YYYY-MM-DD日期或null');
 list(deliverables,'成果清单',1,100);
 const numbered=(entries:string[])=>entries.map((entry,index)=>`${index+1}. ${entry}`).join('\n');
 return ['背景\n'+instruction.background,'委托方诉求\n'+numbered(instruction.requests),'交付物要求\n'+numbered(deliverables.map(file=>`${file.path}（${file.required?'必交':'选交'}）：${file.description}`)),...(date?['基准日：'+date]:[]),...(instruction.hard_constraints.length?['硬性约束\n'+numbered(instruction.hard_constraints)]:[])].join('\n\n');
}
/** 仅报告作者登记的等级依据疑点，不证明文书资格、不拦截或改变等级/评分。 */
export function workLevelWarnings(metadata:WorkContent['task_metadata']):string[]{
 const limits={L2:[3,10,30,.5,2],L3:[10,30,100,2,8],L4:[50,100,500,8,40],L5:[100,500,Infinity,40,Infinity]} as const;
 const bound=limits[metadata.target_level],basis=metadata.level_basis;if(!bound||!basis)return[];
 const warnings:string[]=[];
 if(!Array.isArray(basis.documents))warnings.push('历史题未登记独立文书清单，等级待核');
 else if(basis.documents.length<bound[0])warnings.push(`作者登记文书${basis.documents.length}项，低于${metadata.target_level}的${bound[0]}份要求；须核对完整独立文书，不能以PDF数代替`);
 if(!Array.isArray(basis.necessary_steps))warnings.push('历史题未登记必要工作清单，等级待核');
 else if(basis.necessary_steps.length<bound[1]||basis.necessary_steps.length>bound[2])warnings.push(`作者登记必要工作${basis.necessary_steps.length}项，与${metadata.target_level}步骤区间不符；登记条数不证明真实步骤数`);
 if(basis.estimated_hours==null)warnings.push('专家业务人时未估算，等级尚无完整依据');
 else if(basis.estimated_hours<bound[3]||basis.estimated_hours>bound[4])warnings.push(`作者估计${basis.estimated_hours}小时，与${metadata.target_level}人时区间不符`);
 return warnings;
}
/** 兼容正文永远由逐份成果派生，不另让作者维护一份标答。 */
export function projectReference(value:any):string{
 return value.reference_outputs.map((output:any)=>{
  const file=value.deliverables.find((item:any)=>item.id===output.deliverable_id);
  const sheets=output.sheets.map((sheet:any)=>`工作表：${sheet.name}\n${JSON.stringify({columns:sheet.columns,rows:sheet.rows})}`).join('\n\n');
  return `## ${file?.path??output.deliverable_id}\n\n${output.content}${sheets?'\n\n'+sheets:''}`;
 }).join('\n\n');
}
export function projectRule(metadata:any):string{
 return `${metadata.statement}\n判定类型：${metadata.type}；重要性：${metadata.priority}；分值：${metadata.score===null?'独立否决，不计分':metadata.score}；档数：${metadata.points??'不适用'}；计数：${metadata.trigger_count??'按本条一次判定'}。`;
}
function fail(message:string):never{throw new Error(`Work 内容契约：${message}`);}
function object(value:any,label:string){if(!value||typeof value!=='object'||Array.isArray(value))fail(`${label}须为对象`);return value;}
function text(value:any,label:string,max=2000000){if(typeof value!=='string'||!value.trim()||value.length>max)fail(`${label}须为非空文本`);}
function list(value:any,label:string,min=0,max=500){if(!Array.isArray(value)||value.length<min||value.length>max)fail(`${label}数组数量无效`);return value;}
function names(value:any,label:string,min=0,max=500){list(value,label,min,max).forEach(v=>text(v,label,2000));if(new Set(value).size!==value.length)fail(`${label}重复`);}
function keys(value:any,allowed:readonly string[],label:string,required=allowed){object(value,label);if(Object.keys(value).some(key=>!allowed.includes(key))||required.some(key=>!Object.hasOwn(value,key)))fail(`${label}字段缺失或未知`);}
function path(value:any){text(value,'成果路径',200);if(Buffer.byteLength(value)>200||/[\\\x00-\x1f\x7f]/.test(value)||value.startsWith('/')||/^[a-z]:/i.test(value)||value.split('/').some((part:string)=>!part||part==='.'||part==='..'))fail('成果须为安全相对路径');}
const weights:Record<string,number|null>={'Critically Important':10,Important:7,'Slightly Important':3,'Slightly Detrimental':-3,Detrimental:-7,'Critically Detrimental':-10,Veto:null};
/** 新Work完整题和本项目新交付共用的数量、Office格式与评分文件引用准入。 */
export function assertWorkBusinessRequirements(rubric:unknown,files:{path:string;format?:string}[]){
 const items=list(rubric,'Rubric',1,500);
 if(items.length<WORK_MIN_RUBRIC_ITEMS)fail(`完整题包Rubric至少${WORK_MIN_RUBRIC_ITEMS}项，当前${items.length}项；请从完整标准成果提炼独立判据`);
 list(files,'成果清单',1,100);const paths=new Set<string>();
 for(const file of files){
  path(file.path);const extension=file.path.split('.').at(-1)?.toLowerCase();
  if(!['docx','xlsx'].includes(extension??'')||file.format!==undefined&&file.format.toLowerCase()!==extension)fail(`业务成果须为DOCX/XLSX且格式一致：${file.path}`);
  if([...paths].some(other=>file.path===other||file.path.startsWith(other+'/')||other.startsWith(file.path+'/')))fail(`成果路径重复或层级冲突：${file.path}`);paths.add(file.path);
 }
 const ids=new Set<string>();
 for(const item of items){
  text(item.id,'Rubric ID',160);if(ids.has(item.id))fail(`Rubric ID重复：${item.id}`);ids.add(item.id);
  text(item.metadata?.statement??item.criterion,'完整判据');
  const refs=item.metadata?.evaluated_files;names(refs,'evaluated_files',1);
  if(refs.some((p:string)=>p!=='all'&&!paths.has(p))||refs.includes('all')&&refs.length!==1)fail(`evaluated_files引用无效：${item.id}`);
 }
}
/** 标准成果与公开文件要求的既有结构检查；出题和交付均不得丢失映射。 */
function validateWorkOutputs(value:any){
 const deliverables=list(value.deliverables,'成果清单',1,100),paths=new Set(),ids=new Set();
 for(const file of deliverables){keys(file,['id','path','format','description','required'],'成果');text(file.id,'成果ID',160);path(file.path);text(file.format,'格式',80);text(file.description,'成果说明',4000);if(typeof file.required!=='boolean'||ids.has(file.id)||paths.has(file.path)||file.path.split('.').at(-1)?.toLowerCase()!==file.format.toLowerCase())fail('成果ID/路径重复或格式不匹配');ids.add(file.id);paths.add(file.path);}
 text(value.question,'题面');
 const hiddenRequired=deliverables.filter((file:any)=>file.required&&!value.question.includes(file.path));
 if(hiddenRequired.length)fail(`必交成果未在题面列明：${hiddenRequired.map((file:any)=>file.path).join('、')}`);
 const outputs=list(value.reference_outputs,'标准成果',1,100),outputIds=new Set();
 for(const output of outputs){keys(output,['deliverable_id','content','sheets'],'标准成果');if(!ids.has(output.deliverable_id)||outputIds.has(output.deliverable_id))fail('标准成果引用越界或重复');outputIds.add(output.deliverable_id);text(output.content,'完整成果正文');const sheets=list(output.sheets,'工作表',0,100);const sheetNames=new Set();for(const sheet of sheets){keys(sheet,['name','columns','rows'],'工作表');text(sheet.name,'工作表名',31);if(sheetNames.has(sheet.name))fail('工作表名重复');sheetNames.add(sheet.name);names(sheet.columns,'列名',1,1000);for(const row of list(sheet.rows,'行',0,100000)){if(!Array.isArray(row)||row.length!==sheet.columns.length||row.some(cell=>!['string','number','boolean'].includes(typeof cell)||typeof cell==='number'&&!Number.isFinite(cell)))fail('工作表行/列无效');}}const file=deliverables.find((d:any)=>d.id===output.deliverable_id);if(file.format.toLowerCase()==='xlsx'&&!sheets.length)fail('xlsx须提供结构化工作表');}
 if(outputIds.size!==ids.size)fail('每份成果必须有对应完整标准内容');
 return{deliverables,paths,ids};
}
/** 仅用于重新生成Work交付；历史读取不调用，不修改冻结题包。 */
export function assertWorkSubmissionReady(value:any){
 if(value.content_status?.status!=='complete'||!Array.isArray(value.content_status.issues)||value.content_status.issues.length)fail('交付须使用内容完整的题包，请先完成返修');
 if(value.task_metadata?.instruction!==undefined&&value.question!==renderWorkInstruction(value.task_metadata.instruction,value.deliverables))fail('题面与结构化任务说明不一致');
 const {deliverables}=validateWorkOutputs(value);
 assertWorkBusinessRequirements(value.rubric,deliverables);
}
/** 返回无丢字段的规范内容及派生兼容值；重复调用保持相同结果。 */
export function normalizeWorkQuestion(raw:any,materials:{id:string;text:string}[]):any{
 const value=JSON.parse(JSON.stringify(raw,(_key,entry)=>{if(typeof entry==='number'&&!Number.isFinite(entry)||typeof entry==='undefined'||typeof entry==='function'||typeof entry==='bigint')fail('必须为有效JSON');return entry;}));
 if(value?.task_metadata?.instruction!==undefined){const question=renderWorkInstruction(value.task_metadata.instruction,value.deliverables);if(value.question!==undefined&&value.question!==question)fail('题面与结构化任务说明不一致');value.question=question;}
 const core=['task_name','task_type','header','question','attachment_ids','rubric','answer_approach','content_contract','task_metadata','input_files','deliverables','reference_outputs','research_records','task_requirements','content_status'];
 keys(value,[...core,'reference_answer','answer_requirements'], '题包',core);
 if(value.content_contract!==WORK_CONTENT_CONTRACT)fail('契约标识无效');
 const md=value.task_metadata,mdKeys=['occupation','scenario','role_perspective','domain_l2','capabilities','professional_knowledge','vl_dependency','source_note','generation_note','tools','target_level','level_basis'];keys(md,[...mdKeys,'instruction'],'整题信息',mdKeys);
 for(const field of ['occupation','scenario','role_perspective','source_note','generation_note'])text(md[field],field,4000);
 if(md.domain_l2!==null)text(md.domain_l2,'domain_l2',4000);
 names(md.capabilities,'评测能力',2,4);names(md.professional_knowledge,'专业知识',1);names(md.tools,'业务工具');
 if(typeof md.vl_dependency!=='boolean'||!['L2','L3','L4','L5'].includes(md.target_level))fail('视觉依赖或目标等级无效');
 const basis=md.level_basis;keys(basis,['documents','necessary_steps','estimated_hours','explanation'],'等级依据');
 names(basis.necessary_steps,'必要工作',1);text(basis.explanation,'等级说明');
 if(basis.estimated_hours!==null&&(typeof basis.estimated_hours!=='number'||!Number.isFinite(basis.estimated_hours)||basis.estimated_hours<=0))fail('估计人时须为正数或null');
 const docIds=new Set();for(const doc of list(basis.documents,'独立文书',1,10000)){keys(doc,['id','attachment_id','locator','description'],'文书');for(const key of Object.keys(doc))text(doc[key],key,4000);if(!materials.some(m=>m.id===doc.attachment_id)||docIds.has(doc.id))fail('文书引用越界或重复');docIds.add(doc.id);}
 const inputs=list(value.input_files,'输入映射',1,1000);if(inputs.length!==materials.length)fail('输入映射数量与本次材料不一致');
 inputs.forEach((file:any,index:number)=>{keys(file,['attachment_id','name','description'],'输入映射');if(file.attachment_id!==materials[index]?.id||file.name!==`附件${index+1}`)fail('输入映射须按本次附件顺序和可见名称填写');text(file.description,'材料说明',4000);});
 const {deliverables,paths,ids}=validateWorkOutputs(value);
 const requirements=value.task_requirements;keys(requirements,['input_mode','output_mode','tools'],'业务能力');names(requirements.tools,'必要工具');if(!['text','image'].includes(requirements.input_mode)||!['text','file'].includes(requirements.output_mode))fail('业务能力无效');
 keys(value.content_status,['status','issues'],'内容状态');names(value.content_status.issues,'内容缺口');if(!['complete','draft'].includes(value.content_status.status)||value.content_status.status==='complete'&&value.content_status.issues.length||value.content_status.status==='draft'&&!value.content_status.issues.length)fail('完成/草稿状态与缺口矛盾');
 const researchIds=new Set();for(const research of list(value.research_records,'检索记录',value.content_status.status==='complete'?1:0,5000)){keys(research,['id','query','source_url','source_title','version','findings','verification_status','supports'],'检索记录');for(const key of ['id','query','source_title','version','findings'])text(research[key],key);if(researchIds.has(research.id))fail('检索ID重复');researchIds.add(research.id);names(research.supports,'检索关联');if(!['verified','unverified'].includes(research.verification_status))fail('检索状态无效');if(research.source_url!==null){let url:URL;try{url=new URL(research.source_url);}catch{fail('来源URL无效');}if(!['http:','https:'].includes(url!.protocol)||url!.username||url!.password)fail('来源URL无效');}if(research.verification_status==='verified'&&!research.source_url)fail('已核验记录须有正文来源');}
 const dimensionErrors:string[]=[];
 if(md.instruction!==undefined&&Array.isArray(value.rubric)&&value.rubric.some((item:any)=>!WORK_DIMENSIONS.includes(item?.metadata?.dimension)))fail('新题dimension须使用schema提供的完整维度名称');
 const rubric=list(value.rubric,'Rubric',1,500),rubricIds=new Set(),dimensions=new Set<number>(),qs=new Set<string>();let positive=0,anchor=0,critical=0,subjective=0,veto=0;
 const f=/^F([1-5])(?:\s|$)/.exec(value.task_type);if(!f)fail('主类型须为 F1–F5');const anchors:Record<string,string[]>={'1':['Q3','Q4'],'2':['Q2','Q3'],'3':['Q1','Q4'],'4':['Q4','Q6'],'5':['Q1','Q5']};
 for(const [index,item] of rubric.entries()){keys(item,['id','metadata','criterion','rule'],'评分项',['id','metadata']);const m=item.metadata;keys(m,WORK_RUBRIC_FIELDS,'评分原始字段');text(m.statement,'完整判据');text(m.dimension,'维度',200);if(rubricIds.has(item.id))fail('Rubric ID重复');rubricIds.add(item.id);const match=/^R([0-7])-([PNV])\d+$/.exec(item.id),dimension=/^([0-7])-/.exec(m.dimension),q=/\/Q([1-7])/.exec(m.dimension);if(!match||!dimension||match[1]!==dimension[1]){dimensionErrors.push(`第${index+1}项（${match?item.id:'ID格式无效'}，dimension一级=${dimension?.[1]??'无效'}）`);continue;}const dim=Number(dimension[1]);if(dim)dimensions.add(dim);if(dim===2){if(!q)fail('内容质量须标记Q');qs.add('Q'+q[1]);}else if(q)fail('Q只能属于维度2');if(!Object.hasOwn(weights,m.priority)||weights[m.priority]!==m.score)fail('priority与score不一致');if(!['Objective','Subjective'].includes(m.criterion_type)||!['Explicit','Implicit'].includes(m.criterion_necessity))fail('判据分类无效');if(m.criterion_type==='Subjective')subjective++;for(const key of ['evaluated_files','knowledge_points','atomic_capabilities'])names(m[key],key,key==='evaluated_files'?1:0,key==='atomic_capabilities'?3:500);if(m.evaluated_files.some((p:string)=>p!=='all'&&!paths.has(p))||m.evaluated_files.includes('all')&&m.evaluated_files.length!==1)fail('evaluated_files引用无效');if(m.atomic_capabilities.some((p:string)=>!WORK_ATOMIC_CAPABILITIES.includes(p)))fail('原子能力须使用规范名称，不猜测编码');if(m.knowledge_points.some((p:string)=>!/^.+::.+$/.test(p)))fail('知识点须为法律域::具体知识点');if(m.knowledge_points.some((p:string)=>p.split('::')[0].trim()==='法律域'))fail('知识点须填写实际法律领域，不能保留格式占位');if(!['binary','likert'].includes(m.type)||m.points!==(m.type==='likert'?5:null))fail('type与points不一致');if(m.type==='likert'&&![5,4,3,2,1].every(n=>new RegExp(`(?:^|[^0-9])(?:\\*{0,2})${n}\\s*(?:分|档|[:：=＝])`).test(m.statement)))fail('likert须在statement中明确5/4/3/2/1档');if(m.trigger_count!==null)text(m.trigger_count,'计数规则',4000);if(m.score===null){veto++;if(item.id!=='R0-V01'||dim!==0||match[2]!=='V'||m.type!=='binary')fail('独立否决结构无效');}else{if(!dim||match[2]!== (m.score>0?'P':'N'))fail('ID正负方向无效');if(m.score>0){if(dim===5||q?.[1]==='7')fail('安全底线和Q7不设普遍正向项');positive+=m.score;if(m.score===10)critical++;if(anchors[f![1]!]!.includes(q?'Q'+q[1]:''))anchor+=m.score;if(m.trigger_count!==null)fail('正项不使用累计计数');}}const derived=projectRule(m);if(item.criterion!==undefined&&item.criterion!==m.statement||item.rule!==undefined&&item.rule!==derived)fail('派生判据与原始标准不一致');item.criterion=m.statement;item.rule=derived;}
 // 同次反馈全部错配，避免作者逐个猜测；只包含受限ID/维度标识，不输出判据或自动纠正。
 if(dimensionErrors.length)fail(`Rubric ID与维度不一致：${dimensionErrors.slice(0,20).join('；')}${dimensionErrors.length>20?`；另有${dimensionErrors.length-20}项`:''}`);
 if(value.content_status.status==='complete'&&(![1,2,5].every(d=>dimensions.has(d))||[3,4,6,7].filter(d=>dimensions.has(d)).length<2||qs.size<3||!anchors[f![1]!]!.every(q=>qs.has(q))||positive<=0||anchor/positive<.3||critical<2||subjective/rubric.length>.1||veto!==1))fail('维度、锚点、权重、主观比例或独立否决不符合规范');
 for(const r of value.research_records)if(r.supports.some((id:string)=>!ids.has(id)&&!rubricIds.has(id)))fail('检索关联对象不存在');
 if(value.content_status.status==='complete')assertWorkBusinessRequirements(value.rubric,deliverables);
 const reference=projectReference(value);if(value.reference_answer!==undefined&&value.reference_answer!==reference)fail('兼容标答与逐成果内容不一致');value.reference_answer=reference;
 const runner={input_mode:'text',output_mode:'text',tools:[]};if(value.answer_requirements!==undefined&&(value.answer_requirements.input_mode!=='text'||value.answer_requirements.output_mode!=='text'||!Array.isArray(value.answer_requirements.tools)||value.answer_requirements.tools.length||Object.keys(value.answer_requirements).some(k=>!['input_mode','output_mode','tools'].includes(k))))fail('本地runner能力字段不可改写');value.answer_requirements=runner;
 return value;
}
