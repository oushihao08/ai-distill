/** CLI 命令层。runCommand 将明确范围映射到现有 HTTP 契约，等待 attempt；不实现就绪、评分或队列规则。 */
import {writeFile} from 'node:fs/promises';
import {getStepDefinition, STEP_REGISTRY} from '../shared/step-registry';
import {ApiClient, CliError} from './client';

export const HELP = `ai-distill：本机工作流工具（所有命令支持 --json、--api http://127.0.0.1:3100）
只读：
  project list | project show --project UUID
  question list --project UUID | question show --workflow UUID
  workflow status --project UUID (--ids UUID,... | --all)
  material text --workflow UUID --material UUID --redacted-only
  rules list --project UUID | rules file --project UUID --path skill/SKILL.md
  models show --project UUID
  attempt show --attempt UUID | attempt wait --ids UUID,... [--timeout 1h]
  result list | result show --workflow UUID
  revision list --workflow UUID | export list --project UUID
  monitor show | step list
显式写入：
  project create --name 名称 --material-root 绝对路径 [--skill-path 绝对路径] [--description 说明]
  project sync --project UUID（刷新来源清单，可能使旧结果失效）
  step dispatch STEP_KEY --project UUID (--ids UUID,... | --all)
  revision start --workflow UUID --source-attempt UUID | revision resume --workflow UUID --chain UUID
  export create --project UUID [--batch 批次]
下载（仅写指定的新本机文件，不覆盖）：
  artifact download --artifact UUID --out 路径 | export download --export UUID --out 路径
STEP_KEY 使用 step list；不使用页面序号。派发只执行一个步骤，不自动继续。
退出码：0 完成/派发已接受（不等于业务达标），1 命令/HTTP 错误，2 部分失败/未就绪，3 等待到期仍运行，130 中断。
`;

