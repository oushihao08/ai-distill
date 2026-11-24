/** 职责：CLI 命令解析、参数白名单、HTTP 路由映射、批次回执核对与有界等待；入口 runCommand()，不直连数据库或运行模型。 */
import {planLibraryBatch,runLibraryBatch} from './library-batch';

import {prepareLibraryFiles} from '../server/materials/prepare-library-files';
import {readFile} from 'node:fs/promises';
import {basename,dirname,resolve} from 'node:path';
import {getStepDefinition, STEP_REGISTRY} from '../shared/step-registry';
import {readAcceptanceResult} from '../shared/workflow-results';
import {ApiClient, CliError} from './client';
import {diagnoseQueue} from './queue-diagnostics';
import {batchSize,batchView,createBatch,readBatch,skipBatch} from './batches';
import {exportFailedQuestions} from './failed-export';
import {exportPreparedMaterials} from './material-export';
import {feishuAttachmentFormat,feishuTarget,readFeishuConfig,syncFeishuBatch,FEISHU_CONFIG_TIMEOUT_MS,FEISHU_REQUEST_TIMEOUT_MS} from './feishu';
import {syncLocalFeishu} from './feishu-local';
import {loadPackageIntoProject,onboardProjectMaterials} from './project-onboard';
import {
  UUID_PATTERN,
  abortableSleep,
  assertUuid,
  ensurePlainObject,
  fetchAllProjectWorkflowItems,
  mapWithConcurrency,
  readJsonObjectFile,
} from './shared';
import {validateMaterialPreparationPlan} from '../shared/material-preparation';
import {WEB_AGENT_PROVIDERS,validateWebAgentSettings,type WebAgentSettings} from '../shared/web-agent';
import {OFFLINE_STAGES,offlineExport,offlineImport,offlineStatus,type OfflineStage} from './offline';

export const HELP = `ai-distill（全部命令支持 --json；本机命令接受 --api URL；支持前缀筛选如 library --help、project --help、custom-step --help、feishu --help）
详情：cli/README.md | 工具地图：skill/MAP.md#cli-工具地图 | 退出码：0 受理/终态(≠达标) 1 错误 2 部分失败/未就绪 3 等待超时 130 中断
【项目与期次】
  project list | project show --project UUID [--workflow-page N] [--workflow-page-size N]
  project create --name 名称 [--material-backend library_v1 --workspace-path 相对路径 | --material-backend legacy --material-root 相对路径] [--parent-name 主项目 --phase-name 期名 --phase-no N] [--project-group UUID] [--skill-path 相对路径] [--settings-file JSON]
  project update --project UUID [--name|--parent-name|--phase-name|--description|--workspace-path|--material-root|--skill-path ...]
  project phase-update --project UUID --phase-no N --phase-name 期名 --expected-name 当前全名 | project delete --project UUID --confirm-name 精确全名
  project settings show --project UUID | project settings apply --project UUID --file JSON | project prompt update --project UUID --ordinal 4|5|6 --file 提示词文件 [--expected-prompt-file 旧文本] | project sync --project UUID
  project-group list | project-group phases --group UUID | project-group rename|archive|restore --group UUID [--name 名称]
  rules list --project UUID | rules file --project UUID --path 路径 | rules update --project UUID --path materials/文件名 --file 本地文件 [--expected-sha256 SHA|null] | rules delete --project UUID --path materials/文件名 --expected-sha256 SHA
  project skill list --project UUID | project skill generate --project UUID --file JSON | project skill adopt --project UUID --attempt UUID
【全局材料库与期次加载】
  library files prepare --manifest JSON --out 新目录 | library import --name 名称 --request-key UUID --manifest JSON [--pdf-provider glm-ocr|mineru-api|mineru-cli] [--preserve-images]
  library imports list [--page N] [--page-size N] | library revision create --package UUID --version N --request-key UUID --manifest JSON [--pdf-provider ...] [--preserve-images]
  library package list [--q 词] [--page N] [--page-size N] [--ready-only] [--redaction-state all|ready|not_ready] [--preparation-state all|ready|not_ready] [--archived-only] [--project UUID]
  library package show|usage --package UUID | library package revisions --package UUID [--page N] [--page-size N]
  library package update --package UUID --version N --file JSON | library package archive|restore --package UUID --version N | library package create（已停用410）
  library job start --revision UUID --kind intake|extract|redact --target local|server --request-key UUID [--pdf-provider ...] [--extraction-job UUID] [--previous-job UUID] [--template ID] [--project UUID] [--agent-model 模型 --reasoning-effort 等级 | --api-provider 供应商 --api-model 模型 [--api-base-url URL] [--api-thinking on|off] | --api-settings-file JSON]
  library job show|cancel --job UUID | library job wait --job UUID [--timeout 1h]
  library prepare start --revision UUID (--redaction UUID | --extraction-job UUID) --request-key UUID [--project UUID] [--agent-model 模型 --reasoning-effort 等级 | --api-provider 供应商 --api-model 模型 [--api-base-url URL] [--api-thinking on|off] | --api-settings-file JSON | --web deepseek|gemini [--web-thinking on|off] [--web-model-label 标签]] [--execution-timeout 30m] [--force]
  library prepare resume --job UUID --request-key UUID [--execution-timeout 30m] | library prepare diagnose --job UUID
  library prepare list --package UUID [--revision UUID] [--redaction UUID] [--project UUID] [--page N] [--page-size N] [--summary-only] | library prepare show --preparation UUID [--content]
  library batch plan --kind intake|extract|redact|prepare (--project-query 简称 | --project UUID | --q 词) [--redaction-state ...] [--preparation-state ...] [--extraction-state ...] --out 新清单.json | library batch run --file 清单.json
  library documents show --revision UUID --extraction-job UUID [--file UUID] | library documents export --plan JSON --out 新目录 | library documents import --plan JSON --request-key UUID
  library redaction show --redaction UUID [--file UUID] [--metadata-only] | library redaction revalidate --redaction UUID | library file download --file UUID --out 新路径
  library template list | library template show --template ID | library processing show | library processing update --version N --file JSON
  project material candidates --project UUID [--q 词] [--page N] [--page-size N] [--source-mode any|redacted|original]
  project materials mode --project UUID | project materials summary --project UUID [--processing-mode aliases|original|mask]
  project materials list --project UUID [--include-removed] [--page N] [--page-size N] | project materials load --project UUID --package UUID [--redaction UUID | --revision UUID] [--reuse-workflow UUID --direction 方向] [--allow-short]
  project materials onboard --project UUID (--package UUID | --packages UUID,... | --count N [--q 词] | --file 清单.json) [--title 名称] [--request-key UUID] [--redaction UUID | --revision UUID] [--level L2|L3|L4|L5] [--scenario 场景] [--role 角色] [--direction 方向] [--tags a,b] [--reuse-workflow UUID] [--require-prepared] [--load-only] [--allow-short] [--out 新回执.json]
  project materials update --project UUID --link UUID --version N [--redaction UUID | --revision UUID] [--position N] | project materials remove|restore --project UUID --link UUID --version N
  project materials question --project UUID --link UUID --version N (--redaction UUID | --revision UUID) --title 名称 --request-key UUID [--role 角色] [--scenario 场景] [--level L2|L3|L4|L5] [--direction 方向] [--tags a,b]
  project material uses --project UUID [--page N] [--page-size N] | project material use events --project UUID --use UUID [--page N] [--page-size N] | project material use update --project UUID --use UUID --version N --status in_use|submitted --reason 原因 [--evidence-file JSON]
  project legacy-materials list --project UUID | project legacy-materials import --project UUID --workflow UUID --request-key UUID [--apply --digest SHA256] | project legacy-materials activate --project UUID --import UUID
  material-package list --project UUID [--page N] [--page-size N] | material-package versions --workflow UUID | project material-mode --project UUID --clear-existing
【工作流、定制步骤、队列与通道】
  question list --project UUID [--page N] [--limit N] | question show --workflow UUID [--status] | question create --material-package UUID --redaction-attempt UUID --title 名称 [...] | question delete --project UUID --workflow UUID --confirm-title 精确名
  workflow status --project UUID (--ids UUID,... | --all) | workflow attempts --workflow UUID --ordinal N [--offset N] | workflow delivery show (--workflow UUID | --project UUID (--ids UUID,... | --all) [--base-token BASE --table TABLE])
  workflow design update --workflow UUID [--direction 文本] [--scenario 文本] [--role 文本] | workflow opening revise --workflow UUID --file JSON | workflow material-scope sync --workflow UUID
  workflow authoring restore --workflow UUID --attempt UUID | workflow authoring select --workflow UUID --attempt UUID --expected-latest-attempt UUID | workflow answer-score restore --workflow UUID [--answer-only]
  workflow publish --workflow UUID [--task-id ID --org ORG] | workflow archive withdraw --workflow UUID | workflow library-history --workflow UUID
  workflow deleted-sources --project UUID --ids UUID,... | workflow restore-deleted --project UUID --deleted-after ISO --expected-count N
  workflow material-docx generate --workflow UUID | workflow redacted-docx generate --workflow UUID | workflow material-image-docx download --workflow UUID --out 新路径 [--preparation UUID] | workflow archive-xlsx download --workflow UUID --out 新路径
  custom-step list --workflow UUID | custom-step run --workflow UUID --step KEY [--file JSON] | custom-step wait --workflow UUID --step KEY [--timeout 1h] | custom-step cancel --workflow UUID --step KEY | custom-step repair-evaluation --workflow UUID --step KEY --file JSON
  workflow hooks show --workflow UUID | hook retry --hook UUID [--acknowledge-side-effects] | attempt resume-hooks --attempt UUID [--acknowledge-side-effects]
  material text --workflow UUID --material UUID --redacted-only | material download --material UUID --out 新路径
  models catalog | models api-catalog | models show --project UUID | models register --file JSON | models toggle --model-id UUID --enabled true|false
  step list | step dispatch STEP_KEY --project UUID (--ids UUID,... | --all) [--provider codex|agy --model 模型 --reasoning-effort 等级 | --web deepseek|gemini [--web-thinking on|off] [--web-model-label 标签]]
  attempt show --attempt UUID | attempt wait --ids UUID,... [--timeout 1h] [--full] | attempt cancel-waiting-score --attempt UUID --workflow UUID --executor UUID | attempt cancel-stopped-executor --attempt UUID --workflow UUID --executor UUID --expected-heartbeat ISO|null --executor-stopped --acknowledge-unknown-result
  advice show --workflow UUID | advice generate (--workflow UUID | --project UUID (--ids UUID,... | --all))
  batch create --project UUID (--ids UUID,... | --all) --size N --to STEP_KEY --out 新路径 | batch show --file 路径 | batch skip --file 路径 --ids UUID,... --reason 原因
  dispatch preview|start (--file 清单.json | --url https://清单地址) | dispatch list | dispatch show --batch UUID [--summary | --state 状态] | dispatch stop|events --batch UUID [--after N] | dispatch limits --batch UUID --file 容量.json
  system health | monitor sources | monitor show [--source ID] | queue show [--history] | queue diagnose | queue cancel --job UUID | queue adopt --file JSON | queue abandon-job --job UUID --acknowledge-unknown-result | queue abandon-import --job UUID --acknowledge-unknown-result | queue reconcile-failed --job UUID --event UUID --instance UUID
  system concurrency show | system concurrency update --file JSON | system prompts show | system prompts update --file JSON | agent config show | agent config update --file JSON | agent test
  web status | web doctor | web login --provider deepseek|gemini | web close
  offline export --stage redact|prepare|author --out 目录 [--count N] [--web deepseek|gemini] [--project UUID] [--ids UUID,...] | offline import --out 目录 | offline status --out 目录
  remote material run|start --workflow UUID --mode intake|redact|intake-redact --request-key UUID | remote material status|sync (--operation UUID | --workflow UUID --request-key UUID)
  remote answer run|start|status --workflow UUID --request-key UUID
【成果、导出与飞书交付】
  result list [--page N] [--page-size N] [--q 词] [--publication all|archived|pending] | result show --workflow UUID
  export list --project UUID [--page N] [--page-size N] | export create --project UUID [--batch 批次] | export failed --project UUID (--ids UUID,... | --all) | export review --project UUID --ids UUID,...
  artifact download --artifact UUID --out 新路径 | export download --export UUID --out 新路径 | siriser download --workflow UUID --out 新路径 | skill-dependency download --workflow UUID --out 新路径
  feishu config show --project UUID | feishu config set --project UUID [--base-token BASE --table TABLE] [--attachment-format docx|pdf] | feishu table create --project UUID --name 表名 [--base-token BASE]
  feishu draft-sync --workflow UUID [--base-token BASE --table TABLE] [--revision-attempt UUID | --replace-record-id recID] [--attachment-format docx|pdf] [--combined-material]
  feishu draft-sync-batch --project UUID --ids UUID,... --out 新文件.json [--base-token BASE --table TABLE] [--attachment-format docx|pdf] [--combined-material] [--concurrency N]
  feishu sync --workflow UUID [--base-token BASE --table TABLE] [--attachment-format docx|pdf] [--combined-material]
  feishu sync-batch --project UUID --ids UUID,... --out 新文件.json [--base-token BASE --table TABLE] [--attachment-format docx|pdf] [--combined-material] [--concurrency N]
  feishu local-sync --manifest 清单.json --out 新回执.json --base-token BASE --table TABLE
`;

