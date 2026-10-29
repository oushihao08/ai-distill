/**
 * 文件职责：把 CLI 命令映射到项目、材料库和工作流 HTTP 契约，统一参数、请求 ID 与结果信封。
 * 关键入口：`runCommand()` 供 `cli/index.ts` 分派；`waitAttempts()` 只读恢复 attempt；项目业务判定由服务端返回。
 * 使用场景：Agent/维护者通过 CLI 读取并操作现有项目；旧目录/旧材料包接口继续兼容，不在本层连接数据库或运行模型。
 */
import {prepareLibraryFiles} from '../server/materials/prepare-library-files';
import {readFile,writeFile} from 'node:fs/promises';
import {basename,dirname,resolve} from 'node:path';
import {getStepDefinition, STEP_REGISTRY} from '../shared/step-registry';
import {readAcceptanceResult} from '../shared/workflow-results';
import {ApiClient, CliError} from './client';
import {diagnoseQueue} from './queue-diagnostics';
import {batchSize,batchView,createBatch,readBatch,skipBatch} from './batches';
import {exportFailedQuestions} from './failed-export';
import {exportPreparedMaterials} from './material-export';
import {feishuTarget,readFeishuConfig,syncFeishuBatch,FEISHU_REQUEST_TIMEOUT_MS} from './feishu';
import {validateMaterialPreparationPlan} from '../shared/material-preparation';

export const HELP = `ai-distill：工作流工具（全部命令支持 --json；仅本机命令接受 --api http://127.0.0.1:3700）
远程材料（经 SSH 隧道，凭证从 .env 读取）：
  remote material run|start --workflow UUID --mode intake|redact|intake-redact --request-key UUID
  remote material status|sync (--operation UUID | --workflow UUID --request-key UUID)
远程作答（经 SSH 隧道，凭证从 .env 读取）：
  remote answer run|start|status --workflow UUID --request-key UUID
详细命令/远程边界/恢复方式：cli/README.md；Skill 工具地图：skill/MAP.md#cli-工具地图
只读：
  project list | project show --project UUID | project-group list | project-group phases --group UUID
  material-package list --project UUID | material-package versions --workflow 材料包UUID
  library package list [--q 关键词] [--page N] [--page-size N] [--ready-only] [--redaction-state all|ready|not_ready] [--archived-only] [--project UUID]
  library package show|usage|revisions --package UUID
  library job show --job UUID | library documents show --revision UUID --extraction-job UUID [--file UUID]
  library redaction show --redaction UUID [--file UUID] | library file download --file UUID --out 新路径
  project material candidates --project UUID [--q 关键词] [--page N] [--page-size N] [--source-mode any|redacted|original]
  project materials list --project UUID [--include-removed] | project material uses --project UUID | project material use events --project UUID --use UUID
  project settings show --project UUID
  question list --project UUID | question show --workflow UUID
  workflow status --project UUID (--ids UUID,... | --all)
  workflow hooks show --workflow UUID | workflow delivery show --workflow UUID
  material text --workflow UUID --material UUID --redacted-only
  rules list --project UUID | rules file --project UUID --path skill/SKILL.md
  models catalog | models show --project UUID
  attempt show --attempt UUID | attempt wait --ids UUID,... [--timeout 1h] [--full]
  result list | result show --workflow UUID
  export list --project UUID
  export failed --project UUID (--ids UUID,... | --all)（固定导出到 assets/未达标题目）
  export review --project UUID --ids UUID,...（指定已评分题目，保留真实判定）
  monitor show | queue diagnose | step list
  batch show --file 清单路径
显式写入：
  batch create --project UUID (--ids UUID,... | --all) --size 数量 --to STEP_KEY --out 清单路径
  batch skip --file 清单路径 --ids UUID,... --reason 原因（仅记录本轮跳过，不取消任务）
  project create --name 显示名称 [--material-backend legacy --material-root 仓库相对路径 | --material-backend library_v1 --workspace-path 仓库相对路径] [--parent-name 主项目 --phase-name 期数 --phase-no N] [--project-group UUID] [--skill-path 仓库相对路径] [--settings-file JSON]
    默认 library_v1、期号1、Agent化名；需要 --workspace-path，首期明确 --skill-path；旧目录须显式 --material-backend legacy。
  project phase-update --project UUID --phase-no N --phase-name 期名 --expected-name 当前完整名称
  project-group rename|archive|restore --group UUID [--name 主项目名称]
  library package create --name 名称 [--description 说明] [--tags a,b]
  library package update --package UUID --version N --file JSON | library package archive|restore --package UUID --version N
  library files prepare --manifest JSON --out 新输出目录（本地OFD转PDF及PDF切割；不上传、不调用模型）
  library revision create --package UUID --version N --request-key UUID --manifest JSON
  library job start --revision UUID --kind intake|extract|redact --target local|server --request-key UUID [--extraction-job UUID] [--previous-job UUID] [--template 模板ID] [--project 期次UUID] [--agent-model 模型 --reasoning-effort 等级]
  library prepare start --revision UUID (--redaction UUID | --extraction-job UUID) --request-key UUID [--project UUID] [--agent-model 模型 --reasoning-effort 等级] [--execution-timeout 30m]
  library prepare resume --job UUID --request-key UUID [--execution-timeout 30m]（显式续作，不启动worker）
  library prepare diagnose --job UUID（只读计数与停止原因，不输出正文）
  library prepare list --package UUID | library prepare show --preparation UUID [--content]
  library job wait --job UUID [--timeout 1h]
  library job cancel --job UUID
  project materials load --project UUID --package UUID (--redaction UUID | --revision UUID)
  project materials update --project UUID --link UUID --version N [--redaction UUID | --revision UUID] [--position N]
  project materials remove|restore --project UUID --link UUID --version N
  project materials question --project UUID --link UUID --version N (--redaction UUID | --revision UUID) --title 名称 --request-key UUID [--role 角色] [--scenario 场景] [--level L2|L3|L4|L5] [--direction 方向] [--tags a,b]
  question delete --project UUID --workflow UUID --confirm-title 精确题目名（软删除单题；有活动尝试时拒绝）
  workflow design update --workflow UUID [--direction 文本] [--scenario 文本] [--role 文本]（至少一项；空文本清空，不派发）
  workflow authoring restore --workflow UUID --attempt UUID（恢复已保存结果，不重新调用模型）
  workflow material-docx generate --workflow UUID（按冻结材料与项目布局生成全部DOCX，不派发其他步骤）
  workflow archive withdraw --workflow UUID（撤回当前归档，保留历史）
  library redaction revalidate --redaction UUID（复核已发布Agent产物，追加校验记录）
  hook retry --hook UUID [--acknowledge-side-effects]（显式补执行；不自动确认副作用）
  attempt resume-hooks --attempt UUID [--acknowledge-side-effects]（仅旧失败主尝试续跑）
  project material use update --project UUID --use UUID --version N --status in_use|submitted --reason 原因 [--evidence-file JSON]
  project legacy-materials list --project UUID | project legacy-materials import --project UUID --workflow UUID --request-key UUID [--apply --digest SHA256] | project legacy-materials activate --project UUID --import UUID
  library processing show | library processing update --version N --file JSON
  library package revisions|usage --package UUID
  project material-mode --project UUID --clear-existing（隐藏旧题并切换为材料包模式）
  question create --material-package UUID --redaction-attempt UUID --title 名称 [--scenario 场景] [--role 角色] [--level L2|L3|L4|L5] [--direction 出题方向]（旧材料包兼容接口）
  project update --project UUID [--name 显示名称] [--parent-name 主项目] [--phase-name 期数] [--description 说明] [--workspace-path 仓库相对路径] [--material-root 仓库相对路径] [--skill-path 仓库相对路径]
  project delete --project UUID --confirm-name 项目完整名称
  project settings apply --project UUID --file JSON
  project sync --project UUID（刷新来源清单并按页数／大小切割超限PDF，可能使旧结果失效）
  queue show | queue cancel --job UUID
  advice show --workflow UUID
  advice generate (--workflow UUID | --project UUID (--ids UUID,... | --all))
  step dispatch STEP_KEY --project UUID (--ids UUID,... | --all)
  export create --project UUID [--batch 批次]
下载（仅写指定的新本机文件，不覆盖）：
  library documents export --plan Codex处理计划.json --out 新目录（校验原文并应用计划；不调用模型、不入库）
  library template list | show --template 模板ID（提示词、流程及冻结摘要）
  library documents import --plan Codex处理计划.json --request-key UUID（正式保存新的库级脱敏结果）
  artifact download --artifact UUID --out 路径 | export download --export UUID --out 路径
  siriser download --workflow UUID --out 五件套ZIP路径（需该题已有当前有效归档）
飞书交付（仅豆包；新接口需API/worker重载后可用）：
  feishu config show --project UUID
  feishu config set --project UUID --base-token BASE --table TABLE
  feishu table create --project UUID --name 新表名 [--base-token BASE]（不改变默认目标）
  feishu sync --workflow UUID [--base-token BASE --table TABLE]
  feishu sync-batch --project UUID --ids UUID,... --out 新进度文件.json [--base-token BASE --table TABLE]
STEP_KEY 使用 step list；不使用页面序号。派发只执行一个步骤，不自动继续。
attempt wait 默认仅返回状态元信息；完整正文使用 attempt show 或 wait --full；归档终态不代表飞书交付完成，另查 workflow delivery show。
退出码：0 完成/派发已接受（不等于业务达标），1 命令/HTTP 错误，2 部分失败/未就绪，3 等待到期仍运行，130 中断。
`;

