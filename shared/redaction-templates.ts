/** 职责：材料脱敏模板的共享身份与默认代称提示词；执行和存储由材料库负责，不改变下游题目契约。 */
export type RedactionWorkflow = 'field_mapping'|'codex_plan';
export interface LibraryRedactionTemplate {id:string;name:string;workflow:RedactionWorkflow;redaction:Record<string,any>}
/** 新打开的材料处理入口优先选择Agent整包模板；未配置时留空，避免静默改走字段映射。 */
export function defaultLibraryRedactionTemplateId(templates:ReadonlyArray<{id:string;workflow:string}>):string{
 return (templates.find(t=>t.id==='aliases'&&t.workflow==='codex_plan')??templates.find(t=>t.workflow==='codex_plan'))?.id??'';
}
export const AGENT_REDACTION_MAX_MS=10*60*1000;
export const ALIAS_REDACTION_PROMPT = `处理本次冻结提取任务的完整材料包，沿文书连续阅读全部结构文本，一轮同时建立主体对应表、独立文书边界和必要的清理记录。按完整文书成组处理，不逐页建立模型任务或重复审查；不重跑OCR，不从其他案件补写。
自然人改为固定、自然的虚构姓名；企业使用固定虚构名称，保留可确定的行业和组织形式。不要使用人员甲乙丙等占位称呼。全称、简称、签名和可确认OCR异写共用同一主体ID及化名；不同主体不混用，化名避开原文已有名称。同名、简称或异写有歧义时按具体字段限定范围，不能凭相似合并。主体原名表和出现依据仅保存私有工作目录，读取、修改和恢复都以此表为准。
法院名称保留正式全称；银行、邮政名称保留。证件号、案号、账号等识别编号保留首2末2，中间逐位星号，不足5位全遮；空格和连字符保持。电话保留前3末2，公共服务热线保留。地址保留到可确认的行政区县，后缀遮盖；不要把住宅小区的“区”当行政区县。原件自带遮盖原样保留，不反推身份。
业务事实、原因、案由、程序状态、裁判结果及真实日期、时间、金额、利率、比例、期限保留。仅清除明确的扫描水印、无语义页角戳号、识别占位噪声；不确定垃圾保留。只修改敏感片段，不遮盖整句业务内容，不改写或纠错全文。
按本次提供的语义计划Schema输出：主体表、字段中的原文片段及处理类别、文书首尾结构块ID、未决项。程序负责准确定位、UTF-16坐标、星号规则和修改后分册范围；不要手算坐标或自行写替换脚本。所有正文均有去向；重复扫描保留并记录关联，不擅自删除。表格/列表保持完整，跨页同一文书合并，同页多件按完整结构块划分，不能按份数目标拆条款或表格行。
不确定性的处理：边界不清的连续附件完整保留为组合文书，不凭猜测拆分；文书份数不是发布门槛。不确定是否同一主体时不合并，疑似姓名或企业名称可用独立主体ID、固定化名和具体字段作用域安全替换，在私有表记录未确认的对应关系；不能借此删除业务事实或把普通业务术语当姓名。已遮盖的名称保留原状。处理后仍可说明非阻断疑点，不能把OCR异写、身份归并或分册精度尚未确认本身设为阻断；仅敏感片段尚未安全处理或正文无法完整覆盖时标blocking=true。
将主体表和阶段性计划及时写入output私有目录，成功片段可复用；疑点集中列出，不为每页增加复核轮次。单次执行总预算最多10分钟，到限停止、保留进度并报告，不自行追加重试。材料标题/文件名不含真实主体身份；正文不加入页定位、OCR说明或处理痕迹。`;
/** 旧设置无需回写即可读取默认模板；mask始终引用既有共用脱敏配置。 */
export function libraryRedactionTemplates(settings:Record<string,any>):LibraryRedactionTemplate[]{
 const configured=[...(settings.redaction_templates??[])];
 if(!configured.some((t:LibraryRedactionTemplate)=>t.id==='aliases'))configured.push({id:'aliases',name:'Agent整包化名脱敏与分册',workflow:'codex_plan',redaction:{provider:'codex',prompt:ALIAS_REDACTION_PROMPT}});
 return [{id:'mask',name:'原有字段映射脱敏',workflow:'field_mapping',redaction:settings.redaction},...configured];
}
