/** CLI 命令层。runCommand 映射项目生命周期、材料包建题、配置和工作流到现有 HTTP 契约；不复制业务就绪、评分或达标规则。 */
import {readFile,writeFile} from 'node:fs/promises';
import {getStepDefinition, STEP_REGISTRY} from '../shared/step-registry';
import {readAcceptanceResult} from '../shared/workflow-results';
import {ApiClient, CliError} from './client';
import {batchSize,batchView,createBatch,readBatch,skipBatch} from './batches';
import {exportFailedQuestions} from './failed-export';

export const HELP = `ai-distill：本机工作流工具（所有命令支持 --json、--api http://127.0.0.1:3700）
远程材料（经 SSH 隧道，凭证从 .env 读取）：
  remote material run|start --workflow UUID --mode intake|redact|intake-redact --request-key UUID
  remote material status|sync --operation UUID
远程作答（经 SSH 隧道，凭证从 .env 读取）：
  remote answer run|start|status --workflow UUID --request-key UUID
详细命令/远程边界/恢复方式：cli/README.md；Skill 工具地图：skill/MAP.md#cli-工具地图
只读：
  project list | project show --project UUID
  material-package list --project UUID | material-package versions --workflow 材料包UUID
  project settings show --project UUID
  question list --project UUID | question show --workflow UUID
  workflow status --project UUID (--ids UUID,... | --all)
  material text --workflow UUID --material UUID --redacted-only
  rules list --project UUID | rules file --project UUID --path skill/SKILL.md
  models catalog | models show --project UUID
  attempt show --attempt UUID | attempt wait --ids UUID,... [--timeout 1h] [--full]
  result list | result show --workflow UUID
  export list --project UUID
  export failed --project UUID (--ids UUID,... | --all)（固定导出到 assets/未达标题目）
  export review --project UUID --ids UUID,...（指定已评分题目，保留真实判定）
  monitor show | step list
  batch show --file 清单路径
显式写入：
  batch create --project UUID (--ids UUID,... | --all) --size 数量 --to STEP_KEY --out 清单路径
  batch skip --file 清单路径 --ids UUID,... --reason 原因（仅记录本轮跳过，不取消任务）
  project create --name 显示名称 --material-root 绝对路径 [--material-mode question_folders|material_packages] [--parent-name 主项目] [--phase-name 期数] [--skill-path 绝对路径] [--description 说明] [--settings-file JSON]
  project material-mode --project UUID --clear-existing（隐藏旧题并切换为材料包模式）
  question create --material-package UUID --redaction-attempt UUID --title 名称 [--scenario 场景] [--role 角色] [--level L2|L3|L4|L5] [--direction 出题方向]
  project update --project UUID [--name 显示名称] [--parent-name 主项目] [--phase-name 期数] [--description 说明] [--material-root 绝对路径] [--skill-path 绝对路径]
  project delete --project UUID --confirm-name 项目完整名称
  project settings apply --project UUID --file JSON
  project sync --project UUID（刷新来源清单并按页数／大小切割超限PDF，可能使旧结果失效）
  step dispatch STEP_KEY --project UUID (--ids UUID,... | --all)
  export create --project UUID [--batch 批次]
下载（仅写指定的新本机文件，不覆盖）：
  artifact download --artifact UUID --out 路径 | export download --export UUID --out 路径
STEP_KEY 使用 step list；不使用页面序号。派发只执行一个步骤，不自动继续。
attempt wait 默认仅返回状态元信息；完整正文使用 attempt show 或 wait --full。
退出码：0 完成/派发已接受（不等于业务达标），1 命令/HTTP 错误，2 部分失败/未就绪，3 等待到期仍运行，130 中断。
`;

