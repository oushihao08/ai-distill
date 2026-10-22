/** 职责：解析材料库处理模板并冻结非敏感配置摘要；供派发、Codex计划导入和只读CLI使用。 */
import {createHash} from 'node:crypto';
import {HTTPException} from 'hono/http-exception';
import {canonicalJson} from '../../shared/workflow-config';
import {libraryRedactionTemplates,defaultLibraryRedactionTemplateId} from '../../shared/redaction-templates';
export function resolveLibraryTemplate(settings:Record<string,any>,id?:string){
 const templates=libraryRedactionTemplates(settings);
 const template=templates.find(t=>t.id===(id??defaultLibraryRedactionTemplateId(templates)));
 if(!template)throw new HTTPException(400,{message:'脱敏模板不存在，请重新选择'});
 return {...template,digest:createHash('sha256').update(canonicalJson(template)).digest('hex')};
}
