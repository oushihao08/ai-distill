/** 职责：飞书交付的确定性字段投影、逐字符差异和材料身份校验；供同步与DOCX导出调用，不访问网络或数据库。 */
import {canonicalJson} from '../../shared/workflow-config';
export class VerificationError extends Error {
 constructor(public code:string,public fields:string[]=[]){super(code);}
}
export function feishuTextFields(id:string,q:any,completionStatus:'已完成'|'未完成'='已完成'):Record<string,string>{
 const rubric=Array.isArray(q.rubric)?q.rubric.map((item:any,index:number)=>typeof item==='string'?item:`${item.id??index+1}（${item.max_score??''}分） ${item.criterion??''}${item.rule?`\n计分规则：${item.rule}`:''}`).join('\n'):'';
 return {'题目ID':id,'系统同步ID':id,'任务名称':q.task_name??'','任务类型':q.task_type??'','prompt':q.question??'','考点rubric':rubric,'作答思路':q.answer_approach??'','标准答案-文本':q.reference_answer??'','题目是否完成':completionStatus};
}
/** 只保留字段名、长度和首个不同字符位置，不将题面或答案写入公开回执。 */
export function compareFeishuText(expected:Record<string,string>,actual:Record<string,unknown>){
 return Object.entries(expected).flatMap(([field,value])=>{
  const received=actual[field]===undefined||actual[field]===null?'':actual[field];
  if(received===value)return [];
  const text=typeof received==='string'?received:'';let offset=0;
  while(offset<value.length&&offset<text.length&&value[offset]===text[offset])offset++;
  return [{field,expected_length:value.length,actual_length:typeof received==='string'?received.length:null,first_difference:offset}];
 });
}
export function assertAuthoringMaterialBinding(input:any,source:{origin:any;attachments:{id:string;sha256:string}[]}){
 if(!input||!Array.isArray(input.materials)||!input.materials.length)throw new VerificationError('feishu_authoring_materials_missing',['材料来源']);
 const expected=input.materials.map(({id,sha256}:any)=>({id,sha256})),actual=source.attachments.map(({id,sha256})=>({id,sha256}));
 if(canonicalJson(expected)!==canonicalJson(actual))throw new VerificationError('feishu_material_binding_mismatch',['附件数量/ID/SHA-256']);
 if(source.origin.kind==='library_v1'){
  if(canonicalJson(input.material_origin)!==canonicalJson(source.origin))throw new VerificationError('feishu_material_version_mismatch',['材料包版本']);
 }else if((input.redaction_attempt_id??input.material_origin?.redaction_attempt_id)!==source.origin.redaction_attempt_id)throw new VerificationError('feishu_material_version_mismatch',['脱敏版本']);
}
export function assertOriginalManifest(expected:{id:string;sha256:string;size_bytes?:number}[],actual:{id:string;sha256:string;size_bytes:number|string}[]){
 if(!expected.length||expected.length!==actual.length||new Set(expected.map(x=>x.id)).size!==expected.length)throw new VerificationError('feishu_material_manifest_mismatch',['附件数量']);
 const byId=new Map(actual.map(x=>[x.id,x]));
 for(const file of expected){const current=byId.get(file.id);if(!current||file.sha256!==current.sha256||(file.size_bytes!==undefined&&file.size_bytes!==Number(current.size_bytes)))throw new VerificationError('feishu_material_manifest_mismatch',[file.id]);}
}
