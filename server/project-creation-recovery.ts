/**
 * 职责：只读恢复项目创建回执；供HTTP、网页和CLI共用，不新建/删除记录。
 * 主项目+期号定位候选，再按创建入口同一目录规范化规则核对关键参数与显式出题设置。
 */
import type {Pool} from 'pg';
import {HTTPException} from 'hono/http-exception';
import {matchCreatedPhase} from '../shared/project-creation';
import {comparableProjectPath} from './paths';
import {validateProjectFolder} from './project-folders';
import {validatePhaseNumber} from './project-groups';
import {validateAuthoringDefaults} from './system-step-prompts';
import {text,uuid,questionTags} from './validation';

export async function recoverCreatedProject(db:Pick<Pool,'query'>,value:unknown){
 if(!value||typeof value!=='object'||Array.isArray(value))throw new HTTPException(400,{message:'创建回执查询须为JSON对象'});
 const input=value as Record<string,unknown>;
 const backend=input.material_backend??'library_v1';
 if(backend!=='library_v1'&&backend!=='legacy')throw new HTTPException(400,{message:'项目材料后端无效'});
 const parent=text(input.parent_name??input.name,'主项目名称',120),phase=text(input.phase_name??'','期次名称',120,false);
 const no=validatePhaseNumber(input.phase_no??1),group=input.project_group_id===undefined?undefined:uuid(String(input.project_group_id));
 const expected={...input,parent_name:parent,phase_name:phase,phase_no:no,description:text(input.description??'','项目说明',2000,false),question_tags:questionTags(input.question_tags??[]),material_backend:backend,material_mode:input.material_mode??(backend==='legacy'?'question_folders':'material_packages'),
  workspace_path:backend==='library_v1'?await validateProjectFolder(input.workspace_path,'项目规则工作区'):null,
  material_root:backend==='legacy'?await validateProjectFolder(input.material_root):null,
  ...(input.local_skill_path?{local_skill_path:await validateProjectFolder(input.local_skill_path,'本地skill目录')}:{})};
 const rows=(await db.query(`SELECT * FROM ai_distill.projects WHERE ${group?'project_group_id':'parent_name'}=$1 AND phase_no=$2 AND deleted_at IS NULL`,[group??parent,no])).rows;
 let result:Record<string,unknown>|null;
 try{result=matchCreatedPhase(expected,rows.map(row=>({...row,...Object.fromEntries(['workspace_path','material_root','local_skill_path'].filter(key=>typeof row[key]==='string').map(key=>[key,comparableProjectPath(row[key])]))})));}catch(error){throw new HTTPException(409,{message:error instanceof Error?error.message:'创建参数与既有期次冲突'});}
 if(result&&input.authoring_defaults!==undefined){
  const requested=validateAuthoringDefaults(input.authoring_defaults);
  const saved=(await db.query('SELECT config FROM ai_distill.project_step_configs WHERE project_id=$1 AND ordinal=4',[result.id])).rows[0]?.config;
  if(saved?.model!==requested.model||saved?.reasoning_effort!==requested.reasoning_effort)throw new HTTPException(409,{message:'既有期次出题设置与本次显式创建参数不一致'});
 }
 return{project:result};
}
