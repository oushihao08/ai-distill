/** 通用题包/判据文本投影；默认策略、接收转换与项目渲染共用，不包含项目身份选择或内容准入。 */
import type {PackageProjection} from './step-types';
/** 只投影已提供的metadata，保留历史空值/零值语义，不校验或补写专业判据。 */
export function formatCriterionRule(metadata:any):string {
 return `${metadata.statement}\n判定类型：${metadata.type}；重要性：${metadata.priority}；分值：${metadata.score===null?'独立否决，不计分':metadata.score}；档数：${metadata.points??'不适用'}；计数：${metadata.trigger_count??'按本条一次判定'}。`;
}
export function defaultPackageProjection({draft}:{draft:Record<string,any>}):PackageProjection {
 return {rubric:draft.rubric.map((item:any)=>'rule' in item?`${item.id}\n${item.criterion}\n${item.rule}${item.metadata?`\n业务信息：${JSON.stringify(item.metadata)}`:''}`:`${item.id}（${item.max_score}分）\n${item.criterion}`).join('\n\n'),private_sections:[],reference_answer:draft.reference_answer};
}
