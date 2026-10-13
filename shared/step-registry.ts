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
  { key: 'accept_or_revise', ordinal: 7, position: 6, name: '达标判断', handler: 'decision', defaultEnabled: true, required: false, visible: true },
  { key: 'publish_export', ordinal: 8, position: 7, name: '归档达标题目', handler: 'publish', defaultEnabled: true, required: false, visible: true },
] as const;

export type StepKey = typeof STEP_REGISTRY[number]['key'];
export const STEP_BY_KEY = Object.fromEntries(STEP_REGISTRY.map(step => [step.key, step])) as Record<StepKey, typeof STEP_REGISTRY[number]>;
export const STEP_BY_ORDINAL = Object.fromEntries(STEP_REGISTRY.map(step => [step.ordinal, step])) as Record<number, typeof STEP_REGISTRY[number]>;

export const DEFAULT_REDACTION_PROMPT = `只对输入中明确属于个人信息、主体身份信息或敏感标识的内容脱敏。除敏感内容外，原文必须保持不变。相同主体在全文使用一致的替换形式；不得扩大到相邻非敏感文字。

<脱敏规则>
- 姓名：保留姓氏，名字替换为“**”；复姓保留完整姓氏。
- 主体名称：遮盖具体字号，保留行业通称和组织形式；同时遮盖可能暴露主体身份的地区或品牌字号。
- 法院名称：遮盖地区和具体法院名称，保留“人民法院”等机构通称。
- 案号、代码、账号及其他识别编号：首2位、末2位保留，中间逐位替换为“*”；不足5位时全部替换为“*”。
- 电话：保留前3位和末2位，中间逐位替换为“*”；不足6位时全部替换为“*”。
- 地址：最多保留到区/县，其后具体地址脱敏；未提供区/县时，只保留可确认的上级行政区划。
- 具体金额：遮盖数字，保留原文明确的币种和单位；不换算或推测金额。
- 国家秘密、商业秘密或其他专属标识：编号按首2位、末2位保留，其余逐位替换为“*”；非编号秘密值替换为“**”。
</脱敏规则>`;

/** Register a new step here with a unique stable key/ordinal and project order. */
export function getStepDefinition(key: string) {
  return STEP_REGISTRY.find(step => step.key === key);
}