function parse(args: string[]) {
  const words: string[]=[]; const flags=new Map<string,string|true>();
  for(let i=0;i<args.length;i++) {
    const value=args[i];
    if (!value.startsWith('--')) { words.push(value); continue; }
    const key=value.slice(2);
    if (flags.has(key)) throw new CliError(`参数重复：--${key}`);
    if (['force','all','redacted-only','json','help','full','content','clear-existing','ready-only','archived-only','include-removed','apply','acknowledge-side-effects','preserve-images','combined-material','summary-only','summary','history','metadata-only','acknowledge-unknown-result','require-prepared','load-only','allow-short','answer-only','executor-stopped'].includes(key)) flags.set(key,true);
    else if (key==='status'&&(args[i+1]===undefined||args[i+1].startsWith('--'))) flags.set(key,true);
    else {
      const next=args[++i]; if(next===undefined||next.startsWith('--')) throw new CliError(`参数缺值：--${key}`);
      flags.set(key,next);
    }
  }
  return {words,flags};
}
const id = assertUuid;
function duration(value: string,maximum=3600000) {
  const match=/^(\d+(?:\.\d+)?)(ms|s|m|h)$/.exec(value);
  const ms=match?Number(match[1])*({ms:1,s:1000,m:60000,h:3600000}[match[2]]!):NaN;
  if(!Number.isFinite(ms)||ms<0||ms>maximum) throw new CliError(`时间须为0至${maximum/3600000}小时，如 30s、10m、1h`);
  return ms;
}
const object = ensurePlainObject;
const dispatchStatuses=new Set(['queued','succeeded','not_ready','failed','not_found','capacity_exceeded','already_accepted','already_archived']);
/**
 * 批量派发回执是 CLI 判断“哪些题已受理”的唯一依据，因此必须逐项绑定本次请求身份。
 * 这里只验证 workflow/attempt ID、唯一性和状态枚举；就绪、版本、队列容量及业务结果仍由 API 决定，
 * 不能在客户端复制服务端规则，也不能用数量相同替代身份相同。
 */