function parse(args: string[]) {
  const words: string[]=[]; const flags=new Map<string,string|true>();
  for(let i=0;i<args.length;i++) {
    const value=args[i];
    if (!value.startsWith('--')) { words.push(value); continue; }
    const key=value.slice(2);
    if (flags.has(key)) throw new CliError(`参数重复：--${key}`);
    if (['all','redacted-only','json','help','full','clear-existing'].includes(key)) flags.set(key,true);
    else {
      const next=args[++i]; if(!next||next.startsWith('--')) throw new CliError(`参数缺值：--${key}`);
      flags.set(key,next);
    }
  }
  return {words,flags};
}
function id(value: unknown, name: string): string {
  if (typeof value!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new CliError(`${name} 须为 UUID`);
  return value;
}
function duration(value: string) {
  const match=/^(\d+(?:\.\d+)?)(ms|s|m|h)$/.exec(value);
  const ms=match?Number(match[1])*({ms:1,s:1000,m:60000,h:3600000}[match[2]]!):NaN;
  if(!Number.isFinite(ms)||ms<0||ms>3600000) throw new CliError('等待时间须为0至1小时，如 30s、10m、1h');
  return ms;
}
function object(value: any, label: string) {
  if(!value||typeof value!=='object'||Array.isArray(value)) throw new CliError(`${label} 响应结构无效`,{kind:'invalid_response'});
  return value;
}

/** 通过现有项目同步API扫描来源目录；PDF切割由服务端扫描器统一执行。 */
async function syncProjectFolder(post:(path:string,body?:unknown)=>Promise<any>,projectId:string) {
  return post(`/api/projects/${projectId}/sync-folder`);
}

/** 返回命令信封；data 保留服务端结果，business 仅展示服务端达标结论，不自行算分。 */
export async function runCommand(args: string[], client?: ApiClient, signal?: AbortSignal): Promise<any> {
  try {
    const {words,flags}=parse(args);
    const command=words[0]==='project'&&words[1]==='settings'?words.slice(0,3).join(' '):words.slice(0,2).join(' ');
    if(flags.has('help')||!args.length) return {outcome:'complete',help:HELP};
    const allowed: Record<string,string[]>= {
      'project list':[], 'project show':['project'], 'project create':['name','parent-name','phase-name','description','material-root','skill-path','settings-file','material-mode'],
      'project material-mode':['project','clear-existing'],
      'project update':['project','name','parent-name','phase-name','description','material-root','skill-path'], 'project delete':['project','confirm-name'],
      'project settings show':['project'], 'project settings apply':['project','file'], 'project sync':['project'],
      'material-package list':['project'],'material-package versions':['workflow'],
      'question list':['project'],'question show':['workflow'],'question create':['material-package','redaction-attempt','title','scenario','role','level','direction'],'workflow status':['project','ids','all'],
      'material text':['workflow','material','redacted-only'],'rules list':['project'],'rules file':['project','path'],
      'models catalog':[],'models show':['project'],'attempt show':['attempt'],'attempt wait':['ids','timeout','full'],
      'result list':[],'result show':['workflow'],'step list':[],'step dispatch':['project','ids','all'],
      'export list':['project'],'export create':['project','batch'],'export download':['export','out'],
      'export failed':['project','ids','all'],
      'export review':['project','ids'],
      'artifact download':['artifact','out'],'monitor show':[],
      'batch create':['project','ids','all','size','to','out'],'batch show':['file'],'batch skip':['file','ids','reason'],
    };
    const expectedWords=command.startsWith('project settings ')?3:command==='step dispatch'?3:2;
    if(!allowed[command]||words.length!==expectedWords) throw new CliError('命令无效，请查看 --help');
    for(const key of flags.keys()) if(![...allowed[command],'json','api'].includes(key)) throw new CliError(`未知参数：--${key}`);
    const required=(key:string)=>{const value=flags.get(key);if(typeof value!=='string'||!value.trim())throw new CliError(`缺少 --${key}`);return value;};
    const uuid=(key:string)=>id(required(key),key);
    const api=client??new ApiClient(flags.has('api')?required('api'):process.env.AI_DISTILL_API_URL);
    const get=(path:string)=>api.json(path,'GET',undefined,signal);
    const post=(path:string,body:unknown={})=>api.json(path,'POST',body,signal);
    const put=(path:string,body:unknown)=>api.json(path,'PUT',body,signal);
    const patch=(path:string,body:unknown)=>api.json(path,'PATCH',body,signal);
    const del=(path:string,body?:unknown)=>api.json(path,'DELETE',body,signal);
    const ids=()=>[...new Set(required('ids').split(',').map(value=>id(value,'ids')))];
    const readJsonFile=async(path:string,label:string)=>{
      let source:string;
      try{source=await readFile(path,'utf8');}catch{throw new CliError(`${label}文件无法读取`,{kind:'file_error'});}
      try{return object(JSON.parse(source),label);}catch(error){if(error instanceof CliError)throw error;throw new CliError(`${label}文件不是有效JSON`,{kind:'file_error'});}
    };
    const applySettings=async(projectId:string,settings:any)=>{
      const allowedFields=['codex','models','steps','answer_generation_policy'];
      if(Object.keys(settings).some(key=>!allowedFields.includes(key)))throw new CliError('设置文件含不支持的字段');
      const operations:{key:string;path:string;method:'PUT'|'DELETE';body?:unknown}[]=[];
      if(Object.hasOwn(settings,'codex')){
        if(settings.codex===null)operations.push({key:'codex',path:`/api/projects/${projectId}/agent-settings`,method:'DELETE'});
        else operations.push({key:'codex',path:`/api/projects/${projectId}/agent-settings`,method:'PUT',body:object(settings.codex,'Codex设置')});
      }
      if(Object.hasOwn(settings,'models')){
        if(!Array.isArray(settings.models)||!settings.models.length)throw new CliError('models须包含至少一个模型及其分数上限；项目模型集合不能为空');
        operations.push({key:'models',path:`/api/projects/${projectId}/answer-models`,method:'PUT',body:{models:settings.models}});
      }
      if(Object.hasOwn(settings,'steps')){
        const steps=object(settings.steps,'步骤设置');
        for(const [key,value] of Object.entries(steps)){
          const step=getStepDefinition(key);
          if(!step?.visible||![4,5,6,9].includes(step.ordinal))throw new CliError(`不支持通过设置文件修改步骤：${key}`);
          if(value===null){if(![4,6,9].includes(step.ordinal))throw new CliError(`步骤 ${key} 不支持恢复默认`);operations.push({key:`steps.${key}`,path:`/api/projects/${projectId}/steps/${step.ordinal}/config`,method:'DELETE'});}
          else operations.push({key:`steps.${key}`,path:`/api/projects/${projectId}/steps/${step.ordinal}/config`,method:'PUT',body:object(value,`步骤 ${key} 设置`)});
        }
      }
      if(Object.hasOwn(settings,'answer_generation_policy'))operations.push({key:'answer_generation_policy',path:`/api/projects/${projectId}/answer-generation-policy`,method:'PUT',body:object(settings.answer_generation_policy,'作答时长策略')});
      const applied:string[]=[];
      for(const operation of operations){
        try{if(operation.method==='DELETE')await del(operation.path);else await put(operation.path,operation.body);applied.push(operation.key);}
        catch(error){return{outcome:'partial',applied,failed:{key:operation.key,error:error instanceof CliError?{message:error.message,...error.detail}:{kind:'unknown_error'}},remaining:operations.slice(applied.length+1).map(item=>item.key),note:'项目配置按顺序写入；此前成功项已生效，不会自动回滚。'};}
      }
      return{outcome:'complete',applied,note:'项目配置按顺序写入；每项结果来自对应服务端接口。'};
    };
    const projectSettings=async(projectId:string)=>{
      const [detail,codex,models,answerPolicy]=await Promise.all([
        get(`/api/projects/${projectId}`),get(`/api/projects/${projectId}/agent-settings`),get(`/api/projects/${projectId}/answer-models`),get(`/api/projects/${projectId}/answer-generation-policy`),
      ]);
      const selected=Array.isArray(models)?models:[];
      const completeModelSet=selected.length>0&&selected.every((model:any)=>typeof model.minimum_score==='number'&&Number.isFinite(model.minimum_score)&&model.minimum_score>=0&&model.minimum_score<=100);
      const codexReady=typeof codex.model==='string'&&typeof codex.reasoning_effort==='string';
      const skillReady=detail.project?.skill_exists===true;
      return{project:detail.project,codex,answer_models:selected,answer_generation_policy:answerPolicy,steps:detail.steps??[],readiness:{codex_ready:codexReady,answer_model_set_ready:completeModelSet,skill_ready:skillReady,project_configuration_ready:codexReady&&completeModelSet&&skillReady},readiness_scope:'仅为配置检查；不验证 API、worker、凭证或模型服务是否可用。',notes:[...(selected.length?[]:['尚未选择作答模型；出题可继续，但完整作答与评分达标链需要配置模型及百分制上限。']),...(selected.length&&!completeModelSet?['至少一个模型缺少有效的0至100分数上限，评分后无法完成有效达标判断。']:[]),...(skillReady?[]:['项目当前目录没有可用的 SKILL.md；出题前需要准备项目 skill。'])]};
    };
    const scope=async(ordinal?:number)=>{
      const project=uuid('project');
      if(flags.has('ids')===flags.has('all'))throw new CliError('必须且只能指定 --ids 或 --all');
      if(flags.has('ids'))return {project,selected:ids()};
      const data=object(await get(`/api/projects/${project}`),'项目');
      if(!Array.isArray(data.workflows))throw new CliError('项目缺少题目清单',{kind:'invalid_response'});
      const selected=data.workflows.filter((workflow:any)=>{
        if(ordinal===undefined)return true;
        if(ordinal===1||ordinal===9)return workflow.workflow_kind==='material_package'||!workflow.source_workflow_id;
        return workflow.workflow_kind!=='material_package';
      });
      return {project,selected:[...new Set<string>(selected.map((w:any)=>id(w.id,'workflow')))]};
    };
    let data: any;
    switch(command) {
      case 'batch create': {
        const size=batchSize(required('size'));
        const target=getStepDefinition(required('to'));
        if(!target?.visible)throw new CliError('目标步骤须为可见步骤 key');
        const {project,selected}=await scope(target.ordinal);
        if(!selected.length)throw new CliError('批次题目范围不能为空');
        // 清单生成只读服务端，确认所有ID存在且属于指定项目；不派发业务任务。
        const projectData=object(await get(`/api/projects/${project}`),'项目');
        if(!Array.isArray(projectData.workflows)||selected.some(id=>!projectData.workflows.some((w:any)=>w.id===id)))throw new CliError('题目不属于指定项目或已不存在');
        data=await createBatch(required('out'),{version:1,project_id:project,workflow_ids:selected,batch_size:size,target_step:target.key,created_at:new Date().toISOString(),skipped:{}});
        break;
      }
      case 'batch show': {
        const value=await readBatch(required('file'));
        if(!getStepDefinition(value.target_step)?.visible)throw new CliError('清单目标步骤无效');
        data=batchView(value);break;
      }
      case 'batch skip': data=await skipBatch(required('file'),ids(),required('reason'));break;
      case 'step list': data=STEP_REGISTRY.filter(s=>s.visible); break;
      case 'project list': data=await get('/api/projects'); break;
      case 'project show': data=await get(`/api/projects/${uuid('project')}`); break;
      case 'material-package list': data=object(await get(`/api/projects/${uuid('project')}`),'项目').workflows?.filter((flow:any)=>flow.workflow_kind==='material_package')??[];break;
      case 'material-package versions': data=await get(`/api/material-packages/${uuid('workflow')}/versions`);break;
      case 'project material-mode': {
        if(!flags.has('clear-existing'))throw new CliError('切换已有项目须显式提供 --clear-existing');
        data=await patch(`/api/projects/${uuid('project')}/material-mode`,{material_mode:'material_packages',clear_existing_questions:true});break;
      }
      case 'project settings show': data=await projectSettings(uuid('project'));break;
      case 'project settings apply': {
        const projectId=uuid('project'),settings=await readJsonFile(required('file'),'项目设置');
        data=await applySettings(projectId,settings);break;
      }
      case 'question list': data=object(await get(`/api/projects/${uuid('project')}`),'项目').workflows?.filter((flow:any)=>flow.workflow_kind!=='material_package')??[]; break;
      case 'question create': {
        const level=flags.has('level')?required('level'):null;
        if(level!==null&&!['L2','L3','L4','L5'].includes(level))throw new CliError('目标等级须为 L2 至 L5');
        data=await post(`/api/material-packages/${uuid('material-package')}/questions`,{title:required('title'),redaction_attempt_id:uuid('redaction-attempt'),scenario:flags.has('scenario')?required('scenario'):null,role_perspective:flags.has('role')?required('role'):null,target_level:level,authoring_direction:flags.has('direction')?required('direction'):null});break;
      }
      case 'question show': case 'result show': case 'workflow status': {
        if(command==='workflow status') {
          const {project,selected}=await scope();data={};
          for(let i=0;i<selected.length;i+=100) Object.assign(data,await get(`/api/projects/${project}/workflow-status?ids=${selected.slice(i,i+100).join(',')}`));
          const missing=selected.filter(key=>!data[key]);
          return {outcome:missing.length?'partial':'complete',data,missing_workflow_ids:missing};
        }
        data=await get(`/api/workflows/${uuid('workflow')}`);
        const decision=data.steps?.find((step:any)=>step.ordinal===7);
        const rawDecision=decision?.result;
        const acceptedDecision=readAcceptanceResult(rawDecision);
        const decisionResult=acceptedDecision??(rawDecision&&typeof rawDecision==='object'&&!Array.isArray(rawDecision)?rawDecision:{});
        return {outcome:'complete',data,business:{execution_status:decision?.status??null,...decisionResult}};
      }
      case 'project create': {
        const root=required('material-root');const skill=flags.has('skill-path')?required('skill-path'):undefined;
        if(!root.startsWith('/')||(skill&&!skill.startsWith('/')))throw new CliError('目录须为本机绝对路径');
        const settings=flags.has('settings-file')?await readJsonFile(required('settings-file'),'项目设置'):undefined;
        // 项目创建API扫描题目目录时会复用服务端PDF切割逻辑。
        const materialMode=flags.has('material-mode')?required('material-mode'):'question_folders';
        if(!['question_folders','material_packages'].includes(materialMode))throw new CliError('material-mode 须为 question_folders 或 material_packages');
        const created=object(await post('/api/projects',{name:required('name'),description:flags.get('description')??'',material_root:root,...(flags.has('material-mode')?{material_mode:materialMode}:{}),...(flags.has('parent-name')?{parent_name:required('parent-name')} : {}),...(flags.has('phase-name')?{phase_name:required('phase-name')} : {}),...(skill?{local_skill_path:skill}:{})}),'项目创建');
        const projectId=id(created.project?.id??created.id,'project');
        if(settings){let setup;try{setup=await applySettings(projectId,settings);}catch(error){return{outcome:'partial',data:{project:created,setup:{outcome:'not_applied',error:error instanceof CliError?{message:error.message,...error.detail}:{kind:'unknown_error'}},note:'项目已创建；设置校验失败，没有自动删除项目。'}};}let readiness;try{readiness=await projectSettings(projectId);}catch(error){return{outcome:'partial',data:{project:created,setup,readiness_error:error instanceof CliError?{message:error.message,...error.detail}:{kind:'unknown_error'}}};}data={project:created,setup,readiness};if(setup.outcome==='partial')return{outcome:'partial',data};}
        else {try{const readiness=await projectSettings(projectId);data={project:created,readiness:{...readiness.readiness,notes:readiness.notes}};}catch(error){return{outcome:'partial',data:{project:created,setup:{outcome:'not_applied',reason:'未提供 --settings-file'},readiness_error:error instanceof CliError?{message:error.message,...error.detail}:{kind:'unknown_error'}}};}}
        break;
      }
      case 'project update': {
        const projectId=uuid('project'),current=object(await get(`/api/projects/${projectId}`),'项目').project;
        if(!current)throw new CliError('项目响应缺少详情',{kind:'invalid_response'});
        if(!['name','parent-name','phase-name','description','material-root','skill-path'].some(key=>flags.has(key)))throw new CliError('project update 至少需要一个要修改的字段');
        const root=flags.has('material-root')?required('material-root'):current.material_root;
        const skill=flags.has('skill-path')?required('skill-path'):current.local_skill_path;
        if(typeof root!=='string'||!root.startsWith('/')||(skill!==undefined&&skill!==null&&(typeof skill!=='string'||!skill.startsWith('/'))))throw new CliError('材料目录和 skill 目录须为本机绝对路径');
        data=await patch(`/api/projects/${projectId}`,{name:flags.has('name')?required('name'):current.name,description:flags.has('description')?required('description'):current.description,material_root:root,...(flags.has('parent-name')?{parent_name:required('parent-name')} : {}),...(flags.has('phase-name')?{phase_name:required('phase-name')} : {}),...(typeof skill==='string'?{local_skill_path:skill}:{})});break;
      }
      case 'project delete': {
        const projectId=uuid('project'),current=object(await get(`/api/projects/${projectId}`),'项目');
        const project=current.project;
        if(!project||typeof project.name!=='string')throw new CliError('项目响应缺少名称',{kind:'invalid_response'});
        if(required('confirm-name')!==project.name)throw new CliError('删除确认名称与项目名称不完全一致；未删除任何数据');
        const removedWorkflows=Array.isArray(current.workflows)?current.workflows.length:0;
        await del(`/api/projects/${projectId}`);
        data={deleted:true,project_id:projectId,project_name:project.name,removed_workflows:removedWorkflows,project_settings_preserved:true,system_defaults_preserved:true,local_files_preserved:true};break;
      }
      case 'project sync': data=await syncProjectFolder(post,uuid('project')); break;
      case 'material text':
        if(!flags.has('redacted-only'))throw new CliError('读取材料须显式指定 --redacted-only');
        data=await get(`/api/workflows/${uuid('workflow')}/materials/${uuid('material')}/extracted-text?redacted_only=true`);break;
      case 'rules list': data=await get(`/api/projects/${uuid('project')}/rules`);break;
      case 'rules file': data=await get(`/api/projects/${uuid('project')}/rules/file?path=${encodeURIComponent(required('path'))}`);break;
      case 'models catalog': data=await get('/api/answer-models');break;
      case 'models show': data=await get(`/api/projects/${uuid('project')}/answer-models`);break;
      case 'attempt show': data=await get(`/api/attempts/${uuid('attempt')}`);break;
      case 'attempt wait': return await waitAttempts(api,ids(),duration(flags.has('timeout')?required('timeout'):'1h'),signal,flags.has('full'));
      case 'result list': data=await get('/api/results');break;
      case 'monitor show': data=await get('/api/monitor');break;
      case 'step dispatch': {
        const step=getStepDefinition(words[2]);
        if(!step?.visible)throw new CliError('步骤 key 无效或属于隐藏步骤，请查看 step list');
        const {project,selected}=await scope(step.ordinal);
        const batches: any[]=[];const results:any[]=[];let failed=false;
        // 不重试 POST。后续分组发生网络错误时保留已经取得的任务 ID，并停止继续派发。
        for(let i=0;i<selected.length;i+=100) {
          const workflowIds=selected.slice(i,i+100);
          try {
            const response=object(await post(`/api/projects/${project}/steps/${step.ordinal}/run-batch`,{workflow_ids:workflowIds}),'派发');
            if(!Array.isArray(response.results))throw new CliError('派发响应缺少 results',{kind:'invalid_response',outcome_unknown:true});
            batches.push({workflow_ids:workflowIds,data:response});results.push(...response.results);
            if(response.results.length!==workflowIds.length)failed=true;
          } catch(error) {
            failed=true;batches.push({workflow_ids:workflowIds,error:error instanceof CliError?{message:error.message,...error.detail}:{kind:'unknown_error'},unsubmitted_workflow_ids:selected.slice(i+100)});break;
          }
        }
        return {outcome:failed||results.some(r=>!['queued','succeeded'].includes(r.status))?'partial':'complete',
          step_key:step.key,project_id:project,selected_workflow_ids:selected,batches,dispatch:results,
          attempt_ids:[...new Set<string>(results.flatMap(r=>[r.attempt_id,...(r.attempt_ids??[])].filter(Boolean)))]};
      }
      case 'export list': data=await get(`/api/projects/${uuid('project')}/exports`);break;
      case 'export failed': {
        if(flags.has('all')===flags.has('ids'))throw new CliError('须且只能提供 --ids 或 --all');
        return await exportFailedQuestions(api,uuid('project'),flags.has('ids')?ids():undefined,signal);
      }
      case 'export review': return await exportFailedQuestions(api,uuid('project'),ids(),signal,'review');
      case 'export create': data=await post(`/api/projects/${uuid('project')}/export`,{batch:flags.get('batch')??null});break;
      case 'artifact download': case 'export download': {
        const out=required('out');
        const path=command==='artifact download'?`/api/artifacts/${uuid('artifact')}/download`:`/api/exports/${uuid('export')}/download`;
        const bytes=await api.download(path,signal);
        try {await writeFile(out,bytes,{flag:'wx',mode:0o600});}
        catch {throw new CliError('无法写入下载文件；目标须不存在且父目录已创建',{kind:'file_error'});}
        data={path:out,bytes:bytes.length};break;
      }
    }
    return {outcome:'complete',data};
  } catch(error) { throw error; }
}

async function waitAttempts(api: ApiClient, ids: string[], timeout: number, signal?: AbortSignal, full=false) {
  const deadline=performance.now()+timeout;
  const budget=timeout>0?AbortSignal.timeout(timeout):undefined;
  const readSignal=budget?(signal?AbortSignal.any([signal,budget]):budget):signal;
  const snapshots=new Map<string,any>();const errors=new Map<string,any>();
  // 限制客户端并发，避免大批量长轮询占满本机 API；每个任务共享同一外层截止时间。
  const pending=[...ids];
  const worker=async()=>{
    try {
      while(pending.length) {
        if(budget?.aborted)break;
        const attempt=pending.shift()!;
        do {
          if(signal?.aborted)throw new CliError('等待已中断，后台任务继续执行',{kind:'interrupted'});
          const waitMs=Math.min(30000,Math.max(0,Math.floor(deadline-performance.now())));
          try {
            const data=object(await api.json(`/api/attempts/${attempt}?wait_ms=${waitMs}${full?'':'&view=status'}`,'GET',undefined,readSignal),'任务');
            if(data.id!==attempt||!['waiting','running','succeeded','failed','skipped'].includes(data.status))throw new CliError('任务响应身份或状态无效',{kind:'invalid_response'});
            // Project even old servers' full responses so wait output cannot grow with answer text.
            const {id,workflow_id,ordinal,status,error,started_at,finished_at,completed}=data;
            snapshots.set(attempt,full?data:{id,workflow_id,ordinal,status,error,started_at,finished_at,completed});
            if(['succeeded','failed','skipped'].includes(data.status)) break;
          } catch(error) {
            if(signal?.aborted)throw error;
            if(budget?.aborted)break;
            errors.set(attempt,error instanceof CliError?{message:error.message,...error.detail}:{kind:'unknown_error'});break;
          }
          // API 正常会等待；旧服务立即返回时也避免忙轮询。
          if(performance.now()<deadline)await new Promise<void>(resolve=>{
            const finish=()=>{clearTimeout(timer);signal?.removeEventListener('abort',finish);resolve();};
            const timer=setTimeout(finish,Math.min(250,Math.max(0,deadline-performance.now())));
            signal?.addEventListener('abort',finish,{once:true});
          });
        } while(performance.now()<deadline);
      }
    } catch(error) { throw error; }
  };
  try {await Promise.all(Array.from({length:Math.min(4,ids.length)},worker));}
  catch(error) {throw error;}
  const attempts=ids.map(attempt=>({id:attempt,...(snapshots.get(attempt)??{}),...(errors.has(attempt)?{read_error:errors.get(attempt)}:{})}));
  const stillRunning=attempts.some(a=>!a.status||['waiting','running'].includes(a.status));
  return {outcome:errors.size||attempts.some(a=>a.status==='failed')?'partial':stillRunning?'waiting':'complete',attempts,
    note:'终态仅代表执行结束；达标结论须重新读取 result show。等待到期不会取消或重新派发任务。'};
}
