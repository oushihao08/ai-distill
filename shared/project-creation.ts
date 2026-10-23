/** 职责：创建响应丢失后的只读回执匹配；供网页和CLI复用，不创建或删除记录。 */
export function matchCreatedPhase(input:Record<string,unknown>,candidates:Record<string,unknown>[]){
 const matches=candidates.filter(p=>input.project_group_id?p.project_group_id===input.project_group_id&&p.phase_no===input.phase_no:p.parent_name===input.parent_name&&p.phase_no===input.phase_no);
 if(!matches.length)return null;
 if(matches.length!==1)throw new Error('同号期次存在多条记录，无法安全恢复');
 const phase=matches[0]!;
 const expected={name:input.parent_name!==undefined||input.phase_name!==undefined?(input.phase_name?`${input.parent_name??input.name} - ${input.phase_name}`:input.parent_name??input.name):input.name,parent_name:input.parent_name,phase_name:input.phase_name??'',phase_no:input.phase_no,description:input.description??'',material_backend:input.material_backend??'library_v1',material_mode:input.material_mode??'material_packages',workspace_path:input.workspace_path??null,material_root:input.material_root??null,...(input.local_skill_path?{local_skill_path:input.local_skill_path}:{})};
 if(Object.entries(expected).some(([key,value])=>phase[key]!==value)||JSON.stringify(phase.question_tags??[])!==JSON.stringify(input.question_tags??[]))throw new Error('同主项目同号期次已存在，但配置与本次提交不一致，请核对已有记录');
 return phase;
}
