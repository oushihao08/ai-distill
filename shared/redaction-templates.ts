/** 职责：材料脱敏模板的共享身份与默认代称提示词；执行和存储由材料库负责，不改变下游题目契约。 */
export type RedactionWorkflow = 'codex_plan';
export interface LibraryRedactionTemplate {id:string;name:string;workflow:RedactionWorkflow;redaction:Record<string,any>}
/** 新打开的材料处理入口优先选择Agent整包模板；未配置时留空，避免静默改走字段映射。 */
export function defaultLibraryRedactionTemplateId(templates:ReadonlyArray<{id:string;workflow:string}>):string{
 return (templates.find(t=>t.id==='aliases'&&t.workflow==='codex_plan')??templates.find(t=>t.workflow==='codex_plan'))?.id??'';
}
export const AGENT_REDACTION_MAX_MS=10*60*1000;
export const ALIAS_REDACTION_PROMPT = `处理整个材料包，完成垃圾清理、主体化名和独立文书划分，供后续出题、作答、评分和DOCX交付使用。

【基本要求】
通读全部材料，只清理垃圾和替换敏感片段。其他原文、换行、表格、列表和业务顺序保持不变，不纠错、补写或概括；已有脱敏内容原样保留。

【保留的信息】
业务事实、案由、原因、程序状态、裁判结果、所有真实日期时间（含出生及结婚登记日期）、婚姻状况、金额、比例、利率和期限均保留。纯数字字段也按上下文判断，不能把金额当编号遮盖。法院、银行、邮政的名称保留；它们的账号、单号等识别号码仍需脱敏。商品和车型不是主体名称。

【主体化名】
- 将自然人、单位、企业、律所等主体换为合理、日常的虚构名称。名称尽量随机多样，不反复使用固定的一套名字，不用甲乙、编号或随机字符充当姓名；企业保留原有主体类型、行业和组织形式，不编造额外背景。
- 先识别全包主体，再统一替换。同一主体的全称、简称、签名和确认属于同一人的OCR异写共用一个化名，不同主体不重名。不确定是否同一主体时分开处理，不凭相似合并。
- 对应表仅存私有目录；同次续作沿用已确认化名。公开标题和文件名不含真实主体身份。

【其他敏感信息】
- 案号、证件号、账号、单号等识别编号保留首2末2，中间逐位遮盖，不足5位全遮；空格和连字符保留，案件类型字样不遮盖。页码、序号和法条序号不是识别编号。
- 电话保留前3末2，中间遮盖，不足6位全遮；区号连字符保留，公共服务热线不处理。验证码、查询密码等凭据全部替换为“**”。
- 地址保留到能确认的区县，其后遮盖；没有区县时保留能确认的上级行政区划，无法确认则全遮。籍贯只留省，邮编遮盖。小区名、楼栋不是行政区划。

【清理垃圾】
只删确认的垃圾片段，正文中的日期、数字、金额及条款保留；不能确认的噪声保留。
- 扫描水印：如“57660_2024-12-04 10:29:09”，包括下划线带转义、变为空格、与页角数字粘连的形式。
- 无语义页角码和独立扫描戳：如“C89”“[ C ]60”“004”“57****31”“00****ml”。保留正文页数说明、证据页码范围及已遮盖的业务编号。
- 工具占位标记：如“[Image]”“[QR Code]”“[Barcode]”及独立的“无法识别”。明确属于同一个条码对象的紧邻编号一起删，附近普通编号保留。
- 扫描乱码、印刷规格及打印页眉页脚：如无关公式、“图2.10”“B712 210×285mm”、“□电话人”、打印日期、“1/1”、“file:///…”和“.html/.htm”文件名；须根据所在位置和正文判断，不能按关键词全局误删。
- 独立无意义符号行可删，例如单独的“**”；原文已有的脱敏星号或有意义的字段值保留。
格式残留由程序还原，例如将“$50\\%$”还原为“50%”，将“\\_”还原为“_”。

【交付结果】
按程序给定格式保存主体对应、敏感片段和文书划分计划，由程序完成替换和结构输出，不改写全文。
按真实完整文书划分，跨页同一文书合并，同页多份分别识别，表格和列表不拆散；全部正文均有归属。重复扫描保留并关联，局部边界不清可保留为组合文书，不按页、目标份数或整卷一概分册。
只对未安全处理的敏感片段或缺失正文标记阻断；已安全处理的身份归并或局部分界疑点可说明后保留。完成后运行指定校验，修正实际错误，不逐页另开模型或增加审查轮次。`;
/** 当前模板仅提供Agent化名；旧字段映射模板不再解析为可执行配置。 */
export function libraryRedactionTemplates(settings:Record<string,any>):LibraryRedactionTemplate[]{
 const configured=[...(settings.redaction_templates??[])];
 if(!configured.some((t:LibraryRedactionTemplate)=>t.id==='aliases'&&t.workflow==='codex_plan'))configured.push({id:'aliases',name:'Agent整包化名脱敏与分册',workflow:'codex_plan',redaction:{provider:'codex',prompt:ALIAS_REDACTION_PROMPT}});
 return configured.filter((t:LibraryRedactionTemplate)=>t.workflow==='codex_plan'&&t.id!=='mask');
}
