/**
 * 职责：计算材料整理结果中的文书、未归类内容和摘要展示数量。
 * 关键入口：`preparationCounts()`供材料库前端及服务端结果投影复用。
 * 边界：只依赖类型与普通数据，不引入Node运行时模块，确保可安全打包到浏览器。
 */
import type {MaterialPreparationResult} from './material-preparation-result';

export function preparationCounts(result:Pick<MaterialPreparationResult,'documents'|'document_count'|'unassigned_group_count'|'unassigned_block_count'>){
 const typed=Number.isSafeInteger(result.document_count)&&Number(result.document_count)>=0&&result.documents.every(document=>document.unit_kind==='document'||document.unit_kind==='unassigned');
 const summary_count=result.documents.filter(document=>typeof document.summary==='string'&&document.summary.trim()).length;
 return typed?{known:true as const,document_count:result.document_count??result.documents.filter(document=>document.unit_kind==='document').length,unassigned_group_count:result.unassigned_group_count??result.documents.filter(document=>document.unit_kind==='unassigned').length,unassigned_block_count:result.unassigned_block_count??result.documents.filter(document=>document.unit_kind==='unassigned').reduce((sum,document)=>sum+document.block_ids.length,0),entry_count:result.documents.length,summary_count}:{known:false as const,entry_count:result.documents.length,summary_count};
}
