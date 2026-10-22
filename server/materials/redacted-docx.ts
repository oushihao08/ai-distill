/** 职责：历史材料DOCX入口的兼容导出；材料归档与旧项目脚本继续可用，生成实现统一位于document-generation。 */
export {buildDocx as buildRedactedDocx,preparedTextDocument,REDACTED_DOCX_RENDERER_VERSION} from '../document-generation/docx';
export type {RedactedDocumentStructure} from '../document-generation/docx';
