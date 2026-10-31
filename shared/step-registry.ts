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

/** 旧步骤9配置/提示词的兼容默认值；不表示字段映射引擎仍执行。新库Agent模板见redaction-templates.ts。 */
export const DEFAULT_REDACTION_PROMPT = `你将对一份由OCR扫描得到的法律文书文本做“清理+脱敏”。严格按以下顺序处理，只输出处理后的完整全文，不要任何解释、摘要、前后缀或代码块，不得截断，保持原有换行、表格和缩进。

【总原则】
- 除下列要清理和脱敏的内容外，原文一字不改，包括错别字、OCR错误、标点、空格；不纠错、不补全、不合并或重排段落。
- 原文中已脱敏的内容（含“*”的片段）原样保留，不增减星号。
- 同一原文片段在全文中使用相同的替换结果。
- 拿不准是否属于敏感信息时，按敏感处理；拿不准是否属于垃圾信息时，保留。
- 脱敏只作用于敏感信息本身，不扩大到相邻文字。

【第一步：清理垃圾信息（直接删除，只删该内容本身）】
1. 扫描水印：形如“数字串+下划线（可带\\转义）或空格+YYYY-MM-DD+HH:MM:SS”的内容，例如“57660\\_2024-12-04 10:29:09”“8836_2025-03-26 15:20:36”，含前缀位数不一致、下划线变空格、与页码粘连等变体。出现在句子中间时只删水印，不合并上下文。正文中的真实日期和时间不得删除。
2. 页码和页角标：独占一行且无语义的“C+数字”“CC5”“c89”“[30]”“[ C ]60”“004”“C.98”等，以及位于页边界的孤立数字。正文中的“第x页共y页”、证据页码范围、序号不得删除。
3. 页面戳号：形如“57****…**31”、以“ml”结尾的“00****…ml”等独占一行的编号戳。
4. 图像占位符和说明：“[QR Code]”“[Image]”“无法识别”等识别工具产生的标记。
5. 识别痕迹和幻觉：与上下文无关的公式或数学题、“图 2.10”“B712 210×285mm”这类印刷规格、无法构成可读语义的乱码和倒置文字、重复的“□电话人”类噪声。
6. 浏览器打印页眉页脚：打印日期（如“2017/12/6”）、“1/1”、本地文件路径（file:///…）、“…html/.htm”文件名。
7. 格式残留：将“$50\\%$”还原为“50%”，将“\\_”还原为“_”，将“\\*”还原为“*”。
8. 孤立无意义符号行（如单独成行的“**”）。

【第二步：脱敏】
- 姓名：保留姓氏，名字替换为“**”，复姓保留完整姓氏。适用于当事人、代理人、法官、书记员、律师、经办人、投递员、联络人等所有自然人。
- 主体名称（公司、律所、印刷厂等）：遮盖字号和地区，保留行业通称和组织形式，统一写为“****”+通称+组织形式。含英文名称的同样处理。商品和车型（如汽车品牌型号）不属于主体名称，不处理。银行、邮政名称保留；法院名称按下条规则处理。
- 法院名称：统一替换为“人民法院”。网站名称不适用本条，按下条保留。
- 网站名称、域名和网址（URL）：保留，不脱敏。如果网址参数中直接包含账号、证件号、手机号、验证码或查询密码，只按对应规则处理该参数值。
- 案号、证件号、账号、单号、核准号、柜员号、网点号、时间戳等识别编号：按去掉空格和连字符后的位数计算，首2位和末2位保留，中间逐位替换为“*”，不足5位全部替换为“*”，分隔符原位保留。页码、序号、法条序号、车型年款、案号中的案件类型字样不属于识别编号。
- 验证码、查询密码、随机字符串型凭据：全部替换为“**”。
- 电话：保留前3位和末2位，中间逐位替换为“*”，不足6位全部替换为“*”；区号连字符原位保留；公共服务热线（如11183）不处理。
- 地址：最多保留到区/县，其后全部遮盖；未提供区/县时只保留可确认的上级行政区划。备注和手写说明里夹带的小区名、楼栋、邮编同样按地址处理。籍贯保留到省。
- 出生日期、婚姻状况、结婚登记日期：全部遮盖。
- 金额：遮盖数字，保留币种和单位。汉字大写金额（如“伍万元整”）中的数字字符和数位字符全部替换为“*”，保留“人民币”“元整”。比例、利率、期限（2%、10%、15个自然日）不是金额，保留。不换算、不推测。

【输出】
- 本系统通过字段映射返回处理结果。严格按本次调用提供的JSON Schema返回完整字段映射；每个输入字段均须出现，没有敏感内容的字段返回空数组。
- 只返回接口要求的JSON，不要解释、摘要、前后缀或代码块；不要生成或改写全文。程序按原有结构应用映射并生成处理后的完整文本。`;

/** Register a new step here with a unique stable key/ordinal and project order. */
export function getStepDefinition(key: string) {
  return STEP_REGISTRY.find(step => step.key === key);
}

/** 返回指定项目后端和工作流类型适用的可见步骤，不更改稳定 ordinal。 */
export function getWorkflowStepDefinitions(materialBackend: 'legacy' | 'library_v1', workflowKind: 'question' | 'material_package' = 'question') {
  if (workflowKind === 'material_package') return STEP_REGISTRY.filter(step => step.visible && (step.ordinal === 1 || step.ordinal === 9));
  if (materialBackend === 'library_v1') return STEP_REGISTRY.filter(step => step.visible && step.ordinal >= 4 && step.ordinal <= 8);
  return STEP_REGISTRY.filter(step => step.visible);
}