function parse(args: string[]) {
  const words: string[]=[]; const flags=new Map<string,string|true>();
  for(let i=0;i<args.length;i++) {
    const value=args[i];
    if (!value.startsWith('--')) { words.push(value); continue; }
    const key=value.slice(2);
    if (flags.has(key)) throw new CliError(`参数重复：--${key}`);
    if (['all','redacted-only','json','help','full','content','clear-existing','ready-only','archived-only','include-removed','apply','acknowledge-side-effects'].includes(key)) flags.set(key,true);
    else {
      const next=args[++i]; if(next===undefined||next.startsWith('--')) throw new CliError(`参数缺值：--${key}`);
      flags.set(key,next);
    }
  }
  return {words,flags};
}
function id(value: unknown, name: string): string {
  if (typeof value!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new CliError(`${name} 须为 UUID`);
  return value;
}
function duration(value: string,maximum=3600000) {
  const match=/^(\d+(?:\.\d+)?)(ms|s|m|h)$/.exec(value);
  const ms=match?Number(match[1])*({ms:1,s:1000,m:60000,h:3600000}[match[2]]!):NaN;
  if(!Number.isFinite(ms)||ms<0||ms>maximum) throw new CliError(`时间须为0至${maximum/3600000}小时，如 30s、10m、1h`);
  return ms;
}
function object(value: any, label: string) {
  if(!value||typeof value!=='object'||Array.isArray(value)) throw new CliError(`${label} 响应结构无效`,{kind:'invalid_response'});
  return value;
}
function positiveInteger(value:string,label:string){
  const number=Number(value);
  if(!Number.isSafeInteger(number)||number<1)throw new CliError(`${label}须为正整数`);
  return number;
}
function versionHeader(value:string){return {'If-Match':String(positiveInteger(value,'版本'))};}
function queryString(entries:Array<[string,string|undefined]>){
  const params=new URLSearchParams();
  for(const [key,value] of entries)if(value!==undefined&&value!=='')params.set(key,value);
  const encoded=params.toString();return encoded?`?${encoded}`:'';
}

/** 通过现有项目同步API扫描来源目录；PDF切割由服务端扫描器统一执行。 */
async function syncProjectFolder(post:(path:string,body?:unknown)=>Promise<any>,projectId:string) {
  return post(`/api/projects/${projectId}/sync-folder`);
}

/** 返回命令信封；data 保留服务端结果，business 仅展示服务端达标结论，不自行算分。 */
export async function runCommand(args: string[], client?: ApiClient, signal?: AbortSignal): Promise<any> {
  try {
    const {words,flags}=parse(args);
    if(flags.has('help')||!args.length) return {outcome:'complete',help:HELP};
    const allowed: Record<string,string[]>= {
      'project list':[], 'project show':['project'], 'project create':['name','parent-name','phase-name','phase-no','project-group','description','material-root','workspace-path','skill-path','settings-file','material-mode','material-backend'],
      'project phase-update':['project','phase-no','phase-name','expected-name'],
      'project material-mode':['project','clear-existing'],
      'project update':['project','name','parent-name','phase-name','description','material-root','workspace-path','skill-path'], 'project delete':['project','confirm-name'],
      'project settings show':['project'], 'project settings apply':['project','file'], 'project sync':['project'],
      'project-group list':[],'project-group phases':['group'],'project-group rename':['group','name'],'project-group archive':['group'],'project-group restore':['group'],
      'project material candidates':['project','q','page','page-size','source-mode'],'project material uses':['project'],
      'project material use events':['project','use'],'project material use update':['project','use','version','status','reason','evidence-file'],
      'project legacy-materials list':['project'],'project legacy-materials import':['project','workflow','request-key','apply','digest'],'project legacy-materials activate':['project','import'],
      'project materials list':['project','include-removed'],'project materials load':['project','package','redaction','revision'],
      'project materials update':['project','link','version','redaction','revision','position'],
      'project materials remove':['project','link','version'],'project materials restore':['project','link','version'],
      'project materials question':['project','link','version','redaction','revision','title','request-key','scenario','role','level','direction','tags'],
      'library package list':['q','page','page-size','ready-only','redaction-state','archived-only','project'],'library package show':['package'],
      'library package usage':['package'],'library package revisions':['package'],'library package create':['name','description','tags'],
      'library package update':['package','version','file'],'library package archive':['package','version'],'library package restore':['package','version'],
      'library files prepare':['manifest','out'],
      'library revision create':['package','version','request-key','manifest'],
      'library job start':['revision','kind','target','request-key','extraction-job','previous-job','template','project','agent-model','reasoning-effort'],
      'library job show':['job'],'library job cancel':['job'],'library job wait':['job','timeout'],
      'library prepare start':['revision','redaction','extraction-job','request-key','project','agent-model','reasoning-effort','execution-timeout'],'library prepare resume':['job','request-key','execution-timeout'],'library prepare diagnose':['job'],'library prepare list':['package'],'library prepare show':['preparation','content'],
      'library template list':[],'library template show':['template'],
      'library redaction revalidate':['redaction'],
      'library documents show':['revision','extraction-job','file'],'library documents export':['plan','out'],'library documents import':['plan','request-key'],'library redaction show':['redaction','file'],
      'library file download':['file','out'],
      'library processing show':[],'library processing update':['version','file'],
      'material-package list':['project'],'material-package versions':['workflow'],
      'question list':['project'],'question show':['workflow'],'question delete':['project','workflow','confirm-title'],'question create':['material-package','redaction-attempt','title','scenario','role','level','direction'],'workflow status':['project','ids','all'],
      'workflow design update':['workflow','direction','scenario','role'],
      'workflow authoring restore':['workflow','attempt'],'workflow archive withdraw':['workflow'],
      'workflow material-docx generate':['workflow'],
      'workflow hooks show':['workflow'],'workflow delivery show':['workflow'],
      'hook retry':['hook','acknowledge-side-effects'],'attempt resume-hooks':['attempt','acknowledge-side-effects'],
      'material text':['workflow','material','redacted-only'],'rules list':['project'],'rules file':['project','path'],
      'models catalog':[],'models show':['project'],'attempt show':['attempt'],'attempt wait':['ids','timeout','full'],
      'queue show':[],'queue diagnose':[],'queue cancel':['job'],'advice show':['workflow'],'advice generate':['workflow','project','ids','all'],
      'result list':[],'result show':['workflow'],'step list':[],'step dispatch':['project','ids','all'],
      'export list':['project'],'export create':['project','batch'],'export download':['export','out'],
      'siriser download':['workflow','out'],
      'feishu config show':['project'],'feishu config set':['project','base-token','table'],
      'feishu table create':['project','name','base-token'],'feishu sync':['workflow','base-token','table'],
      'feishu sync-batch':['project','ids','out','base-token','table'],
      'export failed':['project','ids','all'],
      'export review':['project','ids'],
      'artifact download':['artifact','out'],'monitor show':[],
      'batch create':['project','ids','all','size','to','out'],'batch show':['file'],'batch skip':['file','ids','reason'],
    };
    const command=Object.keys(allowed).sort((a,b)=>b.split(' ').length-a.split(' ').length).find(key=>words.slice(0,key.split(' ').length).join(' ')===key)??'';
    const expectedWords=command==='step dispatch'?3:command.split(' ').length;
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
    const versioned=async(path:string,method:'PATCH'|'DELETE'|'POST',version:string,body?:unknown)=>api.json(path,method,body,signal,versionHeader(version));
    const ids=()=>[...new Set(required('ids').split(',').map(value=>id(value,'ids')))];
    const readJsonFile=async(path:string,label:string)=>{
      let source:string;
      try{source=await readFile(path,'utf8');}catch{throw new CliError(`${label}文件无法读取`,{kind:'file_error'});}
      try{return object(JSON.parse(source),label);}catch(error){if(error instanceof CliError)throw error;throw new CliError(`${label}文件不是有效JSON`,{kind:'file_error'});}
    };
    const createLibraryRevision=async(packageId:string)=>{
      const manifestPath=required('manifest');
      const manifest=await readJsonFile(manifestPath,'材料清单');
      if(!Array.isArray(manifest.files)||manifest.files.length<1||manifest.files.length>100)throw new CliError('材料清单须包含1至100个文件');
      const form=new FormData();form.set('request_key',uuid('request-key'));
      const modes:string[]=[];
      for(const [index,item] of manifest.files.entries()){
        if(!item||typeof item!=='object'||Array.isArray(item)||typeof item.path!=='string'||!item.path.trim())throw new CliError(`材料清单第${index+1}项缺少 path`);
        const mode=item.redaction_mode??'model';
        if(mode!=='model'&&mode!=='declared_redacted')throw new CliError(`材料清单第${index+1}项 redaction_mode 无效`);
        const filePath=resolve(dirname(resolve(manifestPath)),item.path);
        let bytes:Uint8Array;
        try{bytes=await readFile(filePath);}catch{throw new CliError(`材料文件无法读取：${basename(filePath)}`,{kind:'file_error'});}
        const uploadBytes=new Uint8Array(bytes.byteLength);uploadBytes.set(bytes);
        form.append('files',new Blob([uploadBytes.buffer]),basename(filePath));modes.push(mode);
      }
      form.set('redaction_modes',JSON.stringify(modes));
      return api.form(`/api/material-library/packages/${packageId}/revisions`,'POST',form,signal,versionHeader(required('version')));
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
          if(!step?.visible||![4,5,6,7].includes(step.ordinal))throw new CliError(`不支持通过设置文件修改步骤：${key}`);
          if(value===null){if(![4,6].includes(step.ordinal))throw new CliError(`步骤 ${key} 不支持恢复默认`);operations.push({key:`steps.${key}`,path:`/api/projects/${projectId}/steps/${step.ordinal}/config`,method:'DELETE'});}
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
      case 'workflow design update': {
        const workflow=uuid('workflow'),body:Record<string,string|null>={};
        for(const [flag,key] of [['direction','authoring_direction'],['scenario','scenario'],['role','role_perspective']] as const){
          if(!flags.has(flag))continue;
          const value=flags.get(flag);
          if(typeof value!=='string')throw new CliError(`--${flag} 须为文本`);
          body[key]=value.trim()?value:null;
        }
        if(!Object.keys(body).length)throw new CliError('至少提供出题方向、场景或角色视角');
        data=await patch(`/api/workflows/${workflow}/authoring-direction`,body);break;
      }
      case 'workflow authoring restore': data=await post(`/api/workflows/${uuid('workflow')}/authoring-results/${uuid('attempt')}/restore`);break;
      case 'workflow material-docx generate': data=await post(`/api/workflows/${uuid('workflow')}/material-docx`);break;
      case 'workflow archive withdraw': data=await post(`/api/workflows/${uuid('workflow')}/withdraw-archive`);break;
      case 'library redaction revalidate': {
        data=object(await post(`/api/material-library/redactions/${uuid('redaction')}/revalidate`),'脱敏复核');
        return{outcome:data.valid===true&&data.usable_for_question===true?'complete':'partial',data};
      }
      case 'workflow hooks show': data=await get(`/api/workflows/${uuid('workflow')}/hooks`);break;
      case 'attempt resume-hooks': data=await post(`/api/attempts/${uuid('attempt')}/resume-hooks`,{acknowledge_side_effects:flags.has('acknowledge-side-effects')});break;
      case 'hook retry': {
        data=object(await api.json(`/api/hooks/${uuid('hook')}/retry`,'POST',{acknowledge_side_effects:flags.has('acknowledge-side-effects')},signal,{},180000),'钩子补执行');
        return{outcome:data.status==='succeeded'?'complete':'partial',data};
      }
      case 'workflow delivery show': {
        const workflow=uuid('workflow').toLowerCase(),detail=object(await get(`/api/workflows/${workflow}?view=status`),'交付状态');
        if(detail.workflow?.id!==workflow||!Array.isArray(detail.steps))throw new CliError('交付响应身份或步骤无效',{kind:'invalid_response'});
        const archive=detail.steps.find((step:any)=>step.ordinal===8);
        return{outcome:'complete',data:{workflow_id:workflow,archive:{status:archive?.status??null,error:archive?.error??null},feishu_sync:archive?.result?.feishu_sync??null,feishu_deliveries:archive?.result?.feishu_deliveries??null},
          note:'只读服务端当前归档状态与飞书回执；查询完成不代表交付成功。逐目标核对succeeded及verification.status=passed；缺失或旧回执保持未知，不自动同步或重试。'};
      }
      case 'feishu config show': data=await readFeishuConfig(api,uuid('project'),signal);break;
      case 'feishu config set': {
        const project=uuid('project'),target=feishuTarget(required('base-token'),required('table'))!;
        await readFeishuConfig(api,project,signal);
        data=await api.json(`/api/projects/${project}/feishu-delivery`,'PUT',{default_target:target},signal,{},FEISHU_REQUEST_TIMEOUT_MS);break;
      }
      case 'feishu table create': {
        const project=uuid('project');await readFeishuConfig(api,project,signal);
        data=await api.json(`/api/projects/${project}/feishu-tables`,'POST',{table_name:required('name'),...(flags.has('base-token')?{base_token:required('base-token')}:{})},signal,{},FEISHU_REQUEST_TIMEOUT_MS);break;
      }
      case 'feishu sync': {
        const workflow=uuid('workflow').toLowerCase(),target=feishuTarget(flags.get('base-token'),flags.get('table'));
        const detail=await get(`/api/workflows/${workflow}?view=status`),project=id(detail.workflow?.project_id,'项目');
        await readFeishuConfig(api,project,signal);
        data=await api.json(`/api/workflows/${workflow}/feishu-sync`,'POST',target?{target}:{},signal,{},FEISHU_REQUEST_TIMEOUT_MS);
        return{outcome:data.status==='succeeded'?'complete':'partial',data};
      }
      case 'feishu sync-batch': return await syncFeishuBatch(api,uuid('project'),[...new Set(ids().map(value=>value.toLowerCase()))],required('out'),feishuTarget(flags.get('base-token'),flags.get('table')),signal);

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
      case 'project-group list': data=await get('/api/project-groups');break;
      case 'project-group phases': data=await get(`/api/project-groups/${uuid('group')}/phases`);break;
      case 'project-group rename': data=await patch(`/api/project-groups/${uuid('group')}`,{name:required('name')});break;
      case 'project-group archive': data=await del(`/api/project-groups/${uuid('group')}`);break;
      case 'project-group restore': data=await post(`/api/project-groups/${uuid('group')}/restore`);break;
      case 'project phase-update': data=await patch(`/api/projects/${uuid('project')}/phase-identity`,{phase_no:positiveInteger(required('phase-no'),'期数'),phase_name:required('phase-name'),expected_name:required('expected-name')});break;
      case 'project material candidates': {
        const source=flags.has('source-mode')?required('source-mode'):'any';
        if(!['any','redacted','original'].includes(source))throw new CliError('source-mode 须为 any、redacted 或 original');
        data=await get(`/api/projects/${uuid('project')}/material-candidates${queryString([['q',flags.has('q')?required('q'):undefined],['page',flags.has('page')?String(positiveInteger(required('page'),'页码')):undefined],['page_size',flags.has('page-size')?String(positiveInteger(required('page-size'),'每页数量')):undefined],['source_mode',source]])}`);break;
      }
      case 'project material uses': data=await get(`/api/projects/${uuid('project')}/material-uses`);break;
      case 'project material use events': data=await get(`/api/projects/${uuid('project')}/material-uses/${uuid('use')}/events`);break;
      case 'project material use update': {
        const evidence=flags.has('evidence-file')?await readJsonFile(required('evidence-file'),'提交证据'):{};
        const status=required('status');if(!['in_use','submitted'].includes(status))throw new CliError('status 须为 in_use 或 submitted');
        data=await versioned(`/api/projects/${uuid('project')}/material-uses/${uuid('use')}`,'PATCH',required('version'),{status,reason:required('reason'),evidence});break;
      }
      case 'project legacy-materials list': data=await get(`/api/projects/${uuid('project')}/legacy-materials`);break;
      case 'project legacy-materials import': {
        const applying=flags.has('apply');
        if(applying!==flags.has('digest'))throw new CliError('历史材料导入 --apply 时必须同时提供 --digest；预览时不要提供 digest');
        data=await post(`/api/projects/${uuid('project')}/legacy-material-imports`,{source_workflow_id:uuid('workflow'),request_key:uuid('request-key'),dry_run:!applying,...(applying?{expected_source_digest:required('digest')}:{})});break;
      }
      case 'project legacy-materials activate': data=await post(`/api/projects/${uuid('project')}/legacy-material-imports/${uuid('import')}/activate`);break;
      case 'project materials list': data=await get(`/api/projects/${uuid('project')}/loaded-materials${flags.has('include-removed')?'?include_removed=true':''}`);break;
      case 'project materials load': {
        if(flags.has('redaction')===flags.has('revision'))throw new CliError('必须且只能指定 --redaction 或 --revision');
        data=await post(`/api/projects/${uuid('project')}/loaded-materials`,{package_id:uuid('package'),...(flags.has('redaction')?{redaction_id:uuid('redaction')}:{revision_id:uuid('revision')})});break;
      }
      case 'project materials update': {
        if(flags.has('redaction')&&flags.has('revision'))throw new CliError('--redaction 与 --revision 不能同时使用');
        const body={...(flags.has('redaction')?{redaction_id:uuid('redaction')}:{}) ,...(flags.has('revision')?{revision_id:uuid('revision')}:{}) ,...(flags.has('position')?{position:positiveInteger(required('position'),'排序位置')}:{})};
        if(!Object.keys(body).length)throw new CliError('至少指定来源版本或排序位置');
        data=await versioned(`/api/projects/${uuid('project')}/loaded-materials/${uuid('link')}`,'PATCH',required('version'),body);break;
      }
      case 'project materials remove': data=await versioned(`/api/projects/${uuid('project')}/loaded-materials/${uuid('link')}`,'DELETE',required('version'));break;
      case 'project materials restore': data=await versioned(`/api/projects/${uuid('project')}/loaded-materials/${uuid('link')}/restore`,'POST',required('version'));break;
      case 'project materials question': {
        if(flags.has('redaction')===flags.has('revision'))throw new CliError('必须且只能指定 --redaction 或 --revision');
        const level=flags.has('level')?required('level'):undefined;
        if(level!==undefined&&!['L2','L3','L4','L5'].includes(level))throw new CliError('目标等级须为 L2 至 L5');
        data=await post(`/api/projects/${uuid('project')}/loaded-materials/${uuid('link')}/questions`,{
          request_key:uuid('request-key'),expected_link_version:positiveInteger(required('version'),'材料引用版本'),
          ...(flags.has('redaction')?{redaction_id:uuid('redaction')}:{revision_id:uuid('revision')}),title:required('title'),
          ...(flags.has('scenario')?{scenario:required('scenario')}:{}) ,...(flags.has('role')?{role_perspective:required('role')}:{}) ,
          ...(level?{target_level:level}:{}),...(flags.has('direction')?{authoring_direction:required('direction')}:{}) ,
          ...(flags.has('tags')?{question_tags:required('tags').split(',').map(tag=>tag.trim()).filter(Boolean)}:{}),
        });break;
      }
      case 'library package list': {
        const query=queryString([['q',flags.has('q')?required('q'):undefined],['page',flags.has('page')?String(positiveInteger(required('page'),'页码')):undefined],['page_size',flags.has('page-size')?String(positiveInteger(required('page-size'),'每页数量')):undefined],['ready_only',flags.has('ready-only')?'true':undefined],['redaction_state',flags.has('redaction-state')?required('redaction-state'):undefined],['archived_only',flags.has('archived-only')?'true':undefined],['project_id',flags.has('project')?uuid('project'):undefined]]);
        data=await get(`/api/material-library/packages${query}`);break;
      }
      case 'library package show': data=await get(`/api/material-library/packages/${uuid('package')}`);break;
      case 'library package usage': data=await get(`/api/material-library/packages/${uuid('package')}/usage`);break;
      case 'library package revisions': data=await get(`/api/material-library/packages/${uuid('package')}/revisions`);break;
      case 'library package create': data=await post('/api/material-library/packages',{name:required('name'),description:flags.has('description')?required('description'):'',tags:flags.has('tags')?required('tags').split(',').map(tag=>tag.trim()).filter(Boolean):[]});break;
      case 'library package update': {
        const body=await readJsonFile(required('file'),'材料包修改');data=await versioned(`/api/material-library/packages/${uuid('package')}`,'PATCH',required('version'),body);break;
      }
      case 'library package archive': data=await versioned(`/api/material-library/packages/${uuid('package')}`,'DELETE',required('version'));break;
      case 'library package restore': data=await versioned(`/api/material-library/packages/${uuid('package')}/restore`,'POST',required('version'));break;
      case 'library files prepare': {try{data=await prepareLibraryFiles(required('manifest'),required('out'),signal);}catch(error){throw new CliError(error instanceof Error?error.message:'材料预处理失败',{kind:'file_error'});}break;}
      case 'library revision create': data=await createLibraryRevision(uuid('package'));break;
      case 'library template list': data=await get('/api/material-library/redaction-templates');break;
      case 'library template show': {const catalog=await get('/api/material-library/redaction-templates');data=catalog.items.find((t:any)=>t.id===required('template'));if(!data)throw new CliError('脱敏模板不存在');break;}
      case 'library job start': {
        const kind=required('kind'),target=required('target');
        if(!['intake','extract','redact'].includes(kind)||!['local','server'].includes(target))throw new CliError('任务 kind 或 execution target 无效');
        const hasAgentModel=flags.has('agent-model'),hasReasoningEffort=flags.has('reasoning-effort');
        if(hasAgentModel!==hasReasoningEffort)throw new CliError('--agent-model 与 --reasoning-effort 必须同时提供');
        if(hasAgentModel&&kind!=='redact')throw new CliError('Agent模型设置仅用于redact任务');
        const body={kind,request_key:uuid('request-key'),execution_target:target,...(flags.has('project')?{project_id:uuid('project')}:{}),...(flags.has('template')?{template_id:required('template')}:{}),...(flags.has('extraction-job')?{extraction_job_id:uuid('extraction-job')}:{}) ,...(flags.has('previous-job')?{previous_job_id:uuid('previous-job')}:{}) ,...(hasAgentModel?{agent_settings:{model:required('agent-model'),reasoning_effort:required('reasoning-effort')}}:{})};
        data=await post(`/api/material-library/revisions/${uuid('revision')}/jobs`,body);break;
      }
      case 'library prepare start': {
        if(flags.has('redaction')===flags.has('extraction-job'))throw new CliError('须且只能提供 --redaction 或 --extraction-job');
        if(flags.has('agent-model')!==flags.has('reasoning-effort'))throw new CliError('Agent模型和强度须同时提供');
        data=await post(`/api/material-library/revisions/${uuid('revision')}/prepare`,{request_key:uuid('request-key'),...(flags.has('execution-timeout')?{execution_timeout_ms:duration(required('execution-timeout'),86400000)}:{}),...(flags.has('redaction')?{redaction_id:uuid('redaction')}:{extraction_job_id:uuid('extraction-job')}),...(flags.has('project')?{project_id:uuid('project')}:{}),...(flags.has('agent-model')?{agent_settings:{model:required('agent-model'),reasoning_effort:required('reasoning-effort')}}:{})});break;
      }
      case 'library prepare resume': data=await post(`/api/material-library/jobs/${uuid('job')}/prepare-resume`,{request_key:uuid('request-key'),...(flags.has('execution-timeout')?{execution_timeout_ms:duration(required('execution-timeout'),86400000)}:{})});break;
      case 'library prepare diagnose': {
        const job=await get(`/api/material-library/jobs/${uuid('job')}`);
        if(job.kind!=='prepare')throw new CliError('指定任务不是材料整理任务');
        data={job_id:job.id,status:job.status,started_at:job.started_at,finished_at:job.finished_at,stop_reason:job.result_summary?.execution_stop?.reason_code??null};
        if(job.status==='succeeded'){
          const prepared=await get(`/api/material-library/preparations/${job.result_summary?.preparation_id??job.id}`),r=prepared.result??{},documents=Array.isArray(r.documents)?r.documents:[];
          data={...data,document_count:r.document_count??null,entry_count:documents.length,unassigned_group_count:r.unassigned_group_count??null,unassigned_block_count:r.unassigned_block_count??null,summary_count:documents.filter((d:any)=>typeof d.summary==='string'&&d.summary.trim()).length,visible_count:documents.filter((d:any)=>d.visibility!=='hidden').length,hidden_count:documents.filter((d:any)=>d.visibility==='hidden').length,combination_count:Array.isArray(r.combinations)?r.combinations.length:0,warning_count:Array.isArray(r.warnings)?r.warnings.length:0};
        }
        break;
      }
      case 'library prepare list': data=await get(`/api/material-library/packages/${uuid('package')}/preparations`);break;
      case 'library prepare show': data=await get(`/api/material-library/preparations/${uuid('preparation')}${flags.has('content')?'?include_content=true':''}`);break;
      case 'library job wait': {
        const jobId=uuid('job'),deadline=performance.now()+duration(flags.has('timeout')?required('timeout'):'1h');
        do {
          data=await get(`/api/material-library/jobs/${jobId}`);
          if(!['queued','running'].includes(data.status))return{outcome:data.status==='succeeded'?'complete':'partial',data};
          if(performance.now()>=deadline)break;
          await new Promise<void>(resolve=>{const done=()=>{clearTimeout(timer);signal?.removeEventListener('abort',done);resolve();};const timer=setTimeout(done,Math.min(1000,Math.max(0,deadline-performance.now())));signal?.addEventListener('abort',done,{once:true});if(signal?.aborted)done();});
          if(signal?.aborted)break;
        }while(performance.now()<deadline);
        return{outcome:'waiting',data,note:'仅结束等待，后台材料任务不取消、不重派'};
      }
      case 'library job show': data=await get(`/api/material-library/jobs/${uuid('job')}`);break;
      case 'library job cancel': data=await post(`/api/material-library/jobs/${uuid('job')}/cancel`);break;
      case 'library documents show': data=await get(`/api/material-library/revisions/${uuid('revision')}/documents${queryString([['extraction_job_id',uuid('extraction-job')],['file_id',flags.has('file')?uuid('file'):undefined]])}`);break;
      case 'library documents export': data=await exportPreparedMaterials(api,required('plan'),required('out'),signal);break;
      case 'library documents import': {
       const plan=await readJsonFile(required('plan'),'材料处理计划');
       try{validateMaterialPreparationPlan(plan);}catch(error){throw new CliError(error instanceof Error?error.message:'材料处理计划无效');}
       data=await post(`/api/material-library/revisions/${plan.revision_id}/prepared-redactions`,{request_key:uuid('request-key'),plan});break;
      }
      case 'library redaction show': data=await get(`/api/material-library/redactions/${uuid('redaction')}/preview${queryString([['file_id',flags.has('file')?uuid('file'):undefined]])}`);break;
      case 'library file download': {
        const out=required('out'),bytes=await api.download(`/api/material-library/files/${uuid('file')}/content`,signal);
        try{await writeFile(out,bytes,{flag:'wx',mode:0o600});}catch{throw new CliError('无法写入下载文件；目标须不存在且父目录已创建',{kind:'file_error'});}
        data={path:out,bytes:bytes.length,source:'library_original'};break;
      }
      case 'library processing show': data=await get('/api/material-library/processing-settings');break;
      case 'library processing update': {
        const body=await readJsonFile(required('file'),'材料处理设置');data=await api.json('/api/material-library/processing-settings','PUT',body,signal,versionHeader(required('version')));break;
      }
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
      case 'question delete': {
        const projectId=uuid('project'),workflowId=uuid('workflow');
        const detail=object(await get(`/api/workflows/${workflowId}`),'题目');
        const workflow=detail.workflow;
        if(workflow?.workflow_kind!=='question'||workflow.project_id!==projectId)throw new CliError('题目不属于指定期次或不是题目工作流；未删除任何数据');
        if(required('confirm-title')!==workflow.title)throw new CliError('确认题目名与当前名称不完全一致；未删除任何数据');
        if(!Array.isArray(detail.attempts))throw new CliError('题目响应缺少尝试状态；未删除任何数据',{kind:'invalid_response'});
        if(detail.attempts.some((attempt:any)=>['waiting','running'].includes(attempt.status)))throw new CliError('题目仍有活动尝试；未删除任何数据');
        data=await del(`/api/workflows/${workflowId}`);break;
      }
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
        const backend=flags.has('material-backend')?required('material-backend'):'library_v1';
        if(!['legacy','library_v1'].includes(backend))throw new CliError('material-backend 须为 legacy 或 library_v1');
        const root=flags.has('material-root')?required('material-root'):undefined;
        const workspace=flags.has('workspace-path')?required('workspace-path'):undefined;
        const skill=flags.has('skill-path')?required('skill-path'):undefined;
        if((backend==='legacy'&&!root)||(backend==='library_v1'&&!workspace))throw new CliError('legacy 需要 material-root，library_v1 需要 workspace-path；项目目录使用仓库相对路径');
        const settings=flags.has('settings-file')?await readJsonFile(required('settings-file'),'项目设置'):undefined;
        const materialMode=flags.has('material-mode')?required('material-mode'):(backend==='legacy'?'question_folders':'material_packages');
        if(!['question_folders','material_packages'].includes(materialMode))throw new CliError('material-mode 须为 question_folders 或 material_packages');
        if(backend==='library_v1'&&materialMode!=='material_packages')throw new CliError('共享材料库使用material_packages；旧目录模式须显式选择legacy');
        let parentName=flags.has('parent-name')?required('parent-name'):undefined;
        if(flags.has('project-group')&&parentName===undefined){
          const detail=object(await get(`/api/project-groups/${uuid('project-group')}/phases`),'主项目');
          if(typeof detail.group?.name!=='string'||!detail.group.name.trim())throw new CliError('主项目响应缺少名称，未创建期次',{kind:'invalid_response'});
          parentName=detail.group.name;
        }
        if(backend==='library_v1'&&parentName===undefined)parentName=required('name');
        const body={name:required('name'),description:flags.get('description')??'',...(flags.has('material-backend')?{material_backend:backend}:{}),
          ...(root?{material_root:root}:{}),...(workspace?{workspace_path:workspace}:{}),
          ...(flags.has('material-mode')?{material_mode:materialMode}:{}),
          ...(parentName!==undefined?{parent_name:parentName} : {}),
          ...(flags.has('phase-name')?{phase_name:required('phase-name')} : {}),
          ...(flags.has('phase-no')?{phase_no:positiveInteger(required('phase-no'),'期数')} : backend==='library_v1'?{phase_no:1}:{}),
          ...(flags.has('project-group')?{project_group_id:uuid('project-group')} : {}),...(skill?{local_skill_path:skill}:{})};
        let created:Record<string,any>;
        try{created=object(await post('/api/projects',body),'项目创建');}
        catch(error){
          if(!body.phase_no||!body.parent_name)throw error;
          const receipt=await post('/api/projects/creation-receipt',body);
          const recovered=receipt?.project;
          if(!recovered)throw error;
          created=object(recovered,'恢复项目创建回执');
        }
        const projectId=id(created.project?.id??created.id,'project');
        if(settings){let setup;try{setup=await applySettings(projectId,settings);}catch(error){return{outcome:'partial',data:{project:created,setup:{outcome:'not_applied',error:error instanceof CliError?{message:error.message,...error.detail}:{kind:'unknown_error'}},note:'项目已创建；设置校验失败，没有自动删除项目。'}};}let readiness;try{readiness=await projectSettings(projectId);}catch(error){return{outcome:'partial',data:{project:created,setup,readiness_error:error instanceof CliError?{message:error.message,...error.detail}:{kind:'unknown_error'}}};}data={project:created,setup,readiness};if(setup.outcome==='partial')return{outcome:'partial',data};}
        else {try{const readiness=await projectSettings(projectId);data={project:created,readiness:{...readiness.readiness,notes:readiness.notes}};}catch(error){return{outcome:'partial',data:{project:created,setup:{outcome:'not_applied',reason:'未提供 --settings-file'},readiness_error:error instanceof CliError?{message:error.message,...error.detail}:{kind:'unknown_error'}}};}}
        break;
      }
      case 'project update': {
        const projectId=uuid('project'),current=object(await get(`/api/projects/${projectId}`),'项目').project;
        if(!current)throw new CliError('项目响应缺少详情',{kind:'invalid_response'});
        if(!['name','parent-name','phase-name','description','material-root','workspace-path','skill-path'].some(key=>flags.has(key)))throw new CliError('project update 至少需要一个要修改的字段');
        const library=current.material_backend==='library_v1';
        if(!library&&flags.has('workspace-path'))throw new CliError('旧目录项目使用 material-root，不设置材料库工作区');
        if(library&&flags.has('material-root'))throw new CliError('材料库期次通过加载材料包使用材料，不设置旧材料目录');
        const root=flags.has('material-root')?required('material-root'):current.material_root;
        const skill=flags.has('skill-path')?required('skill-path'):undefined;
        if(!library&&(typeof root!=='string'||!root.trim()))throw new CliError('旧目录项目需要材料目录');
        data=await patch(`/api/projects/${projectId}`,{name:flags.has('name')?required('name'):current.name,description:flags.has('description')?required('description'):current.description,...(!library?{material_root:root}:{}),...(flags.has('parent-name')?{parent_name:required('parent-name')} : {}),...(flags.has('phase-name')?{phase_name:required('phase-name')} : {}),...(skill!==undefined?{local_skill_path:skill}:{}),...(flags.has('workspace-path')?{workspace_path:required('workspace-path')}:{})});break;
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
      case 'queue show': data=await get('/api/system/execution-queue');break;
      case 'queue diagnose': {const [queue,monitor]=await Promise.all([get('/api/system/execution-queue'),get('/api/monitor')]);data=diagnoseQueue(queue,monitor);break;}
      case 'queue cancel': data=await post(`/api/system/execution-queue/${uuid('job')}/cancel`);break;
      case 'advice show': data=await get(`/api/workflows/${uuid('workflow')}/revision-advice`);break;
      case 'advice generate': {
        const generate=async(workflow:string)=>{try{return await post(`/api/workflows/${workflow}/revision-advice`);}catch(error){if(error instanceof CliError&&error.detail.kind==='http_error'&&typeof error.detail.http_status==='number'&&error.detail.http_status>=400&&error.detail.http_status<500)throw new CliError(error.message,{...error.detail,outcome_unknown:false,dispatched:false});throw error;}};
        if(flags.has('workflow')){if(['project','ids','all'].some(key=>flags.has(key)))throw new CliError('--workflow不可与项目批量范围并用');data=await generate(uuid('workflow'));break;}
        const {project,selected}=await scope(4);const results:any[]=[];let full=false,unknown=false;
        for(const workflow of selected){
          if(full||unknown){results.push({workflow_id:workflow,status:'not_dispatched',reason:full?'本机待领取容量已满':'上项回执未知，停止继续派发'});continue;}
          try{const result=await generate(workflow);results.push({workflow_id:workflow,status:'queued',...object(result,'返修建议')});}
          catch(error){const detail=error instanceof CliError?error.detail:{};full=detail.code==='local_queue_full';unknown=detail.outcome_unknown===true;results.push({workflow_id:workflow,status:full?'capacity_exceeded':'not_dispatched',error:error instanceof Error?error.message:'派发失败',...detail});}
        }
        return{outcome:results.every(row=>row.status==='queued')?'complete':'partial',project_id:project,results,advice_attempt_ids:results.filter(row=>row.status==='queued').map(row=>row.id)};
      }
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
        return {outcome:failed||results.some(r=>!['queued','succeeded','already_accepted','already_archived'].includes(r.status))?'partial':'complete',
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
      case 'siriser download': {
        const out=required('out');
        const bytes=await api.download(`/api/workflows/${uuid('workflow')}/siriser-zip`,signal);
        try {await writeFile(out,bytes,{flag:'wx',mode:0o600});}
        catch {throw new CliError('无法写入下载文件；目标须不存在且父目录已创建',{kind:'file_error'});}
        data={path:out,bytes:bytes.length,package:'siriser_five_piece',submission_performed:false};break;
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
  let pending=[...ids];
  // 每轮每个任务最多读一次；长任务不能独占查询worker直到总截止时间。
  do {
    const round=pending;const broad=round.length>4;pending=[];
    const worker=async()=>{
      while(round.length&&!budget?.aborted){
        if(signal?.aborted)throw new CliError('等待已中断，后台任务继续执行',{kind:'interrupted'});
        const attempt=round.shift()!;
        // 多于4项时先快速覆盖整组，避免首批长轮询饿死后续任务。
        const waitMs=broad?0:Math.min(1000,Math.max(0,Math.floor(deadline-performance.now())));
        try{
          const data=object(await api.json(`/api/attempts/${attempt}?wait_ms=${waitMs}${full?'':'&view=status'}`,'GET',undefined,readSignal),'任务');
          if(data.id!==attempt||!['waiting','running','succeeded','failed','skipped'].includes(data.status))throw new CliError('任务响应身份或状态无效',{kind:'invalid_response'});
          const {id,workflow_id,ordinal,status,error,started_at,finished_at,completed}=data;
          snapshots.set(attempt,full?data:{id,workflow_id,ordinal,status,error,started_at,finished_at,completed});
          if(['waiting','running'].includes(status))pending.push(attempt);
        }catch(error){
          if(signal?.aborted)throw error;
          if(!budget?.aborted)errors.set(attempt,error instanceof CliError?{message:error.message,...error.detail}:{kind:'unknown_error'});
        }
      }
    };
    await Promise.all(Array.from({length:Math.min(4,round.length)},worker));
    if(!pending.length||performance.now()>=deadline||budget?.aborted)break;
    await new Promise<void>(resolve=>{
      const finish=()=>{clearTimeout(timer);signal?.removeEventListener('abort',finish);resolve();};
      const timer=setTimeout(finish,Math.min(250,Math.max(0,deadline-performance.now())));
      signal?.addEventListener('abort',finish,{once:true});if(signal?.aborted)finish();
    });
  }while(performance.now()<deadline);
  const attempts=ids.map(attempt=>({id:attempt,...(snapshots.get(attempt)??{}),...(errors.has(attempt)?{read_error:errors.get(attempt)}:{})}));
  const stillRunning=attempts.some(a=>!a.status||['waiting','running'].includes(a.status));
  return {outcome:errors.size||attempts.some(a=>a.status==='failed')?'partial':stillRunning?'waiting':'complete',attempts,
    completion_scope:'attempt',note:'终态仅代表attempt执行结束；达标结论须重新读取 result show。归档成功不代表飞书交付完成，须另查 workflow delivery show 的回执。等待到期不会取消或重新派发任务。'};
}
