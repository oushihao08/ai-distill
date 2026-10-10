/**
 * 文件职责：维护工作流步骤稳定 key、数据库 ordinal 与界面 position 的对应关系。
 * 关键导出与用法：STEP_REGISTRY 是步骤定义源，STEP_BY_KEY／STEP_BY_ORDINAL 提供索引，getStepDefinition(key) 按 key 查询；服务端装配步骤、前端汇总显示共用该注册表。新增步骤必须分配新 ordinal，不重编号历史记录。
 */
export const STEP_REGISTRY = [
  { key: 'receive_materials', ordinal: 1, position: 1, name: '入库（含PDF文本提取）', handler: 'intake', defaultEnabled: true, required: true, visible: true },
  // Kept as an internal attempt identity for extraction history and retries.
  { key: 'extract_text', ordinal: 2, position: 99, name: 'PDF文本提取', handler: 'extract', defaultEnabled: false, required: false, visible: false },
  { key: 'redact_materials', ordinal: 9, position: 2, name: '脱敏与检查', handler: 'redact', defaultEnabled: true, required: false, visible: true },
  // Legacy attempt identity only; new workflows do not bind numbered project rules.
  { key: 'load_rules', ordinal: 3, position: 99, name: '历史规则绑定', handler: 'rules', defaultEnabled: false, required: false, visible: false },
  { key: 'author_question', ordinal: 4, position: 3, name: '出题', handler: 'author', defaultEnabled: true, required: false, visible: true },
  { key: 'model_answer', ordinal: 5, position: 4, name: '模型作答', handler: 'answer', defaultEnabled: true, required: false, visible: true },
  { key: 'independent_score', ordinal: 6, position: 5, name: '独立评分', handler: 'score', defaultEnabled: true, required: false, visible: true },
  { key: 'accept_or_revise', ordinal: 7, position: 6, name: '达标或返修', handler: 'decision', defaultEnabled: true, required: false, visible: true },
  { key: 'publish_export', ordinal: 8, position: 7, name: '归档达标题目', handler: 'publish', defaultEnabled: true, required: false, visible: true },
] as const;

export type StepKey = typeof STEP_REGISTRY[number]['key'];
export const STEP_BY_KEY = Object.fromEntries(STEP_REGISTRY.map(step => [step.key, step])) as Record<StepKey, typeof STEP_REGISTRY[number]>;
export const STEP_BY_ORDINAL = Object.fromEntries(STEP_REGISTRY.map(step => [step.ordinal, step])) as Record<number, typeof STEP_REGISTRY[number]>;

export const DEFAULT_REDACTION_PROMPT = `你是文书转写与脱敏工具。只处理本次提供的附件，不参考外部资料、历史任务或文件名推断正文。

<任务>
按阅读顺序转写附件中可辨认的正文、表格、条款、落款，以及签章中实际可读的文字。对明确属于个人信息、主体身份信息或敏感标识的内容，按下列规则脱敏。除脱敏外，不改写、纠错、摘要或补充原文。
</任务>

<处理顺序>
1. 仅转写页面上属于文书本身的可读内容。
2. 删除扫描软件水印、OCR/提取日志、任务标识及未印在文书正文中的文件元数据；保留正文中的日期、文书编号、条款序号等内容，并按对应规则脱敏。
3. 按脱敏规则替换敏感内容。
4. 无法辨认的字词不猜、不补写、不标注；跳过无法辨认部分。无可转写文字的页面正文留空。
</处理顺序>

<转写规则>
- 保持正文阅读顺序和原有措辞；页与页直接衔接，不在正文中标页码或插入分页分隔符。
- 表格按行转写，保留可见的字段和值之间的对应关系；不确定单元格关系时，按页面阅读顺序平铺，不自行推断。
- 只转写签章、印章或签名中实际可辨认的文字；不描述图案、印章样式或签名外观。
- 不在正文中输出页码、扫描水印、文件名、任务号、OCR日志、置信度、坐标、识别过程、解释或总结。不得自行添加空白页、印章、图片、无法识别等说明或占位符。
- 不删除正文中真实存在的内容；仅跳过页码、扫描/OCR元数据及无法辨认部分。
</转写规则>

<脱敏规则>
仅替换明确识别出的敏感字段；不得扩大脱敏范围或改动相邻非敏感文字。相同主体在全文中使用一致的替换形式。
- 姓名，包括当事人、代理人、审判人员、签名等：保留姓氏，名字统一替换为**；复姓保留完整姓氏。
- 主体名称：遮盖具体字号，保留可确定的行业通称和组织形式；同时遮盖可能暴露主体身份的地区或品牌字号。格式示例：**科技有限公司。
- 法院名称：遮盖地区及具体法院名称，保留人民法院等机构通称。
- 案号及其他具有识别作用的编号、代码、账号：保留首2位和末2位，中间每位替换为*；长度不足5位时全部替换为*。原有分隔符可保留。
- 身份证件号、统一社会信用代码、银行账号：按上一条处理。
- 电话号码：保留前3位和末2位，中间每位替换为*；长度不足6位时全部替换为*。
- 地址：最多保留到区/县；遮盖其后的街道、道路、门牌、小区、楼栋、房间等具体地址。原文未提供区/县时，只保留可确认的上级行政区划。
- 价款、标的额、账号余额及其他具体金额：遮盖具体数字；保留原文明确写出的币种和单位。不得自行换算金额或推测数量级。
- 其他明确属于个人、国家秘密或商业秘密的识别码、密钥、专属标识：数字或字母数字编号按首2位、末2位保留，中间逐位替换为*；非编号形式的秘密值整体替换为**，其余句子保持原样。
</脱敏规则>

<输出约束>
遵循调用方规定的结构化返回格式，并保留每个附件标识、每页页码及页面顺序。每页正文只能放在对应的文本字段中；字段内容只含脱敏后的正文，不含附件名、页码、分页标签、元数据、开场白、总结或免责声明。空白页或正文完全无法辨认的页面保留对应结构，正文留空。不得在正文中输出任何占位符或方括号标记。
</输出约束>`;

/** Register a new step here with a unique stable key/ordinal and project order. */
export function getStepDefinition(key: string) {
  return STEP_REGISTRY.find(step => step.key === key);
}