function dispatchResults(value:unknown,requested:string[]){
  if(!Array.isArray(value))throw new CliError('派发响应缺少 results',{kind:'invalid_response',outcome_unknown:true});
  const requestedSet=new Set(requested),seen=new Set<string>();
  for(const row of value){
    if(!row||typeof row!=='object'||Array.isArray(row))throw new CliError('派发回执条目无效',{kind:'invalid_response',outcome_unknown:true});
    const item=row as Record<string,unknown>,workflowId=item.workflow_id,status=item.status;
    if(typeof workflowId!=='string'||!requestedSet.has(workflowId)||seen.has(workflowId))throw new CliError('派发回执题目身份与请求不一致',{kind:'invalid_response',outcome_unknown:true});
    if(typeof status!=='string'||!dispatchStatuses.has(status))throw new CliError('派发回执状态无效',{kind:'invalid_response',outcome_unknown:true});
    if(item.attempt_id!==undefined&&(typeof item.attempt_id!=='string'||!UUID_PATTERN.test(item.attempt_id)))throw new CliError('派发回执 attempt_id 无效',{kind:'invalid_response',outcome_unknown:true});
    if(item.attempt_ids!==undefined){
      if(!Array.isArray(item.attempt_ids)||new Set(item.attempt_ids).size!==item.attempt_ids.length)throw new CliError('派发回执 attempt_ids 无效',{kind:'invalid_response',outcome_unknown:true});
      if(item.attempt_ids.some(attemptId=>typeof attemptId!=='string'||!UUID_PATTERN.test(attemptId)))throw new CliError('派发回执 attempt_ids 无效',{kind:'invalid_response',outcome_unknown:true});
    }
    seen.add(workflowId);
  }
  if(value.length!==requested.length||seen.size!==requestedSet.size)throw new CliError('派发回执未完整覆盖请求题目',{kind:'invalid_response',outcome_unknown:true});
  return value as Array<Record<string,any>>;
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

const COMMAND_FLAGS: Readonly<Record<string,readonly string[]>> = {
      'project list':[], 'project show':['project','workflow-page','workflow-page-size'], 'project create':['name','parent-name','phase-name','phase-no','project-group','description','material-root','workspace-path','skill-path','settings-file','material-mode','material-backend'],
      'project phase-update':['project','phase-no','phase-name','expected-name'],
      'project material-mode':['project','clear-existing'],
      'project update':['project','name','parent-name','phase-name','description','material-root','workspace-path','skill-path'], 'project delete':['project','confirm-name'],
      'project settings show':['project'], 'project settings apply':['project','file'], 'project prompt update':['project','ordinal','file','expected-prompt-file'], 'project sync':['project'],
      'project skill list':['project'], 'project skill generate':['project','file'], 'project skill adopt':['project','attempt'],
      'project-group list':[],'project-group phases':['group'],'project-group rename':['group','name'],'project-group archive':['group'],'project-group restore':['group'],
      'project material candidates':['project','q','page','page-size','source-mode'],'project material uses':['project','page','page-size'],
      'project material use events':['project','use','page','page-size'],'project material use update':['project','use','version','status','reason','evidence-file'],
      'project legacy-materials list':['project'],'project legacy-materials import':['project','workflow','request-key','apply','digest'],'project legacy-materials activate':['project','import'],
      'project materials mode':['project'],'project materials summary':['project','processing-mode'],
      'project materials list':['project','include-removed','page','page-size'],'project materials load':['project','package','redaction','revision','reuse-workflow','direction','allow-short'],
      'project materials onboard':['project','package','packages','count','q','file','out','redaction','revision','request-key','title','scenario','role','level','direction','tags','reuse-workflow','require-prepared','load-only','allow-short'],
      'project materials update':['project','link','version','redaction','revision','position'],
      'project materials remove':['project','link','version'],'project materials restore':['project','link','version'],
      'project materials question':['project','link','version','redaction','revision','title','request-key','scenario','role','level','direction','tags'],
      'library package list':['q','page','page-size','ready-only','redaction-state','preparation-state','archived-only','project'],'library package show':['package'],
      'library package usage':['package'],'library package revisions':['package','page','page-size'],'library package create':['name','description','tags'],
      'library package update':['package','version','file'],'library package archive':['package','version'],'library package restore':['package','version'],
      'library files prepare':['manifest','out'],'library import':['name','manifest','request-key','pdf-provider','preserve-images'],'library imports list':['page','page-size'],
      'library batch plan':['kind','project','project-query','q','redaction-state','preparation-state','extraction-state','out'],
      'library batch run':['file'],
      'library revision create':['package','version','request-key','manifest','pdf-provider','preserve-images'],
      'library job start':['revision','kind','target','request-key','pdf-provider','extraction-job','previous-job','template','project','agent-model','reasoning-effort','api-provider','api-model','api-base-url','api-thinking','api-settings-file','web','web-thinking','web-model-label'],
      'library job show':['job'],'library job cancel':['job'],'library job wait':['job','timeout'],
      'library prepare start':['revision','redaction','extraction-job','request-key','project','agent-model','reasoning-effort','api-provider','api-model','api-base-url','api-thinking','api-settings-file','execution-timeout','force','web','web-thinking','web-model-label'],'library prepare resume':['job','request-key','execution-timeout'],'library prepare diagnose':['job'],'library prepare list':['package','revision','redaction','project','page','page-size','summary-only'],'library prepare show':['preparation','content'],
      'library template list':[],'library template show':['template'],
      'library redaction revalidate':['redaction'],
      'library documents show':['revision','extraction-job','file'],'library documents export':['plan','out'],'library documents import':['plan','request-key'],'library redaction show':['redaction','file','metadata-only'],
      'library file download':['file','out'],
      'library processing show':[],'library processing update':['version','file'],
      'material-package list':['project','page','page-size'],'material-package versions':['workflow'],
      'question list':['project','limit','page'],'question show':['workflow','status'],'question delete':['project','workflow','confirm-title'],'question create':['material-package','redaction-attempt','title','scenario','role','level','direction'],'workflow status':['project','ids','all'],
      'workflow attempts':['workflow','ordinal','offset'],
      'workflow design update':['workflow','direction','scenario','role'],
      'workflow opening revise':['workflow','file'],'workflow material-scope sync':['workflow'],
      'workflow authoring restore':['workflow','attempt'],'workflow authoring select':['workflow','attempt','expected-latest-attempt'],
      'workflow answer-score restore':['workflow','answer-only'],
      'workflow publish':['workflow','task-id','org'],'workflow archive withdraw':['workflow'],'workflow library-history':['workflow'],
      'workflow deleted-sources':['project','ids'],'workflow restore-deleted':['project','deleted-after','expected-count'],
      'workflow material-docx generate':['workflow'],'workflow redacted-docx generate':['workflow'],
      'workflow material-image-docx download':['workflow','out','preparation'],
      'workflow archive-xlsx download':['workflow','out'],
      'custom-step list':['workflow'],'custom-step run':['workflow','step','file'],'custom-step wait':['workflow','step','timeout'],'custom-step cancel':['workflow','step'],'custom-step repair-evaluation':['workflow','step','file'],
      'workflow hooks show':['workflow'],'workflow delivery show':['workflow','project','ids','all','base-token','table'],
      'hook retry':['hook','acknowledge-side-effects'],'attempt resume-hooks':['attempt','acknowledge-side-effects'],
      'material text':['workflow','material','redacted-only'],'material download':['material','out'],
      'rules list':['project'],'rules file':['project','path'],
      'rules update':['project','path','file','expected-sha256'],'rules delete':['project','path','expected-sha256'],
      'models catalog':[],'models api-catalog':[],'models show':['project'],'models register':['file'],'models toggle':['model-id','enabled'],
      'attempt show':['attempt'],'attempt wait':['ids','timeout','full'],
      'attempt cancel-waiting-score':['attempt','workflow','executor'],
      'attempt cancel-stopped-executor':['attempt','workflow','executor','expected-heartbeat','executor-stopped','acknowledge-unknown-result'],
      'queue show':['history'],'queue diagnose':[],'queue cancel':['job'],'queue adopt':['file'],'queue abandon-job':['job','acknowledge-unknown-result'],'queue abandon-import':['job','acknowledge-unknown-result'],'queue reconcile-failed':['job','event','instance'],
      'system health':[],'system concurrency show':[],'system concurrency update':['file'],'system prompts show':[],'system prompts update':['file'],
      'agent config show':[],'agent config update':['file'],'agent test':[],
      'advice show':['workflow'],'advice generate':['workflow','project','ids','all'],
      'result list':['page','page-size','q','publication'],'result show':['workflow'],'step list':[],'step dispatch':['project','ids','all','provider','model','reasoning-effort','effort','web','web-thinking','web-model-label'],'web status':[],'offline export':['stage','out','count','web','project','ids'],'offline import':['out'],'offline status':['out'],'web doctor':[],'web login':['provider'],'web close':[],
      'export list':['project','page','page-size'],'export create':['project','batch'],'export download':['export','out'],
      'siriser download':['workflow','out'],'skill-dependency download':['workflow','out'],
      'feishu config show':['project'],'feishu config set':['project','base-token','table','attachment-format'],
      'feishu local-sync':['manifest','out','base-token','table'],
      'feishu table create':['project','name','base-token'],'feishu sync':['workflow','base-token','table','attachment-format','combined-material'],
      'feishu sync-batch':['project','ids','out','base-token','table','attachment-format','combined-material','concurrency'],
      'feishu draft-sync':['workflow','base-token','table','revision-attempt','replace-record-id','attachment-format','combined-material'],'feishu draft-sync-batch':['project','ids','out','base-token','table','attachment-format','combined-material','concurrency'],
      'export failed':['project','ids','all'],
      'export review':['project','ids'],
      'dispatch preview':['file','url'],'dispatch start':['file','url'],'dispatch list':[],'dispatch show':['batch','summary','state'],'dispatch limits':['batch','file'],'dispatch stop':['batch'],'dispatch events':['batch','after'],
      'artifact download':['artifact','out'],'monitor sources':[],'monitor show':['source'],
      'batch create':['project','ids','all','size','to','out'],'batch show':['file'],'batch skip':['file','ids','reason'],
    };
const COMMAND_KEYS=Object.keys(COMMAND_FLAGS).sort((a,b)=>b.split(' ').length-a.split(' ').length);

function scopedHelp(words:string[]):string{
  if(!words.length)return HELP;
  const prefix=words.join(' ');
  const matched=Object.keys(COMMAND_FLAGS).filter(k=>k===prefix||k.startsWith(prefix+' ')||prefix.startsWith(k+' '));
  const helpLines=HELP.split('\n').filter(line=>{const t=line.trim();return t.startsWith(prefix)||t.includes(`| ${prefix}`);});
  if(!matched.length&&!helpLines.length)throw new CliError(`未知命令前缀：${prefix}，请运行 --help 查看全部命令`);
  const flagSummary=matched.map(cmd=>`  ${cmd}${cmd==='step dispatch'?' <STEP_KEY>':''} : ${COMMAND_FLAGS[cmd]!.length?COMMAND_FLAGS[cmd]!.map(f=>`--${f}`).join(' '):'(无业务参数)'}`);
  return `【${prefix} 命令帮助】（公共参数：--json [--api URL]）\n${helpLines.length?helpLines.join('\n')+'\n':''}允许参数白名单：\n${flagSummary.join('\n')}\n`;
}

/** 返回统一结果信封；data 保留服务端原始结果，business 仅映射服务端达标结论。 */
export async function runCommand(args: string[], client?: ApiClient, signal?: AbortSignal): Promise<any> {
  try {
    const {words,flags}=parse(args);
    if(flags.has('help')||!args.length) return {outcome:'complete',help:scopedHelp(words)};
    const command=COMMAND_KEYS.find(key=>words.slice(0,key.split(' ').length).join(' ')===key)??'';
    const expectedWords=command==='step dispatch'?3:command.split(' ').length;
    if(!COMMAND_FLAGS[command]||words.length!==expectedWords) throw new CliError('命令无效，请查看 --help');
    for(const key of flags.keys()) if(![...COMMAND_FLAGS[command],'json','api'].includes(key)) throw new CliError(`未知参数：--${key}`);
    const required=(key:string)=>{const value=flags.get(key);if(typeof value!=='string'||!value.trim())throw new CliError(`缺少 --${key}`);return value;};
    const uuid=(key:string)=>id(required(key),key);
    const stepSlug=(key:string)=>{
      const raw=required(key).trim();
      if(!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(raw))throw new CliError(`--${key} 标识符无效`);
      return raw;
    };
    /** 读取 --web/--web-thinking/--web-model-label；任一网页参数出现但缺 --web 即拒绝。 */
    const webSettings=():WebAgentSettings|undefined=>{
      if(!flags.has('web')){if(flags.has('web-thinking')||flags.has('web-model-label'))throw new CliError('--web-thinking/--web-model-label 须与 --web 同用');return undefined;}
      const thinking=flags.has('web-thinking')?required('web-thinking'):undefined;
      if(thinking!==undefined&&!['on','off'].includes(thinking))throw new CliError('--web-thinking 只接受 on 或 off');
      try{return validateWebAgentSettings({provider:required('web'),...(thinking?{thinking:thinking==='on'}:{}),...(flags.has('web-model-label')?{model_label:required('web-model-label')}:{})});}
      catch(error){throw new CliError(error instanceof Error?error.message:'网页Agent设置无效');}
    };
    /** 读取统一 API 模型配置（用于材料库 redact 与 prepare 的 API 执行通道）。 */
    const readApiSettings=async():Promise<Record<string,unknown>|undefined>=>{
      const inlineFlags=['api-provider','api-model','api-base-url','api-thinking'].filter(k=>flags.has(k));
      if(flags.has('api-settings-file')){
        if(inlineFlags.length)throw new CliError('--api-settings-file 不能与 --api-provider/--api-model 等行内参数同时使用');
        return await readJsonObjectFile(required('api-settings-file'),'API模型配置');
      }
      if(!inlineFlags.length)return undefined;
      if(!flags.has('api-provider')||!flags.has('api-model'))throw new CliError('API模型通道须同时提供 --api-provider 与 --api-model');
      const thinking=flags.has('api-thinking')?required('api-thinking'):undefined;
      if(thinking!==undefined&&!['on','off'].includes(thinking))throw new CliError('--api-thinking 只接受 on 或 off');
      return {
        provider:required('api-provider'),
        model:required('api-model'),
        ...(flags.has('api-base-url')?{base_url:required('api-base-url')}:{}),
        ...(thinking!==undefined?{enable_thinking:thinking==='on'}:{}),
      };
    };
    if(command==='feishu local-sync'){
      const target=feishuTarget(flags.get('base-token'),flags.get('table'));
      if(!target)throw new CliError('本地交付须明确提供 --base-token 和 --table');
      return await syncLocalFeishu(required('manifest'),required('out'),target,signal);
    }
    const api=client??new ApiClient(flags.has('api')?required('api'):process.env.AI_DISTILL_API_URL);
    const get=(path:string)=>api.json(path,'GET',undefined,signal);
    const post=(path:string,body:unknown={})=>api.json(path,'POST',body,signal);
    const put=(path:string,body:unknown)=>api.json(path,'PUT',body,signal);
    const patch=(path:string,body:unknown)=>api.json(path,'PATCH',body,signal);
    const del=(path:string,body?:unknown)=>api.json(path,'DELETE',body,signal);
    const versioned=async(path:string,method:'PATCH'|'DELETE'|'POST',version:string,body?:unknown)=>api.json(path,method,body,signal,versionHeader(version));
    const ids=()=>[...new Set(required('ids').split(',').map(value=>id(value,'ids')))];
    const readJsonFile=readJsonObjectFile;
    const createLibraryRevision=async(packageId?:string)=>{
      const manifestPath=required('manifest');
      const manifest=await readJsonFile(manifestPath,'材料清单');
      if(Object.hasOwn(manifest,'recovery'))throw new CliError('临时恢复清单不能作为材料原件入库；请重新提交原始PDF、DOCX、TXT、MD、PNG或JPEG文件',{kind:'file_error'});
      if(Object.keys(manifest).some(key=>key!=='files'))throw new CliError('材料清单只能包含 files；来源转换或恢复元数据不能作为原件清单提交',{kind:'file_error'});
      if(!Array.isArray(manifest.files)||manifest.files.length<1||manifest.files.length>100)throw new CliError('材料清单须包含1至100个文件');
      const form=new FormData();form.set('request_key',uuid('request-key'));
      if(flags.has('pdf-provider')){
        const provider=required('pdf-provider');if(!['glm-ocr','mineru-api','mineru-cli'].includes(provider))throw new CliError('--pdf-provider 无效');form.set('pdf_provider',provider);
      }
      const modes:string[]=[],imageReview:boolean[]=[];
      if(flags.has('preserve-images'))form.set('preserve_images','true');
      for(const [index,item] of manifest.files.entries()){
        if(!item||typeof item!=='object'||Array.isArray(item)||typeof item.path!=='string'||!item.path.trim())throw new CliError(`材料清单第${index+1}项缺少 path`);
        if(Object.keys(item).some(key=>!['path','redaction_mode','image_review_required'].includes(key)))throw new CliError(`材料清单第${index+1}项含不支持的来源或恢复字段`,{kind:'file_error'});
        if(item.image_review_required!==undefined&&typeof item.image_review_required!=='boolean')throw new CliError(`材料清单第${index+1}项 image_review_required 须为布尔值`);
        if(item.image_review_required&&!flags.has('preserve-images'))throw new CliError('逐图判断须同时使用 --preserve-images');
        const mode=item.redaction_mode??'model';
        if(mode!=='model'&&mode!=='declared_redacted')throw new CliError(`材料清单第${index+1}项 redaction_mode 无效`);
        const filePath=resolve(dirname(resolve(manifestPath)),item.path);
        const extension=filePath.split('.').at(-1)?.toLowerCase()??'';
        if(['doc','wps','ofd'].includes(extension))throw new CliError(`材料文件需先转换：${basename(filePath)}；请先执行 library files prepare`,{kind:'file_error'});
        if(!['pdf','docx','txt','md','png','jpg','jpeg'].includes(extension))throw new CliError(`材料文件格式不支持直接入库：${basename(filePath)}`,{kind:'file_error'});
        if(mode==='declared_redacted'&&extension!=='docx')throw new CliError(`只有DOCX可声明已人工脱敏：${basename(filePath)}`,{kind:'file_error'});
        let bytes:Uint8Array;
        try{bytes=await readFile(filePath);}catch{throw new CliError(`材料文件无法读取：${basename(filePath)}`,{kind:'file_error'});}
        const uploadBytes=new Uint8Array(bytes.byteLength);uploadBytes.set(bytes);
        form.append('files',new Blob([uploadBytes.buffer]),basename(filePath));modes.push(mode);imageReview.push(item.image_review_required??false);
      }
      form.set('redaction_modes',JSON.stringify(modes));
      if(flags.has('preserve-images'))form.set('image_review_files',JSON.stringify(imageReview));
      if(!packageId){form.set('name',required('name'));return api.form('/api/material-library/imports','POST',form,signal);}
      return api.form(`/api/material-library/packages/${packageId}/revisions`,'POST',form,signal,versionHeader(required('version')));
    };
    const applySettings=async(projectId:string,settings:any)=>{
      const allowedFields=['codex','models','steps','answer_generation_policy','answer_tools'];
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
      if(Object.hasOwn(settings,'answer_tools'))operations.push({key:'answer_tools',path:`/api/projects/${projectId}/answer-tools`,method:'PUT',body:object(settings.answer_tools,'OpenRouter作答工具策略')});
      const applied:string[]=[];
      for(const operation of operations){
        try{if(operation.method==='DELETE')await del(operation.path);else await put(operation.path,operation.body);applied.push(operation.key);}
        catch(error){return{outcome:'partial',applied,failed:{key:operation.key,error:error instanceof CliError?{message:error.message,...error.detail}:{kind:'unknown_error'}},remaining:operations.slice(applied.length+1).map(item=>item.key),note:'项目配置按顺序写入；此前成功项已生效，不会自动回滚。'};}
      }
      return{outcome:'complete',applied,note:'项目配置按顺序写入；每项结果来自对应服务端接口。'};
    };
    const projectSettings=async(projectId:string)=>{
      const [detail,codex,models,answerPolicy,answerTools]=await Promise.all([
        get(`/api/projects/${projectId}?workflow_page=1&workflow_page_size=1`),get(`/api/projects/${projectId}/agent-settings`),get(`/api/projects/${projectId}/answer-models`),get(`/api/projects/${projectId}/answer-generation-policy`),get(`/api/projects/${projectId}/answer-tools`),
      ]);
      const selected=Array.isArray(models)?models:[];
      const completeModelSet=selected.length>0&&selected.every((model:any)=>typeof model.minimum_score==='number'&&Number.isFinite(model.minimum_score)&&model.minimum_score>=0&&model.minimum_score<=100);
      const codexReady=typeof codex.model==='string'&&typeof codex.reasoning_effort==='string';
      const skillReady=detail.project?.skill_exists===true;
      return{project:detail.project,codex,answer_models:selected,answer_generation_policy:answerPolicy,answer_tools:answerTools,steps:detail.steps??[],readiness:{codex_ready:codexReady,answer_model_set_ready:completeModelSet,skill_ready:skillReady,project_configuration_ready:codexReady&&completeModelSet&&skillReady},readiness_scope:'仅为配置检查；不验证 API、worker、凭证或模型服务是否可用。',notes:[...(selected.length?[]:['尚未选择作答模型；出题可继续，但完整作答与评分达标链需要配置模型及百分制上限。']),...(selected.length&&!completeModelSet?['至少一个模型缺少有效的0至100分数上限，评分后无法完成有效达标判断。']:[]),...(skillReady?[]:['项目当前目录没有可用的 SKILL.md；出题前需要准备项目 skill。'])]};
    };
    const scope=async(ordinal?:number)=>{
      const project=uuid('project');
      if(flags.has('ids')===flags.has('all'))throw new CliError('必须且只能指定 --ids 或 --all');
      if(flags.has('ids'))return {project,selected:ids()};
      const workflows=await fetchAllProjectWorkflowItems(get,project);
      const selected=workflows.filter((workflow:any)=>{
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
      case 'workflow opening revise': data=await post(`/api/workflows/${uuid('workflow')}/opening-revisions`,await readJsonFile(required('file'),'开头修订'));break;
      case 'workflow material-scope sync': data=await post(`/api/workflows/${uuid('workflow')}/material-scope`);break;
      case 'workflow authoring restore': data=await post(`/api/workflows/${uuid('workflow')}/authoring-results/${uuid('attempt')}/restore`);break;
      case 'workflow authoring select': data=await post(`/api/workflows/${uuid('workflow')}/authoring-results/${uuid('attempt')}/select`,{expected_latest_attempt_id:uuid('expected-latest-attempt')});break;
      case 'workflow answer-score restore': data=await post(`/api/workflows/${uuid('workflow')}/answer-score-results/restore`,flags.has('answer-only')?{answer_only:true}:{});break;
      case 'workflow material-docx generate': data=await post(`/api/workflows/${uuid('workflow')}/material-docx`);break;
      case 'workflow redacted-docx generate': data=await post(`/api/workflows/${uuid('workflow')}/redacted-docx`);break;
      case 'workflow material-image-docx download': data=await api.downloadTo(`/api/workflows/${uuid('workflow')}/material-image-docx${queryString([['preview_preparation_id',flags.has('preparation')?uuid('preparation'):undefined]])}`,required('out'),signal);break;
      case 'workflow archive-xlsx download': data=await api.downloadTo(`/api/workflows/${uuid('workflow')}/archive-xlsx`,required('out'),signal);break;
      case 'workflow publish': {
        if(flags.has('task-id')!==flags.has('org'))throw new CliError('--task-id 与 --org 须同时提供');
        const body=flags.has('task-id')?{delivery_identity:{task_id:required('task-id'),org:required('org')}}:undefined;
        data=await post(`/api/workflows/${uuid('workflow')}/publish`,body??{});break;
      }
      case 'workflow archive withdraw': data=await post(`/api/workflows/${uuid('workflow')}/withdraw-archive`);break;
      case 'workflow library-history': data=await get(`/api/workflows/${uuid('workflow')}/library-history`);break;
      case 'workflow deleted-sources': {
        const selectedIds=ids();
        if(selectedIds.length<1||selectedIds.length>100)throw new CliError('--ids 须指定1至100个题目UUID');
        data=await get(`/api/projects/${uuid('project')}/deleted-question-sources?ids=${selectedIds.join(',')}`);break;
      }
      case 'workflow restore-deleted': data=await post(`/api/projects/${uuid('project')}/workflows/restore-soft-deleted`,{deleted_after:required('deleted-after'),expected_count:positiveInteger(required('expected-count'),'恢复题数')});break;
      case 'custom-step list': data=await get(`/api/workflows/${uuid('workflow')}/custom-steps`);break;
      case 'custom-step run': {
        const body=flags.has('file')?await readJsonFile(required('file'),'定制步骤参数'):{};
        data=await post(`/api/workflows/${uuid('workflow')}/custom-steps/${encodeURIComponent(stepSlug('step'))}/run`,body);break;
      }
      case 'custom-step cancel': data=await post(`/api/workflows/${uuid('workflow')}/custom-steps/${encodeURIComponent(stepSlug('step'))}/cancel`);break;
      case 'custom-step repair-evaluation': data=await put(`/api/workflows/${uuid('workflow')}/custom-steps/${encodeURIComponent(stepSlug('step'))}/repair-evaluation`,await readJsonFile(required('file'),'返修评价'));break;
      case 'custom-step wait': {
        const workflowId=uuid('workflow'),targetStep=stepSlug('step'),deadline=performance.now()+duration(flags.has('timeout')?required('timeout'):'1h');
        do {
          const listing=object(await get(`/api/workflows/${workflowId}/custom-steps`),'定制步骤');
          const steps=Array.isArray(listing.steps)?listing.steps:[];
          const item=steps.find((entry:any)=>entry?.step_key===targetStep);
          if(!item)throw new CliError(`定制步骤 ${targetStep} 未在该题目所属项目注册`);
          data=item;
          const active=['waiting','running'].includes(item.status)||(typeof item.active_sub_runs==='number'&&item.active_sub_runs>0);
          if(!active)return{outcome:item.status==='succeeded'?'complete':'partial',data};
          if(performance.now()>=deadline)break;
          await abortableSleep(Math.min(1000,Math.max(0,deadline-performance.now())),signal);
          if(signal?.aborted)break;
        }while(performance.now()<deadline);
        return{outcome:'waiting',data,note:'仅结束等待，后台定制步骤任务不取消、不重派'};
      }
      case 'workflow attempts': {
        const ordinal=positiveInteger(required('ordinal'),'步骤ordinal');
        if(![1,4,5,6,7,8,9].includes(ordinal))throw new CliError('--ordinal 须为可见步骤 ordinal（1,4,5,6,7,8,9）');
        const rawOffset=flags.has('offset')?required('offset'):undefined;
        if(rawOffset!==undefined&&(!/^\d+$/.test(rawOffset)||!Number.isSafeInteger(Number(rawOffset))))throw new CliError('--offset 须为非负整数');
        data=await get(`/api/workflows/${uuid('workflow')}/steps/${ordinal}/attempts${queryString([['offset',rawOffset]])}`);break;
      }
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
        const target=feishuTarget(flags.get('base-token'),flags.get('table'));
        if(flags.has('workflow')){
          if(['project','ids','all'].some(key=>flags.has(key)))throw new CliError('--workflow 不可与项目批量范围并用');
          const workflow=uuid('workflow').toLowerCase(),detail=object(await get(`/api/workflows/${workflow}?view=status`),'交付状态');
          if(detail.workflow?.id!==workflow||!Array.isArray(detail.steps))throw new CliError('交付响应身份或步骤无效',{kind:'invalid_response'});
          const archive=detail.steps.find((step:any)=>step.ordinal===8);
          return{outcome:'complete',data:{workflow_id:workflow,archive:{status:archive?.status??null,error:archive?.error??null},feishu_sync:archive?.result?.feishu_sync??null,feishu_deliveries:archive?.result?.feishu_deliveries??null},
            note:'只读服务端当前归档状态与飞书回执；查询完成不代表交付成功。逐目标核对succeeded及verification.status=passed；缺失或旧回执保持未知，不自动同步或重试。'};
        }
        const {project,selected}=await scope(8);
        const targetKey=target?`${target.base_token}:${target.table_id}`:null;
        const items=await mapWithConcurrency(selected,4,async(rawId)=>{
          const workflow=rawId.toLowerCase(),detail=object(await get(`/api/workflows/${workflow}?view=status`),'交付状态');
          if(detail.workflow?.id!==workflow||!Array.isArray(detail.steps))throw new CliError('交付响应身份或步骤无效',{kind:'invalid_response'});
          const archive=detail.steps.find((step:any)=>step.ordinal===8);
          const archived=archive?.status==='succeeded';
          const deliveries=archive?.result?.feishu_deliveries;
          const fallbackSync=archive?.result?.feishu_sync??null;
          const receipt=targetKey
            ?(deliveries?.[targetKey]??(fallbackSync?.base_token===target!.base_token&&fallbackSync?.table_id===target!.table_id?fallbackSync:null))
            :fallbackSync;
          const deliveryState=!archived?'not_archived'
            :!receipt?'not_synced'
            :receipt.status==='succeeded'&&receipt.verification?.status==='passed'?'verified_passed'
            :receipt.status==='remote_deleted'?'remote_deleted'
            :receipt.status==='in_progress'?'in_progress'
            :receipt.verification?.status==='failed'||receipt.status==='failed'?'verification_failed'
            :'verification_incomplete';
          return {
            workflow_id:workflow,
            title:detail.workflow?.title??null,
            archive_status:archive?.status??null,
            delivery_state:deliveryState,
            record_id:receipt?.record_id??null,
            verification_status:receipt?.verification?.status??null,
          };
        },signal);
        const counts={
          total:items.length,
          archived:items.filter(x=>x.archive_status==='succeeded').length,
          not_archived:items.filter(x=>x.delivery_state==='not_archived').length,
          verified_passed:items.filter(x=>x.delivery_state==='verified_passed').length,
          verification_failed:items.filter(x=>x.delivery_state==='verification_failed').length,
          verification_incomplete:items.filter(x=>x.delivery_state==='verification_incomplete').length,
          in_progress:items.filter(x=>x.delivery_state==='in_progress').length,
          remote_deleted:items.filter(x=>x.delivery_state==='remote_deleted').length,
          not_synced:items.filter(x=>x.delivery_state==='not_synced').length,
        };
        const pendingSyncIds=items.filter(x=>x.archive_status==='succeeded'&&x.delivery_state!=='verified_passed').map(x=>x.workflow_id);
        return{outcome:'complete',data:{project_id:project,target:target??null,counts,pending_sync_workflow_ids:pendingSyncIds,items},
          note:'只读服务端当前归档状态与飞书回执汇总；pending_sync_workflow_ids 列出已归档但尚未取得目标表 passed 核验回执的题目。'};
      }
      case 'feishu config show': data=await readFeishuConfig(api,uuid('project'),signal);break;
      case 'feishu config set': {
        const project=uuid('project'),target=feishuTarget(flags.get('base-token'),flags.get('table')),attachmentFormat=feishuAttachmentFormat(flags.get('attachment-format'));
        if(!target&&!attachmentFormat)throw new CliError('至少提供 --base-token/--table 或 --attachment-format');
        await readFeishuConfig(api,project,signal,false,attachmentFormat!==undefined);
        data=await api.json(`/api/projects/${project}/feishu-delivery`,'PUT',{...(target?{default_target:target}:{}),...(attachmentFormat?{attachment_format:attachmentFormat}:{})},signal,{},FEISHU_CONFIG_TIMEOUT_MS);break;
      }
      case 'feishu table create': {
        const project=uuid('project');await readFeishuConfig(api,project,signal);
        data=await api.json(`/api/projects/${project}/feishu-tables`,'POST',{table_name:required('name'),...(flags.has('base-token')?{base_token:required('base-token')}:{})},signal,{},FEISHU_CONFIG_TIMEOUT_MS);break;
      }
      case 'feishu sync': {
        const workflow=uuid('workflow').toLowerCase(),target=feishuTarget(flags.get('base-token'),flags.get('table')),attachmentFormat=feishuAttachmentFormat(flags.get('attachment-format'));
        if(flags.has('combined-material')&&!attachmentFormat)throw new CliError('--combined-material须显式指定--attachment-format docx或pdf');
        const detail=await get(`/api/workflows/${workflow}?view=status`),project=id(detail.workflow?.project_id,'项目');
        await readFeishuConfig(api,project,signal,false,attachmentFormat!==undefined,flags.has('combined-material'));
        data=await api.json(`/api/workflows/${workflow}/feishu-sync`,'POST',{...(target?{target}:{}),...(attachmentFormat?{attachment_format:attachmentFormat}:{}),...(flags.has('combined-material')?{combined_material:true}:{})},signal,{},FEISHU_REQUEST_TIMEOUT_MS);
        return{outcome:data.status==='succeeded'&&data.verification?.status==='passed'?'complete':'partial',data};
      }
      case 'feishu sync-batch': {
        const batchConcurrency=flags.has('concurrency')?positiveInteger(required('concurrency'),'并发数'):4;
        return await syncFeishuBatch(api,uuid('project'),[...new Set(ids().map(value=>value.toLowerCase()))],required('out'),feishuTarget(flags.get('base-token'),flags.get('table')),signal,'archived',feishuAttachmentFormat(flags.get('attachment-format')),flags.has('combined-material'),batchConcurrency);
      }
      case 'feishu draft-sync': {
        const workflow=uuid('workflow').toLowerCase(),target=feishuTarget(flags.get('base-token'),flags.get('table')),attachmentFormat=feishuAttachmentFormat(flags.get('attachment-format'));
        if(flags.has('combined-material')&&!attachmentFormat)throw new CliError('--combined-material须显式指定--attachment-format docx或pdf');
        const replaceRecordId=flags.has('replace-record-id')?required('replace-record-id'):undefined;
        if(replaceRecordId!==undefined&&(flags.has('revision-attempt')||!/^rec[A-Za-z0-9]+$/.test(replaceRecordId)))throw new CliError('--replace-record-id 须为有效 rec 记录ID且不可与 --revision-attempt 并用');
        const detail=await get(`/api/workflows/${workflow}?view=status`),project=id(detail.workflow?.project_id,'项目');
        await readFeishuConfig(api,project,signal,true,attachmentFormat!==undefined,flags.has('combined-material'));
        data=await api.json(`/api/workflows/${workflow}/feishu-draft-sync`,'POST',{...(target?{target}:{}),...(flags.has('revision-attempt')?{revision_attempt_id:uuid('revision-attempt')}:{}),...(replaceRecordId?{replace_record_id:replaceRecordId}:{}),...(attachmentFormat?{attachment_format:attachmentFormat}:{}),...(flags.has('combined-material')?{combined_material:true}:{})},signal,{},FEISHU_REQUEST_TIMEOUT_MS);
        return{outcome:data.status==='succeeded'&&data.verification?.status==='passed'?'complete':'partial',data,note:'草稿仅表示出题结果已上传飞书，字段“题目是否完成”为未完成；不代表评分、达标、归档或平台验收。'};
      }
      case 'feishu draft-sync-batch': {
        const batchConcurrency=flags.has('concurrency')?positiveInteger(required('concurrency'),'并发数'):4;
        return await syncFeishuBatch(api,uuid('project'),[...new Set(ids().map(value=>value.toLowerCase()))],required('out'),feishuTarget(flags.get('base-token'),flags.get('table')),signal,'draft',feishuAttachmentFormat(flags.get('attachment-format')),flags.has('combined-material'),batchConcurrency);
      }

      case 'batch create': {
        const size=batchSize(required('size'));
        const target=getStepDefinition(required('to'));
        if(!target?.visible)throw new CliError('目标步骤须为可见步骤 key');
        const {project,selected}=await scope(target.ordinal);
        if(!selected.length)throw new CliError('批次题目范围不能为空');
        // 清单生成只读服务端，确认所有ID存在且属于指定项目；不派发业务任务。
        if(flags.has('ids')){
          const allWorkflows=await fetchAllProjectWorkflowItems(get,project);
          const known=new Map(allWorkflows.map(w=>[w.id,w]));
          for(const workflowId of selected){
            const w=known.get(workflowId);
            if(!w)throw new CliError('题目不属于指定项目或已不存在');
            if(target.ordinal===1||target.ordinal===9){if(w.workflow_kind!=='material_package'&&w.source_workflow_id)throw new CliError('派生题目不直接执行入库或脱敏');}
            else if(w.workflow_kind==='material_package')throw new CliError('材料包不能直接加入题目步骤批次');
          }
        }
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
      case 'project show': {
        const query=queryString([
          ['workflow_page',flags.has('workflow-page')?String(positiveInteger(required('workflow-page'),'工作流页码')):undefined],
          ['workflow_page_size',flags.has('workflow-page-size')?String(positiveInteger(required('workflow-page-size'),'工作流每页数量')):undefined],
        ]);
        data=await get(`/api/projects/${uuid('project')}${query}`); break;
      }
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
      case 'project material uses': {
        const query=queryString([['page',flags.has('page')?String(positiveInteger(required('page'),'页码')):undefined],['page_size',flags.has('page-size')?String(positiveInteger(required('page-size'),'每页数量')):undefined]]);
        data=await get(`/api/projects/${uuid('project')}/material-uses${query}`);break;
      }
      case 'project material use events': {
        const query=queryString([['page',flags.has('page')?String(positiveInteger(required('page'),'页码')):undefined],['page_size',flags.has('page-size')?String(positiveInteger(required('page-size'),'每页数量')):undefined]]);
        data=await get(`/api/projects/${uuid('project')}/material-uses/${uuid('use')}/events${query}`);break;
      }
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
      case 'project materials mode': data=await get(`/api/projects/${uuid('project')}/material-processing`);break;
      case 'project materials summary': {
        const projectId=uuid('project');
        let mode=flags.has('processing-mode')?required('processing-mode'):undefined;
        if(mode===undefined){
          const resolved=object(await get(`/api/projects/${projectId}/material-processing`),'材料处理模式');
          mode=typeof resolved.material_processing_mode==='string'?resolved.material_processing_mode:'aliases';
        }
        if(!['aliases','original','mask'].includes(mode))throw new CliError('--processing-mode 须为 aliases、original 或 mask');
        data=await get(`/api/projects/${projectId}/loaded-materials/summary?processing_mode=${encodeURIComponent(mode)}`);break;
      }
      case 'project materials list': {
        const query=queryString([['include_removed',flags.has('include-removed')?'true':undefined],['page',flags.has('page')?String(positiveInteger(required('page'),'页码')):undefined],['page_size',flags.has('page-size')?String(positiveInteger(required('page-size'),'每页数量')):undefined]]);
        data=await get(`/api/projects/${uuid('project')}/loaded-materials${query}`);break;
      }
      case 'project materials load': {
        if(flags.has('redaction')&&flags.has('revision'))throw new CliError('--redaction 与 --revision 不能同时使用');
        data=await loadPackageIntoProject(api,uuid('project'),uuid('package'),{
          ...(flags.has('redaction')?{redactionId:uuid('redaction')}:{}),
          ...(flags.has('revision')?{revisionId:uuid('revision')}:{}),
          ...(flags.has('reuse-workflow')?{reuseSourceWorkflowId:uuid('reuse-workflow')}:{}),
          ...(flags.has('direction')?{reuseDirection:required('direction')}:{}),
          allowShort:flags.has('allow-short'),
          signal,
        });break;
      }
      case 'project materials onboard': {
        const scopeModes=(['package','packages','count','file'] as const).filter(k=>flags.has(k));
        if(scopeModes.length!==1)throw new CliError('必须且只能指定 --package、--packages、--count 或 --file 之一');
        const scopeKey=scopeModes[0]!;
        if(scopeKey!=='package'&&['redaction','revision','request-key','title','reuse-workflow'].some(k=>flags.has(k))){
          throw new CliError('--redaction/--revision/--request-key/--title/--reuse-workflow 仅用于单包 --package 模式；批量自定义请使用 --file');
        }
        if(flags.has('q')&&scopeKey!=='count')throw new CliError('--q 仅用于 --count 自动候选筛选模式');
        if(flags.has('redaction')&&flags.has('revision'))throw new CliError('--redaction 与 --revision 不能同时使用');
        const level=flags.has('level')?required('level'):undefined;
        if(level!==undefined&&!['L2','L3','L4','L5'].includes(level))throw new CliError('目标等级须为 L2 至 L5');
        const tags=flags.has('tags')?required('tags').split(',').map(t=>t.trim()).filter(Boolean):undefined;
        const count=scopeKey==='count'?positiveInteger(required('count'),'加载建题数量'):undefined;
        if(count!==undefined&&count>500)throw new CliError('--count 单次最多 500 个包');
        const packageIds=scopeKey==='packages'?[...new Set(required('packages').split(',').map(v=>id(v.trim(),'packages')))]:undefined;
        return await onboardProjectMaterials(api,{
          projectId:uuid('project'),
          mode:scopeKey==='package'?'single':scopeKey,
          ...(scopeKey==='package'?{single:{
            package_id:uuid('package'),
            ...(flags.has('redaction')?{redaction_id:uuid('redaction')}:{}),
            ...(flags.has('revision')?{revision_id:uuid('revision')}:{}),
            ...(flags.has('request-key')?{request_key:uuid('request-key')}:{}),
            ...(flags.has('title')?{title:required('title')}:{}),
            ...(flags.has('reuse-workflow')?{reuse_source_workflow_id:uuid('reuse-workflow')}:{}),
          }}:{}),
          ...(packageIds?{packageIds}:{}),
          ...(count!==undefined?{count}:{}),
          ...(flags.has('q')?{query:required('q')}:{}),
          ...(scopeKey==='file'?{filePath:required('file')}:{}),
          ...(flags.has('out')?{outPath:required('out')}:{}),
          requirePrepared:flags.has('require-prepared'),
          loadOnly:flags.has('load-only'),
          allowShort:flags.has('allow-short'),
          ...(flags.has('scenario')?{defaultScenario:required('scenario')}:{}),
          ...(flags.has('role')?{defaultRole:required('role')}:{}),
          ...(level?{defaultLevel:level}:{}),
          ...(flags.has('direction')?{defaultDirection:required('direction')}:{}),
          ...(tags?.length?{defaultTags:tags}:{}),
        },signal);
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
      case 'library batch plan': data=await planLibraryBatch(api,flags,required('out'),signal);break;
      case 'library batch run': {data=await runLibraryBatch(api,required('file'),signal);return {outcome:data.items.some((item:any)=>item.state==='unknown'||item.state==='planned')?'partial':'complete',data};}
      case 'library package list': {
        const query=queryString([['q',flags.has('q')?required('q'):undefined],['page',flags.has('page')?String(positiveInteger(required('page'),'页码')):undefined],['page_size',flags.has('page-size')?String(positiveInteger(required('page-size'),'每页数量')):undefined],['ready_only',flags.has('ready-only')?'true':undefined],['redaction_state',flags.has('redaction-state')?required('redaction-state'):undefined],['preparation_state',flags.has('preparation-state')?required('preparation-state'):undefined],['archived_only',flags.has('archived-only')?'true':undefined],['project_id',flags.has('project')?uuid('project'):undefined]]);
        data=await get(`/api/material-library/packages${query}`);break;
      }
      case 'library package show': data=await get(`/api/material-library/packages/${uuid('package')}`);break;
      case 'library package usage': data=await get(`/api/material-library/packages/${uuid('package')}/usage`);break;
      case 'library package revisions': {
        const query=queryString([['page',flags.has('page')?String(positiveInteger(required('page'),'页码')):undefined],['page_size',flags.has('page-size')?String(positiveInteger(required('page-size'),'每页数量')):undefined]]);
        data=await get(`/api/material-library/packages/${uuid('package')}/revisions${query}`);break;
      }
      case 'library package create': data=await post('/api/material-library/packages',{name:required('name'),description:flags.has('description')?required('description'):'',tags:flags.has('tags')?required('tags').split(',').map(tag=>tag.trim()).filter(Boolean):[]});break;
      case 'library package update': {
        const body=await readJsonFile(required('file'),'材料包修改');data=await versioned(`/api/material-library/packages/${uuid('package')}`,'PATCH',required('version'),body);break;
      }
      case 'library package archive': data=await versioned(`/api/material-library/packages/${uuid('package')}`,'DELETE',required('version'));break;
      case 'library package restore': data=await versioned(`/api/material-library/packages/${uuid('package')}/restore`,'POST',required('version'));break;
      case 'library files prepare': {try{data=await prepareLibraryFiles(required('manifest'),required('out'),signal);}catch(error){throw new CliError(error instanceof Error?error.message:'材料预处理失败',{kind:'file_error'});}break;}
      case 'library import': data=await createLibraryRevision();break;
      case 'library imports list': {
        const query=queryString([['page',flags.has('page')?String(positiveInteger(required('page'),'页码')):undefined],['page_size',flags.has('page-size')?String(positiveInteger(required('page-size'),'每页数量')):undefined]]);
        data=await get(`/api/material-library/imports${query}`);break;
      }
      case 'library revision create': data=await createLibraryRevision(uuid('package'));break;
      case 'library template list': data=await get('/api/material-library/redaction-templates');break;
      case 'library template show': {const catalog=await get('/api/material-library/redaction-templates');data=catalog.items.find((t:any)=>t.id===required('template'));if(!data)throw new CliError('脱敏模板不存在');break;}
      case 'library job start': {
        const kind=required('kind'),target=required('target');
        if(!['intake','extract','redact'].includes(kind)||!['local','server'].includes(target))throw new CliError('任务 kind 或 execution target 无效');
        const hasAgentModel=flags.has('agent-model'),hasReasoningEffort=flags.has('reasoning-effort');
        if(hasAgentModel!==hasReasoningEffort)throw new CliError('--agent-model 与 --reasoning-effort 必须同时提供');
        const apiSettings=await readApiSettings();
        if((hasAgentModel||apiSettings)&&kind!=='redact')throw new CliError('Agent 或 API 模型设置仅用于 redact 任务');
        if(hasAgentModel&&apiSettings)throw new CliError('Agent 模型设置与 API 模型设置不能同时提供');
        if(webSettings())throw new CliError('library job start 不支持网页Agent；网页Agent仅用于 library prepare start 与 step dispatch author_question');
        if(flags.has('pdf-provider')&&kind!=='extract')throw new CliError('--pdf-provider 仅用于extract任务');
        const provider=flags.has('pdf-provider')?required('pdf-provider'):undefined;
        if(provider&&!['glm-ocr','mineru-api','mineru-cli'].includes(provider))throw new CliError('--pdf-provider 无效');
        const body={kind,request_key:uuid('request-key'),execution_target:target,...(provider?{pdf_provider:provider}:{}),...(flags.has('project')?{project_id:uuid('project')}:{}),...(flags.has('template')?{template_id:required('template')}:{}),...(flags.has('extraction-job')?{extraction_job_id:uuid('extraction-job')}:{}) ,...(flags.has('previous-job')?{previous_job_id:uuid('previous-job')}:{}) ,...(hasAgentModel?{agent_settings:{model:required('agent-model'),reasoning_effort:required('reasoning-effort')}}:{}),...(apiSettings?{api_settings:apiSettings}:{})};
        data=await post(`/api/material-library/revisions/${uuid('revision')}/jobs`,body);break;
      }
      case 'library prepare start': {
        if(flags.has('redaction')===flags.has('extraction-job'))throw new CliError('须且只能提供 --redaction 或 --extraction-job');
        if(flags.has('agent-model')!==flags.has('reasoning-effort'))throw new CliError('Agent模型和强度须同时提供');
        const web=webSettings();
        const apiSettings=await readApiSettings();
        if([flags.has('agent-model'),Boolean(web),Boolean(apiSettings)].filter(Boolean).length>1)throw new CliError('Agent、API 与网页Agent设置不能同时提供');
        data=await post(`/api/material-library/revisions/${uuid('revision')}/prepare`,{request_key:uuid('request-key'),...(flags.has('force')?{force:true}:{}),...(flags.has('execution-timeout')?{execution_timeout_ms:duration(required('execution-timeout'),86400000)}:{}),...(flags.has('redaction')?{redaction_id:uuid('redaction')}:{extraction_job_id:uuid('extraction-job')}),...(flags.has('project')?{project_id:uuid('project')}:{}),...(flags.has('agent-model')?{agent_settings:{model:required('agent-model'),reasoning_effort:required('reasoning-effort')}}:{}),...(apiSettings?{api_settings:apiSettings}:{}),...(web?{web_settings:web}:{})});break;
      }
      case 'library prepare resume': data=await post(`/api/material-library/jobs/${uuid('job')}/prepare-resume`,{request_key:uuid('request-key'),...(flags.has('execution-timeout')?{execution_timeout_ms:duration(required('execution-timeout'),86400000)}:{})});break;
      case 'library prepare diagnose': {
        const job=await get(`/api/material-library/jobs/${uuid('job')}`);
        if(job.kind!=='prepare')throw new CliError('指定任务不是材料整理任务');
        data={job_id:job.id,status:job.status,started_at:job.started_at,finished_at:job.finished_at,progress:job.progress??{},error_code:job.error_code??null,stop_reason:job.result_summary?.execution_stop?.reason_code??job.error_code??null};
        if(job.status==='succeeded'){
          const prepared=await get(`/api/material-library/preparations/${job.result_summary?.preparation_id??job.id}`),r=prepared.result??{},documents=Array.isArray(r.documents)?r.documents:[];
          data={...data,document_count:r.document_count??null,entry_count:documents.length,unassigned_group_count:r.unassigned_group_count??null,unassigned_block_count:r.unassigned_block_count??null,summary_count:documents.filter((d:any)=>typeof d.summary==='string'&&d.summary.trim()).length,visible_count:documents.filter((d:any)=>d.visibility!=='hidden').length,hidden_count:documents.filter((d:any)=>d.visibility==='hidden').length,combination_count:Array.isArray(r.combinations)?r.combinations.length:0,warning_count:Array.isArray(r.warnings)?r.warnings.length:0};
        }
        break;
      }
      case 'library prepare list': {
        const query=new URLSearchParams();
        for(const key of ['revision','redaction','project'])if(flags.has(key))query.set(`${key}_id`,uuid(key));
        if(flags.has('page'))query.set('page',String(positiveInteger(required('page'),'页码')));
        if(flags.has('page-size'))query.set('page_size',String(positiveInteger(required('page-size'),'每页数量')));
        if(flags.has('summary-only'))query.set('summary_only','true');
        data=await get(`/api/material-library/packages/${uuid('package')}/preparations${query.size?'?'+query.toString():''}`);break;
      }
      case 'library prepare show': data=await get(`/api/material-library/preparations/${uuid('preparation')}${flags.has('content')?'?include_content=true':''}`);break;
      case 'library job wait': {
        const jobId=uuid('job'),deadline=performance.now()+duration(flags.has('timeout')?required('timeout'):'1h');
        do {
          data=await get(`/api/material-library/jobs/${jobId}`);
          if(!['queued','running'].includes(data.status))return{outcome:data.status==='succeeded'?'complete':'partial',data};
          if(performance.now()>=deadline)break;
          await abortableSleep(Math.min(1000,Math.max(0,deadline-performance.now())),signal);
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
      case 'library redaction show': data=await get(`/api/material-library/redactions/${uuid('redaction')}/preview${queryString([['file_id',flags.has('file')?uuid('file'):undefined],['metadata_only',flags.has('metadata-only')?'true':undefined]])}`);break;
      case 'library file download': {
        const out=required('out');
        data={...await api.downloadTo(`/api/material-library/files/${uuid('file')}/content`,out,signal),source:'library_original'};break;
      }
      case 'library processing show': data=await get('/api/material-library/processing-settings');break;
      case 'library processing update': {
        const body=await readJsonFile(required('file'),'材料处理设置');data=await api.json('/api/material-library/processing-settings','PUT',body,signal,versionHeader(required('version')));break;
      }
      case 'material-package list': {const page=flags.get('page')??'1',size=flags.get('page-size')??'100';if(typeof page!=='string'||typeof size!=='string'||!/^\d+$/.test(page)||!/^\d+$/.test(size)||Number(page)<1||Number(size)<1||Number(size)>500)throw new CliError('材料包分页参数无效');data=await get(`/api/projects/${uuid('project')}/material-packages?page=${page}&page_size=${size}`);break;}
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
      case 'project prompt update': {
        const ordinal=positiveInteger(required('ordinal'),'步骤ordinal');
        if(![4,5,6].includes(ordinal))throw new CliError('--ordinal 仅支持共享步骤提示词 4、5 或 6');
        let prompt:string;
        try{prompt=await readFile(required('file'),'utf8');}catch{throw new CliError('提示词文件无法读取',{kind:'file_error'});}
        if(!prompt.trim()||prompt.length>12000)throw new CliError('步骤提示词须为1至12000字符的非空文本');
        let expectedPrompt:string|undefined;
        if(flags.has('expected-prompt-file')){
          try{expectedPrompt=await readFile(required('expected-prompt-file'),'utf8');}catch{throw new CliError('预期旧提示词文件无法读取',{kind:'file_error'});}
        }
        data=await put(`/api/projects/${uuid('project')}/steps/${ordinal}/prompt`,{prompt,...(expectedPrompt!==undefined?{expected_prompt:expectedPrompt}:{})});break;
      }
      case 'question list': {
        const limit=flags.get('limit');
        if(limit!==undefined&&(typeof limit!=='string'||!/^\d+$/.test(limit)||Number(limit)<1||Number(limit)>1000))throw new CliError('--limit须为1至1000的整数');
        const page=flags.get('page')??'1';
        if(typeof page!=='string'||!/^\d+$/.test(page)||Number(page)<1||!Number.isSafeInteger(Number(page)))throw new CliError('--page须为正整数');
        const result=object(await get(`/api/projects/${uuid('project')}/questions?page=${page}&limit=${limit??100}`),'题目分页');
        if(!Array.isArray(result.workflows))throw new CliError('题目分页响应无效',{kind:'invalid_response'});
        data={items:result.workflows,page:result.page,has_more:result.has_more};break;
      }
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
          const chunks:string[][]=[];
          for(let i=0;i<selected.length;i+=100)chunks.push(selected.slice(i,i+100));
          const chunkReplies=await mapWithConcurrency(chunks,3,chunk=>get(`/api/projects/${project}/workflow-status?ids=${chunk.join(',')}`),signal);
          for(const reply of chunkReplies)Object.assign(data,reply);
          const missing=selected.filter(key=>!data[key]);
          return {outcome:missing.length?'partial':'complete',data,missing_workflow_ids:missing};
        }
        if(command==='question show'&&flags.has('status')&&flags.get('status')!==true)throw new CliError('--status 不接受参数值');
        data=await get(`/api/workflows/${uuid('workflow')}${command==='question show'&&flags.has('status')?'?view=status':''}`);
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
        const projectId=uuid('project'),current=object(await get(`/api/projects/${projectId}?workflow_page=1&workflow_page_size=1`),'项目').project;
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
      case 'material download': data=await api.downloadTo(`/api/materials/${uuid('material')}/download`,required('out'),signal);break;
      case 'rules list': data=await get(`/api/projects/${uuid('project')}/rules`);break;
      case 'rules file': data=await get(`/api/projects/${uuid('project')}/rules/file?path=${encodeURIComponent(required('path'))}`);break;
      case 'rules update': {
        const filePath=required('file');let textContent:string;
        try{textContent=await readFile(filePath,'utf8');}catch{throw new CliError('规则文件无法读取',{kind:'file_error'});}
        const rawExpected=flags.has('expected-sha256')?required('expected-sha256'):null;
        const expectedSha256=rawExpected===null||rawExpected==='null'?null:rawExpected;
        if(expectedSha256!==null&&!/^[0-9a-f]{64}$/i.test(expectedSha256))throw new CliError('--expected-sha256 须为64位SHA256或null');
        data=await put(`/api/projects/${uuid('project')}/rules/file`,{path:required('path'),text:textContent,expected_sha256:expectedSha256});break;
      }
      case 'rules delete': {
        const expectedSha256=required('expected-sha256');
        if(!/^[0-9a-f]{64}$/i.test(expectedSha256))throw new CliError('--expected-sha256 须为64位SHA256');
        data=await del(`/api/projects/${uuid('project')}/rules/file`,{path:required('path'),expected_sha256:expectedSha256});break;
      }
      case 'project skill list': data=await get(`/api/projects/${uuid('project')}/skill/attempts`);break;
      case 'project skill generate': data=await post(`/api/projects/${uuid('project')}/skill/generate`,await readJsonFile(required('file'),'Skill生成设置'));break;
      case 'project skill adopt': data=await post(`/api/projects/${uuid('project')}/skill/attempts/${uuid('attempt')}/adopt`);break;
      case 'models catalog': data=await get('/api/answer-models');break;
      case 'models api-catalog': data=await get('/api/llm-api/models');break;
      case 'models show': data=await get(`/api/projects/${uuid('project')}/answer-models`);break;
      case 'models register': data=await post('/api/answer-models',await readJsonFile(required('file'),'模型注册'));break;
      case 'models toggle': {
        const rawEnabled=required('enabled');
        if(!['true','false'].includes(rawEnabled))throw new CliError('--enabled 只接受 true 或 false');
        data=await put(`/api/answer-models/${uuid('model-id')}`,{enabled:rawEnabled==='true'});break;
      }
      case 'attempt show': data=await get(`/api/attempts/${uuid('attempt')}`);break;
      case 'attempt wait': return await waitAttempts(api,ids(),duration(flags.has('timeout')?required('timeout'):'1h'),signal,flags.has('full'));
      case 'attempt cancel-waiting-score': data=await post(`/api/attempts/${uuid('attempt')}/cancel-waiting-score`,{workflow_id:uuid('workflow'),executor_id:uuid('executor')});break;
      case 'attempt cancel-stopped-executor': {
        if(!flags.has('executor-stopped')||!flags.has('acknowledge-unknown-result'))throw new CliError('取消停机尝试须同时确认 --executor-stopped 与 --acknowledge-unknown-result');
        const rawHeartbeat=required('expected-heartbeat');
        const expectedHeartbeat=rawHeartbeat==='null'?null:rawHeartbeat;
        if(expectedHeartbeat!==null&&!Number.isFinite(Date.parse(expectedHeartbeat)))throw new CliError('--expected-heartbeat 须为 ISO 时间或 null');
        data=await post(`/api/attempts/${uuid('attempt')}/cancel-stopped-executor`,{workflow_id:uuid('workflow'),executor_id:uuid('executor'),expected_heartbeat_at:expectedHeartbeat,executor_stopped:true,acknowledge_unknown_result:true});break;
      }
      case 'result list': {
        const page=flags.get('page')??'1',size=flags.get('page-size')??'100';
        if(typeof page!=='string'||typeof size!=='string'||!/^\d+$/.test(page)||!/^\d+$/.test(size)||Number(page)<1||Number(size)<1||Number(size)>500)throw new CliError('成果分页参数无效');
        const publication=flags.has('publication')?required('publication'):undefined;
        if(publication!==undefined&&!['all','archived','pending'].includes(publication))throw new CliError('--publication 须为 all、archived 或 pending');
        const query=queryString([['page',page],['page_size',size],['q',flags.has('q')?required('q'):undefined],['publication',publication]]);
        data=await get(`/api/results${query}`);break;
      }
      case 'queue show': data=await get(`/api/system/execution-queue${flags.has('history')?'?include_history=true':''}`);break;
      case 'queue diagnose': {const [queue,monitor]=await Promise.all([get('/api/system/execution-queue'),get('/api/monitor')]);data=diagnoseQueue(queue,monitor);break;}
      case 'queue cancel': data=await post(`/api/system/execution-queue/${uuid('job')}/cancel`);break;
      case 'queue adopt': data=await post('/api/system/execution-queue/adopt',await readJsonFile(required('file'),'队列认领清单'));break;
      case 'queue abandon-job': case 'queue abandon-import': {
        if(!flags.has('acknowledge-unknown-result'))throw new CliError('放弃未核实材料任务须显式携带 --acknowledge-unknown-result');
        const route=command==='queue abandon-import'?'abandon-library-import':'abandon-library-job';
        data=await post(`/api/system/execution-queue/${uuid('job')}/${route}`,{acknowledge_unknown_result:true});break;
      }
      case 'queue reconcile-failed': data=await post(`/api/system/execution-queue/${uuid('job')}/reconcile-failed`,{failure_event_id:uuid('event'),failure_instance_id:uuid('instance')});break;
      case 'system health': data=await get('/api/health');break;
      case 'system concurrency show': data=await get('/api/system/concurrency-settings');break;
      case 'system concurrency update': data=await put('/api/system/concurrency-settings',await readJsonFile(required('file'),'并发设置'));break;
      case 'system prompts show': data=await get('/api/system/step-prompts');break;
      case 'system prompts update': data=await put('/api/system/step-prompts',await readJsonFile(required('file'),'系统提示词'));break;
      case 'agent config show': data=await get('/api/agent/config');break;
      case 'agent config update': data=await put('/api/agent/config',await readJsonFile(required('file'),'Agent配置'));break;
      case 'agent test': data=await post('/api/agent/test');break;
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
      case 'dispatch preview':
      case 'dispatch start': {
        if(flags.has('file')===flags.has('url'))throw new CliError('须且只能指定 --file 或 --url');
        let manifest:unknown;
        if(flags.has('file'))manifest=await readJsonFile(required('file'),'批次清单');
        else {
          const url=new URL(required('url'));if(!['http:','https:'].includes(url.protocol))throw new CliError('清单 URL 只支持 HTTP(S)');
          const response=await fetch(url,{signal:signal?AbortSignal.any([signal,AbortSignal.timeout(30000)]):AbortSignal.timeout(30000)});
          if(!response.ok)throw new CliError('读取线上清单失败 HTTP '+response.status);manifest=await response.json();
        }
        data=await post('/api/dispatch-batches'+(command==='dispatch preview'?'/preview':''),manifest);break;
      }
      case 'dispatch list': data=await get('/api/dispatch-batches');break;
      case 'dispatch show': data=await get('/api/dispatch-batches/'+uuid('batch')+(flags.has('summary')?'?summary=1':flags.has('state')?'?state='+encodeURIComponent(required('state')):''));break;
      case 'dispatch limits': data=await put('/api/dispatch-batches/'+uuid('batch')+'/limits',await readJsonFile(required('file'),'批次容量'));break;
      case 'dispatch events': data=await get('/api/dispatch-batches/'+uuid('batch')+'/events?after='+encodeURIComponent(String(flags.get('after')??0)));break;
      case 'dispatch stop': data=await post('/api/dispatch-batches/'+uuid('batch')+'/stop');break;
      case 'monitor sources': data=await get('/api/monitor-sources');break;
      case 'monitor show': data=await get(`/api/monitor${queryString([['source',flags.has('source')?required('source'):undefined]])}`);break;
      case 'web status': {
        const queue=object(await get('/api/system/execution-queue'),'本机队列');
        const items=Array.isArray(queue.items)?queue.items.filter((item:any)=>item.lane==='web'):[];
        const {webBrowserStatus}=await import('../server/web-agent');
        data={capacity:queue.capacity?.web??null,items,browser:await webBrowserStatus(),providers:WEB_AGENT_PROVIDERS};break;
      }
      case 'offline export': {
        const stage=required('stage');
        if(!(OFFLINE_STAGES as readonly string[]).includes(stage))throw new CliError('--stage 只接受 redact、prepare 或 author');
        const provider=flags.has('web')?required('web'):undefined;
        if(provider!==undefined&&!(WEB_AGENT_PROVIDERS as readonly string[]).includes(provider))throw new CliError('--web 仅支持 deepseek 或 gemini');
        let count:number|undefined;
        if(flags.has('count')){count=Number(required('count'));if(!Number.isSafeInteger(count)||count<1||count>500)throw new CliError('--count 须为1至500的整数');}
        data=await offlineExport({get,post},{stage:stage as OfflineStage,out:required('out'),...(count!==undefined?{count}:{}),...(provider?{provider:provider as WebAgentSettings['provider']}:{}),...(flags.has('project')?{project:uuid('project')}:{}),...(flags.has('ids')?{ids:ids()}:{})});break;
      }
      case 'offline import': data=await offlineImport({get,post},{out:required('out')});break;
      case 'offline status': data=await offlineStatus({out:required('out')});break;
      case 'web doctor': {const {webDoctor}=await import('../server/web-agent');data=await webDoctor();break;}
      case 'web login': {
        const provider=required('provider');
        if(!(WEB_AGENT_PROVIDERS as readonly string[]).includes(provider))throw new CliError('--provider 仅支持 deepseek 或 gemini');
        const {webLogin}=await import('../server/web-agent');await webLogin(provider as WebAgentSettings['provider']);data={provider,message:'登录窗口已关闭；运行 web doctor 核对登录状态'};break;
      }
      case 'web close': {const {webCloseBrowser}=await import('../server/web-agent');await webCloseBrowser();data={closed:true};break;}
      case 'step dispatch': {
        const step=getStepDefinition(words[2]);
        if(!step?.visible)throw new CliError('步骤 key 无效或属于隐藏步骤，请查看 step list');
        const web=webSettings();
        if(web&&step.ordinal!==4)throw new CliError('--web 仅用于 author_question');
        const providerFlag=flags.get('provider');
        const modelFlag=flags.get('model');
        const effortFlag=flags.get('reasoning-effort')??flags.get('effort');
        if((providerFlag||modelFlag||effortFlag)&&step.ordinal!==4)throw new CliError('--provider / --model / --reasoning-effort 仅用于 author_question');
        const authoringSettings=(providerFlag||modelFlag||effortFlag)?{
          ...(providerFlag?{provider:providerFlag}:{}),
          ...(modelFlag?{model:modelFlag}:{}),
          ...(effortFlag?{reasoning_effort:effortFlag}:{}),
        }:undefined;
        const {project,selected}=await scope(step.ordinal);
        const batches: any[]=[];const results:any[]=[];let failed=false;
        // 不重试 POST。后续分组发生网络错误时保留已经取得的任务 ID，并停止继续派发。
        for(let i=0;i<selected.length;i+=100) {
          const workflowIds=selected.slice(i,i+100);
          try {
            const response=object(await post(`/api/projects/${project}/steps/${step.ordinal}/run-batch`,{workflow_ids:workflowIds,...(web?{web_settings:web}:{}),...(authoringSettings?{authoring_settings:authoringSettings}:{})}),'派发');
            const rows=dispatchResults(response.results,workflowIds);
            batches.push({workflow_ids:workflowIds,data:response});results.push(...rows);
          } catch(error) {
            failed=true;batches.push({workflow_ids:workflowIds,error:error instanceof CliError?{message:error.message,...error.detail}:{kind:'unknown_error'},unsubmitted_workflow_ids:selected.slice(i+100)});break;
          }
        }
        return {outcome:failed||results.some(r=>!['queued','succeeded','already_accepted','already_archived'].includes(r.status))?'partial':'complete',
          step_key:step.key,project_id:project,selected_workflow_ids:selected,batches,dispatch:results,
          attempt_ids:[...new Set<string>(results.flatMap(r=>[r.attempt_id,...(r.attempt_ids??[])].filter(Boolean)))]};
      }
      case 'export list': {const page=flags.get('page')??'1',size=flags.get('page-size')??'100';if(typeof page!=='string'||typeof size!=='string'||!/^\d+$/.test(page)||!/^\d+$/.test(size)||Number(page)<1||Number(size)<1||Number(size)>500)throw new CliError('导出分页参数无效');data=await get(`/api/projects/${uuid('project')}/exports?page=${page}&page_size=${size}`);break;}
      case 'export failed': {
        if(flags.has('all')===flags.has('ids'))throw new CliError('须且只能提供 --ids 或 --all');
        return await exportFailedQuestions(api,uuid('project'),flags.has('ids')?ids():undefined,signal);
      }
      case 'export review': return await exportFailedQuestions(api,uuid('project'),ids(),signal,'review');
      case 'export create': data=await post(`/api/projects/${uuid('project')}/export`,{batch:flags.get('batch')??null});break;
      case 'artifact download': case 'export download': {
        const out=required('out');
        const path=command==='artifact download'?`/api/artifacts/${uuid('artifact')}/download`:`/api/exports/${uuid('export')}/download`;
        data=await api.downloadTo(path,out,signal);break;
      }
      case 'siriser download': {
        const out=required('out');
        data={...await api.downloadTo(`/api/workflows/${uuid('workflow')}/siriser-zip`,out,signal),package:'siriser_five_piece',submission_performed:false};break;
      }
      case 'skill-dependency download': {
        const out=required('out');
        data={...await api.downloadTo(`/api/workflows/${uuid('workflow')}/skill-dependency-package`,out,signal),package:'skill_dependency',submission_performed:false};break;
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
    await abortableSleep(Math.min(250,Math.max(0,deadline-performance.now())),signal);
  }while(performance.now()<deadline);
  const attempts=ids.map(attempt=>({id:attempt,...(snapshots.get(attempt)??{}),...(errors.has(attempt)?{read_error:errors.get(attempt)}:{})}));
  const stillRunning=attempts.some(a=>!a.status||['waiting','running'].includes(a.status));
  return {outcome:errors.size||attempts.some(a=>a.status==='failed')?'partial':stillRunning?'waiting':'complete',attempts,
    completion_scope:'attempt',note:'终态仅代表attempt执行结束；达标结论须重新读取 result show。归档成功不代表飞书交付完成，须另查 workflow delivery show 的回执。等待到期不会取消或重新派发任务。'};
}
