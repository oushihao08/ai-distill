/**
 * 职责：PDF 提取供应商契约：统一页级文本、来源指纹和供应商标识。
 * 关键方法与用途：`PdfExtractionProvider` 定义 provider 的页级提取方法；结果类型携带源指纹、页码和供应商标识。
 * 使用场景：由 MinerU 与其他 PDF 适配器实现，统一文档提取器消费。
 */
import type { Page } from '../pdf';

export type PdfExtractionProviderId = 'glm-ocr' | 'mineru-cli';

export interface PdfExtractionResult {
 pages: Page[];
 sha256: string;
 provider: PdfExtractionProviderId;
}

export interface PdfExtractionProvider {
 readonly id: PdfExtractionProviderId;
 extract(path: string, signal?: AbortSignal): Promise<PdfExtractionResult>;
}
