/** 职责：历史报表XLSX入口的兼容导出；通用工作簿生成实现位于document-generation，不含项目业务规则。 */
export {buildXlsx,writeXlsx} from '../document-generation/xlsx';
export type {WorkbookSheet,WorkbookHyperlink} from '../document-generation/xlsx';
