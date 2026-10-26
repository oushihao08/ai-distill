/**
 * 职责：读取并校验旧 Vision/OCR 配置快照，不负责配置当前 MinerU 提取器。
 * 关键入口：loadExtractionConfig从默认JSON或EXTRACTION_CONFIG_PATH读取旧Vision配置，供该客户端及其隔离验证使用。
 * 使用场景：旧vision.ts；材料库新默认设置不再读取本文件。既有provider_config兼容保留，但MinerU不执行它，密钥不由本文件管理。
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