function parse(args: string[]) {
  const words: string[]=[]; const flags=new Map<string,string|true>();
  for(let i=0;i<args.length;i++) {
    const value=args[i];
    if (!value.startsWith('--')) { words.push(value); continue; }
    const key=value.slice(2);
    if (flags.has(key)) throw new CliError(`参数重复：--${key}`);
    if (['all','redacted-only','json','help'].includes(key)) flags.set(key,true);
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

/** 返回命令信封；data 保留服务端结果，business 仅展示服务端达标结论，不自行算分。 */
export async function runCommand(args: string[], client?: ApiClient, signal?: AbortSignal): Promise<any> {
  try {
    const {words,flags}=parse(args);
    const command=words.slice(0,2).join(' ');
    if(flags.has('help')||!args.length) return {outcome:'complete',help:HELP};
    const allowed: Record<string,string[]>= {
      'project list':[], 'project show':['project'], 'project create':['name','description','material-root','skill-path'], 'project sync':['project'],
      'question list':['project'],'question show':['workflow'],'workflow status':['project','ids','all'],
      'material text':['workflow','material','redacted-only'],'rules list':['project'],'rules file':['project','path'],
      'models show':['project'],'attempt show':['attempt'],'attempt wait':['ids','timeout'],
      'result list':[],'result show':['workflow'],'step list':[],'step dispatch':['project','ids','all'],
      'revision list':['workflow'],'revision start':['workflow','source-attempt'],'revision resume':['workflow','chain'],
      'export list':['project'],'export create':['project','batch'],'export download':['export','out'],
      'artifact download':['artifact','out'],'monitor show':[],
    };
    if(!allowed[command]||words.length!==(command==='step dispatch'?3:2)) throw new CliError('命令无效，请查看 --help');
    for(const key of flags.keys()) if(![...allowed[command],'json','api'].includes(key)) throw new CliError(`未知参数：--${key}`);
    const required=(key:string)=>{const value=flags.get(key);if(typeof value!=='string'||!value.trim())throw new CliError(`缺少 --${key}`);return value;};
    const uuid=(key:string)=>id(required(key),key);
    const api=client??new ApiClient(flags.has('api')?required('api'):process.env.AI_DISTILL_API_URL);
    const get=(path:string)=>api.json(path,'GET',undefined,signal);
    const post=(path:string,body:unknown={})=>api.json(path,'POST',body,signal);
    const ids=()=>[...new Set(required('ids').split(',').map(value=>id(value,'ids')))];
    const scope=async()=>{
      const project=uuid('project');
      if(flags.has('ids')===flags.has('all'))throw new CliError('必须且只能指定 --ids 或 --all');
      if(flags.has('ids'))return {project,selected:ids()};
      const data=object(await get(`/api/projects/${project}`),'项目');
      if(!Array.isArray(data.workflows))throw new CliError('项目缺少题目清单',{kind:'invalid_response'});
      return {project,selected:[...new Set<string>(data.workflows.map((w:any)=>id(w.id,'workflow')))]};
    };
    let data: any;
    switch(command) {
      case 'step list': data=STEP_REGISTRY.filter(s=>s.visible); break;
      case 'project list': data=await get('/api/projects'); break;
      case 'project show': data=await get(`/api/projects/${uuid('project')}`); break;
      case 'question list': data=object(await get(`/api/projects/${uuid('project')}`),'项目').workflows; break;
      case 'question show': case 'result show': case 'workflow status': {
        if(command==='workflow status') {
          const {project,selected}=await scope();data={};
          for(let i=0;i<selected.length;i+=100) Object.assign(data,await get(`/api/projects/${project}/workflow-status?ids=${selected.slice(i,i+100).join(',')}`));
          const missing=selected.filter(key=>!data[key]);
          return {outcome:missing.length?'partial':'complete',data,missing_workflow_ids:missing};
        }
        data=await get(`/api/workflows/${uuid('workflow')}`);
        const decision=data.steps?.find((step:any)=>step.ordinal===7);
        return {outcome:'complete',data,business:{execution_status:decision?.status??null,...(decision?.result??{})}};
      }
      case 'project create': {
        const root=required('material-root');const skill=flags.has('skill-path')?required('skill-path'):undefined;
        if(!root.startsWith('/')||(skill&&!skill.startsWith('/')))throw new CliError('目录须为本机绝对路径');
        data=await post('/api/projects',{name:required('name'),description:flags.get('description')??'',material_root:root,...(skill?{local_skill_path:skill}:{})});break;
      }
      case 'project sync': data=await post(`/api/projects/${uuid('project')}/sync-folder`); break;
      case 'material text':
        if(!flags.has('redacted-only'))throw new CliError('读取材料须显式指定 --redacted-only');
        data=await get(`/api/workflows/${uuid('workflow')}/materials/${uuid('material')}/extracted-text?redacted_only=true`);break;
      case 'rules list': data=await get(`/api/projects/${uuid('project')}/rules`);break;
      case 'rules file': data=await get(`/api/projects/${uuid('project')}/rules/file?path=${encodeURIComponent(required('path'))}`);break;
      case 'models show': data=await get(`/api/projects/${uuid('project')}/answer-models`);break;
      case 'attempt show': data=await get(`/api/attempts/${uuid('attempt')}`);break;
      case 'attempt wait': return await waitAttempts(api,ids(),duration(flags.has('timeout')?required('timeout'):'1h'),signal);
      case 'result list': data=await get('/api/results');break;
      case 'monitor show': data=await get('/api/monitor');break;
      case 'step dispatch': {
        const step=getStepDefinition(words[2]);
        if(!step?.visible)throw new CliError('步骤 key 无效或属于隐藏步骤，请查看 step list');
        const {project,selected}=await scope();
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
      case 'revision list': data=await get(`/api/workflows/${uuid('workflow')}/revisions`);break;
      case 'revision start': data=await post(`/api/workflows/${uuid('workflow')}/revisions`,{source_attempt_id:uuid('source-attempt')});break;
      case 'revision resume': data=await post(`/api/workflows/${uuid('workflow')}/revisions/${uuid('chain')}/resume`);break;
      case 'export list': data=await get(`/api/projects/${uuid('project')}/exports`);break;
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

async function waitAttempts(api: ApiClient, ids: string[], timeout: number, signal?: AbortSignal) {
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
            const data=object(await api.json(`/api/attempts/${attempt}?wait_ms=${waitMs}`,'GET',undefined,readSignal),'任务');
            if(data.id!==attempt||!['waiting','running','succeeded','failed','skipped'].includes(data.status))throw new CliError('任务响应身份或状态无效',{kind:'invalid_response'});
            snapshots.set(attempt,data);
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
