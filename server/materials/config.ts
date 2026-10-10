/**
 * 职责：提取配置读取：从 config/extraction.json 合并并校验文本识别、实体检查和脱敏兼容参数。
 * 关键方法与用途：`loadExtractionConfig()` 读取默认或指定 JSON、合并环境覆盖并校验识别和脱敏参数。
 * 使用场景：PDF 处理器和视觉客户端在创建任务时加载；不在前端暴露密钥。
 */
import { readFileSync } from 'node:fs';
export interface ExtractionConfig {
 maxTokens?: number;
 continueOnError?: boolean;
 entityReview?: boolean;
 extractionPrompt: string;
 entityPrompt: string;
 includePageHeadings: boolean;
 maskStyle: 'partial' | 'placeholder';
 reasoningEffort?: 'low' | 'high' | 'max';
 ocrReasoningEffort?: 'low' | 'high' | 'max';
}
export function loadExtractionConfig(): ExtractionConfig {
 try {
  const value = JSON.parse(readFileSync(process.env.EXTRACTION_CONFIG_PATH ?? new URL('../../config/extraction.json', import.meta.url), 'utf8'));
  if (typeof value.extractionPrompt !== 'string' || !value.extractionPrompt.trim() || typeof value.entityPrompt !== 'string' || !value.entityPrompt.trim() || typeof value.includePageHeadings !== 'boolean' || !['partial','placeholder'].includes(value.maskStyle)) throw new Error('invalid');
  if (value.reasoningEffort !== undefined && !['low','high','max'].includes(value.reasoningEffort)) throw new Error('invalid');
  if (value.ocrReasoningEffort !== undefined && !['low','high','max'].includes(value.ocrReasoningEffort)) throw new Error('invalid');
  if (value.maxTokens !== undefined && (!Number.isInteger(value.maxTokens) || value.maxTokens < 1 || value.maxTokens > 131072)) throw new Error('invalid');
  for (const key of ['continueOnError','entityReview']) if (value[key] !== undefined && typeof value[key] !== 'boolean') throw new Error('invalid');
  return { maxTokens:value.maxTokens, continueOnError:value.continueOnError, entityReview:value.entityReview, extractionPrompt:value.extractionPrompt, entityPrompt:value.entityPrompt, includePageHeadings:value.includePageHeadings, maskStyle:value.maskStyle, ...(value.reasoningEffort ? { reasoningEffort:value.reasoningEffort } : {}), ...(value.ocrReasoningEffort ? { ocrReasoningEffort:value.ocrReasoningEffort } : {}) };
 } catch { throw new Error('识别配置 JSON 缺失、损坏或字段无效'); }
}
