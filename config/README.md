<!-- 文件职责：说明材料提取配置文件的字段、调用路径和维护限制。 -->
# 材料提取配置

`extraction.json` 是旧智谱视觉/OCR 客户端的配置快照来源，不含密钥。`server/materials/config.ts` 从 `EXTRACTION_CONFIG_PATH` 指定的文件或此默认文件读取；当前旧 Vision 识别入口由 `server/materials/vision.ts` 使用。

`extractionPrompt`、`entityPrompt`、`reasoningEffort`、`ocrReasoningEffort`、`maxTokens` 和 `continueOnError` 被旧 Vision 客户端读取。`includePageHeadings`、`maskStyle`、`entityReview` 目前只参与配置校验/快照或兼容类型，不能据此认为当前解析器会添加页标题、采用该遮盖风格或执行实体复查。当前材料库提取使用 MinerU API/CLI 或 TXT/MD 本地解析；这些字段不控制该路径。

材料库 `processing_settings.extraction.provider_config` 会保存该配置快照，但当前库级提取 runner 不读取它来配置 MinerU；PDF provider 由任务创建时冻结的 provider 选择，DOCX 使用 MinerU API，TXT/MD 本地解析。旧项目的 MinerU provider 和服务端密钥由环境及任务创建逻辑解析，见 [材料模块](../server/materials/README.md)。第二步脱敏由独立材料脱敏配置控制，不应把旧 Vision 的提示词当作当前脱敏规则。

修改前核对当前调用路径和 provider；保留用户提示词，不随意扩大用途。JSON 不支持注释，字段说明写在本文，不往配置加入非标准注释。
