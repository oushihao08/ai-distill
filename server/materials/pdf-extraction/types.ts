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
