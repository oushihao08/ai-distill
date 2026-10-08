/**
 * Stable workflow step identities. `ordinal` is a persistent storage identity;
 * `position` is only the project-facing order. New processors get a new key and
 * storage identity instead of renumbering existing workflow history.
 */
export const STEP_REGISTRY = [
  { key: 'receive_materials', ordinal: 1, position: 1, name: '入库（含PDF文本提取）', handler: 'intake', defaultEnabled: true, required: true, visible: true },
  // Kept as an internal attempt identity for extraction history and retries.
  { key: 'extract_text', ordinal: 2, position: 99, name: 'PDF文本提取', handler: 'extract', defaultEnabled: false, required: false, visible: false },
  { key: 'redact_materials', ordinal: 9, position: 2, name: '脱敏与检查', handler: 'redact', defaultEnabled: true, required: false, visible: true },
  { key: 'load_rules', ordinal: 3, position: 3, name: '加载本期规则', handler: 'rules', defaultEnabled: true, required: true, visible: true },
  { key: 'author_quality', ordinal: 4, position: 4, name: '出题与质检', handler: 'author', defaultEnabled: true, required: false, visible: true },
  { key: 'model_answer', ordinal: 5, position: 5, name: '模型作答', handler: 'answer', defaultEnabled: true, required: false, visible: true },
  { key: 'independent_score', ordinal: 6, position: 6, name: '独立评分', handler: 'score', defaultEnabled: true, required: false, visible: true },
  { key: 'accept_or_revise', ordinal: 7, position: 7, name: '达标或返修', handler: 'decision', defaultEnabled: true, required: false, visible: true },
  { key: 'publish_export', ordinal: 8, position: 8, name: '发布成果与导出', handler: 'publish', defaultEnabled: true, required: false, visible: true },
] as const;

export type StepKey = typeof STEP_REGISTRY[number]['key'];
export const STEP_BY_KEY = Object.fromEntries(STEP_REGISTRY.map(step => [step.key, step])) as Record<StepKey, typeof STEP_REGISTRY[number]>;
export const STEP_BY_ORDINAL = Object.fromEntries(STEP_REGISTRY.map(step => [step.ordinal, step])) as Record<number, typeof STEP_REGISTRY[number]>;

export const DEFAULT_REDACTION_PROMPT = '识别附件中的内容，并把识别完整信息通过文字完整逐页提取。注意输出来的信息包括但不限于对涉及到的主体名称、姓名、身份(识别)号码、地址、电话号码、价款金额、法院名称、案号以及其他涉及到个人信息、国家秘密、商业秘密的信息必须全部进行脱密脱敏类似 43****33，页码、占位符、[占位]都不要，去除所有的 ai 提取痕迹，输出给我';

/** Register a new step here with a unique stable key/ordinal and project order. */
export function getStepDefinition(key: string) {
  return STEP_REGISTRY.find(step => step.key === key);
}
