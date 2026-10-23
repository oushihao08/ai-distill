/** CLI 命令契约测试：题目1为合成夹具，验证范围、稳定步骤身份、多模型派发、轻量／完整等待和只读结果边界。 */
import {describe, expect, test} from 'bun:test';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ApiClient} from './client';
import {runCommand} from './commands';

const project = '00000000-0000-4000-8000-000000000001';
const question = '00000000-0000-4000-8000-000000000002';
const attempt = '00000000-0000-4000-8000-000000000003';
const second = '00000000-0000-4000-8000-000000000004';
function fixture(reply: (url: URL, init?: RequestInit) => unknown) {
  const calls: {url:URL;init?:RequestInit}[] = [];
  const client = new ApiClient(undefined, async (input, init) => {
    const url = new URL(String(input)); calls.push({url,init});
    return Response.json(reply(url,init));
  });
  return {client,calls};
}

describe('命令范围和结果', () => {
  test('材料包版本和建题走独立 API，并且普通题目清单排除材料包',async()=>{
    const {client,calls}=fixture((url,init)=>{
      if(url.pathname===`/api/projects/${project}`)return{workflows:[{id:question,workflow_kind:'material_package'},{id:second,workflow_kind:'question',source_workflow_id:question}]};
      if(url.pathname.endsWith('/versions'))return[{id:attempt}];
      if(init?.method==='POST')return{id:second};
      return{};
    });
    expect((await runCommand(['material-package','list','--project',project],client)).data).toHaveLength(1);
    expect((await runCommand(['question','list','--project',project],client)).data).toEqual([{id:second,workflow_kind:'question',source_workflow_id:question}]);
    expect((await runCommand(['material-package','versions','--workflow',question],client)).data).toEqual([{id:attempt}]);
    await runCommand(['question','create','--material-package',question,'--title','题目二','--redaction-attempt',attempt,'--level','L4','--scenario','LS04'],client);
    const created=calls.at(-1)!;
    expect(created.url.pathname).toBe(`/api/material-packages/${question}/questions`);
    expect(JSON.parse(String(created.init?.body))).toMatchObject({title:'题目二',redaction_attempt_id:attempt,target_level:'L4',scenario:'LS04'});
  });
  test('等待默认请求轻量视图，即使旧服务返回正文也只保留状态元信息',async()=>{
    const {client,calls}=fixture(()=>({id:attempt,workflow_id:question,ordinal:5,status:'failed',completed:true,error:'可检查后重试',result:{text:'大段答案'},input:{secret:'不应输出'}}));
    const result=await runCommand(['attempt','wait','--ids',attempt],client);
    expect(calls[0].url.searchParams.get('view')).toBe('status');
    expect(result.attempts[0]).toMatchObject({id:attempt,workflow_id:question,ordinal:5,status:'failed',error:'可检查后重试',completed:true});
    expect(result.attempts[0]).not.toHaveProperty('result');expect(result.attempts[0]).not.toHaveProperty('input');
    expect(result.outcome).toBe('partial');
  });
  test('显式full等待与attempt show保留完整结果读取能力',async()=>{
    const {client,calls}=fixture(()=>({id:attempt,status:'succeeded',completed:true,result:{text:'完整答案'}}));
    const waited=await runCommand(['attempt','wait','--ids',attempt,'--full'],client);
    expect(waited.attempts[0].result.text).toBe('完整答案');expect(calls[0].url.searchParams.has('view')).toBe(false);
    const shown=await runCommand(['attempt','show','--attempt',attempt],client);
    expect(shown.data.result.text).toBe('完整答案');
  });
  test('两个模型完整合成流程可显式判定、归档与导出，任务关系不丢失', async () => {
    const posts:string[]=[];
    const {client}=fixture((url,init)=>{
      if(init?.method==='POST') {
        posts.push(url.pathname);
        if(url.pathname.endsWith('/export'))return {id:second,status:'succeeded',workflow_count:1};
        return {results:[{workflow_id:question,status:'queued',attempt_id:attempt,attempt_ids:[attempt,second]}]};
      }
      if(url.pathname.includes('/attempts/'))return {id:url.pathname.split('/').at(-1),status:'succeeded',completed:true};
      return {workflow:{id:question,title:'题目1'},steps:[{ordinal:7,status:'succeeded',result:{decision:'accepted',model_scores:{m1:{status:'passed',score:7,max_score:20,percentage:35,threshold:50},m2:{status:'passed',score:8,max_score:20,percentage:40,threshold:50}}}}]};
    });
    for(const key of ['receive_materials','redact_materials','author_question','model_answer','independent_score','accept_or_revise','publish_export']) {
      const dispatched=await runCommand(['step','dispatch',key,'--project',project,'--ids',question],client);
      const done=await runCommand(['attempt','wait','--ids',dispatched.attempt_ids.join(',')],client);
      expect(done.attempts).toHaveLength(2);expect(done.outcome).toBe('complete');
    }
    const result=await runCommand(['result','show','--workflow',question],client);
    expect(Object.keys(result.business.model_scores)).toEqual(['m1','m2']);
    expect(result.business.decision).toBe('accepted');
    await runCommand(['export','create','--project',project],client);
    expect(posts).toHaveLength(8);
  });
  test('原样保留无效评分与等待判定，不替服务端推算通过', async () => {
    const {client}=fixture(()=>({steps:[{ordinal:6,status:'failed',result:{models:[{score_valid:false}]}},{ordinal:7,status:'waiting',result:{decision:'waiting',model_scores:{m1:{status:'invalid',threshold:50}}}}]}));
    const result=await runCommand(['result','show','--workflow',question],client);
    expect(result.business.decision).toBe('waiting');expect(result.business.model_scores.m1.status).toBe('invalid');
  });
  test('产物及Excel下载使用独立接口且禁止覆盖本机文件', async () => {
    const root=await mkdtemp(join(tmpdir(),'ai-distill-cli-test-'));
    const paths:string[]=[];
    const client=new ApiClient(undefined,async url=>{paths.push(new URL(url).pathname);return new Response('export bytes');});
    try {
      for(const kind of ['artifact','export']) {
        const out=join(root,`${kind}.txt`);
        await runCommand([kind,'download',`--${kind}`,second,'--out',out],client);
        expect(await readFile(out,'utf8')).toBe('export bytes');
        await expect(runCommand([kind,'download',`--${kind}`,second,'--out',out],client)).rejects.toThrow('无法写入');
      }
      expect(paths).toContain(`/api/artifacts/${second}/download`);expect(paths).toContain(`/api/exports/${second}/download`);
    } finally {await rm(root,{recursive:true,force:true});}
  });
  test('等待外层预算到期会中断本次读取，后台任务仍未取消', async () => {
    let methods:string[]=[];
    const client=new ApiClient(undefined,async (_input,init)=>{
      methods.push(init!.method!);
      return await new Promise<Response>((_resolve,reject)=>init!.signal!.addEventListener('abort',()=>reject(new Error('deadline')),{once:true}));
    });
    const result=await runCommand(['attempt','wait','--ids',attempt,'--timeout','10ms'],client);
    expect(result.outcome).toBe('waiting');expect(methods).toEqual(['GET']);
    expect(result.attempts[0].id).toBe(attempt);
  });
  test('空派发响应不能显示全部接受', async () => {
    const {client}=fixture(()=>({results:[]}));
    const result=await runCommand(['step','dispatch','author_question','--project',project,'--ids',question],client);
    expect(result.outcome).toBe('partial');
  });
  test('所有可见步骤使用稳定身份，不依赖显示顺序', async () => {
    for(const [key,ordinal] of [['receive_materials',1],['redact_materials',9],['author_question',4],['model_answer',5],['independent_score',6],['accept_or_revise',7],['publish_export',8]] as const) {
      const {client,calls}=fixture(()=>({results:[{workflow_id:question,status:'queued',attempt_id:attempt}]}));
      await runCommand(['step','dispatch',key,'--project',project,'--ids',question],client);
      expect(calls[0].url.pathname).toBe(`/api/projects/${project}/steps/${ordinal}/run-batch`);
    }
  });
  test('101道题分组，不扩大范围；后组断开仍保留已提交任务', async () => {
    const selected=Array.from({length:101},(_,i)=>`00000000-0000-4000-8000-${String(i).padStart(12,'0')}`);
    let count=0;
    const client=new ApiClient(undefined,async(_url,init)=>{
      const body=JSON.parse(String(init?.body));count++;
      if(count===2)throw new Error('disconnected');
      expect(body.workflow_ids).toHaveLength(100);
      return Response.json({results:body.workflow_ids.map((workflow_id:string)=>({workflow_id,status:'queued',attempt_id:attempt}))});
    });
    const result=await runCommand(['step','dispatch','author_question','--project',project,'--ids',selected.join(',')],client);
    expect(result.outcome).toBe('partial');expect(result.dispatch).toHaveLength(100);
    expect(result.attempt_ids).toEqual([attempt]);expect(count).toBe(2);
    expect(result.batches[1].error.outcome_unknown).toBe(true);
  });
  test('批量状态读取分100条并指出不存在题目', async () => {
    const {client,calls}=fixture(()=>({}));
    const result=await runCommand(['workflow','status','--project',project,'--ids',question],client);
    expect(result.outcome).toBe('partial');expect(result.missing_workflow_ids).toEqual([question]);
    expect(calls[0].url.pathname).toBe(`/api/projects/${project}/workflow-status`);
  });
  test('等待保留多模型各自终态和单项读取失败', async () => {
    const {client}=fixture(url=>url.pathname.endsWith(attempt)
      ? {id:attempt,status:'succeeded',completed:true,result:{model_id:'m1'}}
      : {id:second,status:'skipped',completed:true});
    const result=await runCommand(['attempt','wait','--ids',`${attempt},${second}`],client);
    expect(result.attempts.map((a:any)=>a.status)).toEqual(['succeeded','skipped']);
    expect(result.outcome).toBe('complete');
  });
  test('模拟题目1从入库走到评分，目标处无额外派发', async () => {
    let current=0;
    const order=[1,9,4,5,6];
    const {client,calls}=fixture((url,init)=>{
      if(init?.method==='POST') {
        expect(url.pathname).toBe(`/api/projects/${project}/steps/${order[current++]}/run-batch`);
        return {results:[{workflow_id:question,status:'queued',attempt_id:attempt}]};
      }
      if(url.pathname.includes('/attempts/'))return {id:attempt,status:'succeeded',completed:true};
      return {workflow:{id:question,title:'题目1'},steps:[{ordinal:7,status:'succeeded',result:{decision:'repair'}}]};
    });
    for(const step of ['receive_materials','redact_materials','author_question','model_answer','independent_score']) {
      const submitted=await runCommand(['step','dispatch',step,'--project',project,'--ids',question],client);
      await runCommand(['attempt','wait','--ids',submitted.attempt_ids.join(',')],client);
      await runCommand(['result','show','--workflow',question],client);
    }
    expect(current).toBe(5);
    expect(calls.filter(c=>c.init?.method==='POST')).toHaveLength(5);
    expect(calls.some(c=>/publish|export|revisions|\/steps\/(7|8)\//.test(c.url.pathname))).toBe(false);
  });
  test('只读命令和显式写入命令映射到现有 API', async () => {
    const matrix:[string[],string,string,unknown?][]=[
      [['project','list'],'/api/projects','GET'],
      [['project','show','--project',project],`/api/projects/${project}`,'GET'],
      [['question','list','--project',project],`/api/projects/${project}`,'GET'],
      [['rules','list','--project',project],`/api/projects/${project}/rules`,'GET'],
      [['models','show','--project',project],`/api/projects/${project}/answer-models`,'GET'],
      [['attempt','show','--attempt',attempt],`/api/attempts/${attempt}`,'GET'],
      [['result','list'],'/api/results','GET'],
      [['export','list','--project',project],`/api/projects/${project}/exports`,'GET'],
      [['monitor','show'],'/api/monitor','GET'],
      [['project','sync','--project',project],`/api/projects/${project}/sync-folder`,'POST',{}],
      [['export','create','--project',project,'--batch','本批'],`/api/projects/${project}/export`,'POST',{batch:'本批'}],
      [['project','create','--name','测试','--material-backend','legacy','--material-root','/tmp/questions','--skill-path','/tmp/skill'], '/api/projects','POST',{name:'测试',description:'',material_backend:'legacy',material_root:'/tmp/questions',local_skill_path:'/tmp/skill'}],
      [['project','create','--name','测试 - 第五期','--parent-name','测试','--phase-name','第五期','--material-backend','legacy','--material-root','/tmp/测试/第五期/questions'], '/api/projects','POST',{name:'测试 - 第五期',description:'',material_backend:'legacy',material_root:'/tmp/测试/第五期/questions',parent_name:'测试',phase_name:'第五期'}],
    ];
    for(const [args,path,method,body] of matrix) {
      const {client,calls}=fixture((url,init)=>init?.method==='POST'&&url.pathname==='/api/projects'?{id:project}:{workflows:[]});await runCommand(args,client);
      expect(calls[0].url.pathname).toBe(path);expect(calls[0].init?.method).toBe(method);
      if(body)expect(JSON.parse(String(calls[0].init?.body))).toEqual(body);
    }
  });
  test('规则路径正确编码，不解释为额外参数', async () => {
    const {client,calls}=fixture(()=>({text:'skill'}));
    await runCommand(['rules','file','--project',project,'--path','skill/规则 &说明.md'],client);
    expect(calls[0].url.searchParams.get('path')).toBe('skill/规则 &说明.md');
    expect(calls[0].url.searchParams.size).toBe(1);
  });
  test('等待读取失败保留其他任务结果，中断不触发写请求', async () => {
    const client=new ApiClient(undefined,async input=>input.includes(attempt)?Response.json({id:attempt,status:'succeeded'}):new Response('',{status:404}));
    const result=await runCommand(['attempt','wait','--ids',`${attempt},${second}`],client);
    expect(result.outcome).toBe('partial');expect(result.attempts[0].status).toBe('succeeded');
    expect(result.attempts[1].read_error.http_status).toBe(404);
    const controller=new AbortController();controller.abort();
    await expect(runCommand(['attempt','wait','--ids',attempt],client,controller.signal)).rejects.toThrow('中断');
  });
  test('脱敏使用 ordinal 9，保留所有模型任务和部分失败', async () => {
    const {client,calls} = fixture(() => ({results:[
      {workflow_id:question,status:'queued',attempt_id:attempt,attempt_ids:[attempt,second]},
      {workflow_id:second,status:'not_ready',reason:'前置未完成'},
    ]}));
    const result = await runCommand(['step','dispatch','redact_materials','--project',project,'--ids',`${question},${second}`],client);
    expect(calls[0].url.pathname).toBe(`/api/projects/${project}/steps/9/run-batch`);
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({workflow_ids:[question,second]});
    expect(result.outcome).toBe('partial');
    expect(result.attempt_ids).toEqual([attempt,second]);
  });
  test('拒绝未选范围、混用范围、隐藏步骤和未知参数，且不发请求', async () => {
    const {client,calls} = fixture(() => ({}));
    for (const args of [
      ['step','dispatch','author_question','--project',project],
      ['step','dispatch','author_question','--project',project,'--ids',question,'--all'],
      ['step','dispatch','load_rules','--project',project,'--ids',question],
      ['step','dispatch','author_question','--project',project,'--ids',question,'--reset'],
    ]) await expect(runCommand(args,client)).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
  test('all 先冻结项目题目 ID，再按明确数组派发', async () => {
    const {client,calls} = fixture(url => url.pathname===`/api/projects/${project}`
      ? {workflows:[{id:question,title:'题目1'}]} : {results:[]});
    await runCommand(['step','dispatch','model_answer','--project',project,'--all'],client);
    expect(JSON.parse(String(calls[1].init?.body))).toEqual({workflow_ids:[question]});
  });
  test('脱敏文本始终指定 redacted_only，不读原件', async () => {
    const {client,calls}=fixture(()=>({text:'脱敏正文'}));
    await runCommand(['material','text','--workflow',question,'--material',second,'--redacted-only'],client);
    expect(calls[0].url.searchParams.get('redacted_only')).toBe('true');
  });
  test('等待到失败也是终态但不能报告成功；单次等待不超过30秒', async () => {
    let count=0;
    const {client,calls}=fixture(()=>++count===1?{id:attempt,status:'running',completed:false}:{id:attempt,status:'failed',completed:true,error:'invalid_response'});
    const result=await runCommand(['attempt','wait','--ids',attempt,'--timeout','1h'],client);
    expect(result.outcome).toBe('partial');
    expect(calls.every(call=>Number(call.url.searchParams.get('wait_ms'))<=30000)).toBe(true);
    expect(calls.every(call=>!call.init?.method||call.init.method==='GET')).toBe(true);
  });
  test('超时不取消、不重新派发', async () => {
    const {client,calls}=fixture(()=>({id:attempt,status:'running',completed:false}));
    const result=await runCommand(['attempt','wait','--ids',attempt,'--timeout','0s'],client);
    expect(result.outcome).toBe('waiting');
    expect(calls).toHaveLength(1);
    expect(calls[0].init?.method).toBe('GET');
  });
  test('评分到判定链使用服务端结论，不从执行成功推断达标', async () => {
    const {client,calls}=fixture(()=>({workflow:{id:question},steps:[
      {ordinal:6,status:'succeeded',result:{models:[{model_id:'m1',score:16,max_score:20}]}},
      {ordinal:7,status:'succeeded',result:{decision:'repair',model_scores:[{model_id:'m1',score:16,max_score:20,normalized_score:80,minimum_score:50,passed:false}]}},
    ]}));
    const result=await runCommand(['result','show','--workflow',question],client);
    expect(result.business).toMatchObject({decision:'repair'});
    expect(calls).toHaveLength(1);
    expect(calls[0].init?.method).toBe('GET');
  });

  test('主项目期次、材料候选、本期加载及建题映射当前共享材料 API', async () => {
    const link = '00000000-0000-4000-8000-000000000005';
    const packageId = '00000000-0000-4000-8000-000000000006';
    const redactionId = '00000000-0000-4000-8000-000000000007';
    const {client,calls}=fixture((url,init)=>{
      if(init?.method==='POST')return{id:question,reused:false};
      if(url.pathname==='/api/project-groups')return{items:[{id:project,name:'Work'}]};
      if(url.pathname.endsWith('/phases'))return{group:{id:project,name:'Work'},items:[]};
      if(url.pathname.endsWith('/material-candidates'))return{items:[{id:packageId,usage_status:'in_use'}],page:1};
      if(url.pathname.endsWith('/loaded-materials'))return{items:[{id:link,lock_version:4,selected_redaction_id:redactionId}]};
      return{};
    });
    await runCommand(['project-group','list'],client);
    await runCommand(['project-group','phases','--group',project],client);
    await runCommand(['project','material','candidates','--project',project,'--source-mode','redacted'],client);
    await runCommand(['project','materials','list','--project',project],client);
    await runCommand(['project','materials','load','--project',project,'--package',packageId,'--redaction',redactionId],client);
    await runCommand(['project','materials','question','--project',project,'--link',link,'--version','4','--redaction',redactionId,'--title','样例题','--request-key',attempt,'--role','代理律师','--scenario','证据审查','--direction','先核对文件'],client);
    expect(calls.map(call=>call.url.pathname)).toEqual([
      '/api/project-groups',`/api/project-groups/${project}/phases`,
      `/api/projects/${project}/material-candidates`,`/api/projects/${project}/loaded-materials`,
      `/api/projects/${project}/loaded-materials`,`/api/projects/${project}/loaded-materials/${link}/questions`,
    ]);
    expect(calls[2].url.searchParams.get('source_mode')).toBe('redacted');
    expect(JSON.parse(String(calls[4].init?.body))).toEqual({package_id:packageId,redaction_id:redactionId});
    expect(JSON.parse(String(calls[5].init?.body))).toMatchObject({request_key:attempt,expected_link_version:4,redaction_id:redactionId,title:'样例题',role_perspective:'代理律师',scenario:'证据审查',authoring_direction:'先核对文件'});
  });

  test('材料库版本上传保留文件集合、脱敏声明、幂等键和版本锁', async () => {
    const root=await mkdtemp(join(tmpdir(),'ai-distill-library-cli-'));
    try {
      const source=join(root,'附件.docx'),manifest=join(root,'manifest.json');
      await writeFile(source,'test material');
      await writeFile(manifest,JSON.stringify({files:[{path:source,redaction_mode:'declared_redacted'}]}));
      const {client,calls}=fixture(()=>({id:second,reused:false}));
      await runCommand(['library','revision','create','--package',question,'--version','3','--request-key',attempt,'--manifest',manifest],client);
      const call=calls[0];
      expect(call.url.pathname).toBe(`/api/material-library/packages/${question}/revisions`);
      expect(call.init?.headers).toMatchObject({'If-Match':'3'});
      expect(call.init?.body).toBeInstanceOf(FormData);
      const form=call.init?.body as FormData;
      expect(form.get('request_key')).toBe(attempt);
      expect(form.get('redaction_modes')).toBe('["declared_redacted"]');
      expect((form.get('files') as File).name).toBe('附件.docx');
    } finally { await rm(root,{recursive:true,force:true}); }
  });

  test('新材料任务保留执行目标和 request key，读取与取消复用任务 ID', async () => {
    const revision='00000000-0000-4000-8000-000000000008';
    const job='00000000-0000-4000-8000-000000000009';
    const {client,calls}=fixture((url,init)=>init?.method==='POST'?{id:job,status:'queued',reused:false}:{id:job,status:'running'});
    await runCommand(['library','job','start','--revision',revision,'--kind','extract','--target','server','--request-key',attempt],client);
    await runCommand(['library','job','show','--job',job],client);
    await runCommand(['library','job','cancel','--job',job],client);
    expect(calls.map(call=>call.url.pathname)).toEqual([`/api/material-library/revisions/${revision}/jobs`,`/api/material-library/jobs/${job}`,`/api/material-library/jobs/${job}/cancel`]);
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({kind:'extract',request_key:attempt,execution_target:'server'});
  });
  test('材料任务将期次上下文交给服务端选择模式',async()=>{
    const {client,calls}=fixture(()=>({id:second,status:'queued'}));
    await runCommand(['library','job','start','--revision',second,'--kind','extract','--target','local','--request-key',attempt,'--project',project],client);
    expect(JSON.parse(String(calls[0].init?.body)).project_id).toBe(project);
  });

  test('脱敏模板按ID读取，并在字段映射派发中显式冻结选择', async () => {
    const revision='00000000-0000-4000-8000-000000000014';
    const extraction='00000000-0000-4000-8000-000000000015';
    const template={id:'strict',name:'严格字段模板',workflow:'field_mapping',digest:'a'.repeat(64),redaction:{provider:'api',prompt:'只替换身份证号'}};
    const {client,calls}=fixture((url,init)=>{
      if(url.pathname==='/api/material-library/redaction-templates')return{items:[template]};
      if(init?.method==='POST')return{id:second,status:'queued',reused:false};
      return{};
    });
    expect((await runCommand(['library','template','list'],client)).data.items).toEqual([template]);
    expect((await runCommand(['library','template','show','--template','strict'],client)).data).toEqual(template);
    await runCommand(['library','job','start','--revision',revision,'--kind','redact','--target','local','--request-key',attempt,'--extraction-job',extraction,'--template','strict'],client);
    expect(JSON.parse(String(calls.at(-1)!.init?.body))).toEqual({kind:'redact',request_key:attempt,execution_target:'local',template_id:'strict',extraction_job_id:extraction});
  });

  test('Codex材料计划通过CLI请求既有HTTP导入接口并保留完整计划', async () => {
    const root=await mkdtemp(join(tmpdir(),'ai-distill-material-plan-'));
    try{
      const revision='00000000-0000-4000-8000-000000000016',planPath=join(root,'plan.json');
      const plan={format:'codex-material-export-v1',revision_id:revision,extraction_job_id:attempt,template_id:'aliases',template_digest:'b'.repeat(64),files:[{file_id:question,text_sha256:'a'.repeat(64)}],edits:[],documents:[{id:'d1',title:'测试材料',segments:[{file_id:question,page:1,start:0,end:1}]}]};
      await writeFile(planPath,JSON.stringify(plan));
      const {client,calls}=fixture(()=>({job_id:second,redaction_id:question,reused:false}));
      await runCommand(['library','documents','import','--plan',planPath,'--request-key',project],client);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.url.pathname).toBe(`/api/material-library/revisions/${revision}/prepared-redactions`);
      expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({request_key:project,plan});
    }finally{await rm(root,{recursive:true,force:true});}
  });

  test('新材料项目创建可明确绑定稳定主项目和期号', async () => {
    const group='00000000-0000-4000-8000-000000000010';
    const {client,calls}=fixture(url=>url.pathname==='/api/projects'?{id:project}:{project:{id:project,skill_exists:true},steps:[]});
    await runCommand(['project','create','--name','Work - 第二期','--parent-name','Work','--project-group',group,'--phase-no','2','--phase-name','第二期','--material-backend','library_v1','--workspace-path','/tmp/work'],client);
    expect(calls[0].url.pathname).toBe('/api/projects');
    expect(JSON.parse(String(calls[0].init?.body))).toMatchObject({name:'Work - 第二期',parent_name:'Work',project_group_id:group,phase_no:2,phase_name:'第二期',material_backend:'library_v1',workspace_path:'/tmp/work'});
  });

  test('材料库管理、加载、返修状态和旧材料导入都使用现有API及版本锁', async () => {
    const root=await mkdtemp(join(tmpdir(),'ai-distill-library-update-'));
    const metadata=join(root,'metadata.json');await writeFile(metadata,JSON.stringify({name:'新名称',tags:['更新']}));
    const link='00000000-0000-4000-8000-000000000011';
    const use='00000000-0000-4000-8000-000000000012';
    const legacy='00000000-0000-4000-8000-000000000013';
    const {client,calls}=fixture(()=>({id:second,reused:false,lock_version:5}));
    await runCommand(['library','package','create','--name','合同材料','--tags','合同,借款'],client);
    await runCommand(['library','package','update','--package',question,'--version','2','--file',metadata],new ApiClient(undefined,async (_url,init)=>{
      calls.push({url:new URL(String(_url)),init});return Response.json({id:question});
    }));
    await runCommand(['project','materials','update','--project',project,'--link',link,'--version','4','--position','2'],client);
    await runCommand(['project','materials','remove','--project',project,'--link',link,'--version','4'],client);
    await runCommand(['project','materials','restore','--project',project,'--link',link,'--version','4'],client);
    await runCommand(['project','material','use','update','--project',project,'--use',use,'--version','3','--status','in_use','--reason','返修'],client);
    await runCommand(['project','legacy-materials','import','--project',project,'--workflow',question,'--request-key',attempt],client);
    await runCommand(['project','legacy-materials','import','--project',project,'--workflow',question,'--request-key',second,'--apply','--digest','a'.repeat(64)],client);
    await runCommand(['project','legacy-materials','activate','--project',project,'--import',legacy],client);
    expect(calls.map(call=>call.url.pathname)).toEqual([
      '/api/material-library/packages',`/api/material-library/packages/${question}`,
      `/api/projects/${project}/loaded-materials/${link}`,`/api/projects/${project}/loaded-materials/${link}`,
      `/api/projects/${project}/loaded-materials/${link}/restore`,`/api/projects/${project}/material-uses/${use}`,
      `/api/projects/${project}/legacy-material-imports`,`/api/projects/${project}/legacy-material-imports`,`/api/projects/${project}/legacy-material-imports/${legacy}/activate`,
    ]);
    expect(calls[2].init?.headers).toMatchObject({'If-Match':'4'});
    expect(calls[3].init?.headers).toMatchObject({'If-Match':'4'});
    expect(calls[5].init?.headers).toMatchObject({'If-Match':'3'});
    expect(JSON.parse(String(calls[6].init?.body))).toMatchObject({source_workflow_id:question,request_key:attempt,dry_run:true});
    expect(JSON.parse(String(calls[7].init?.body))).toMatchObject({source_workflow_id:question,request_key:second,dry_run:false,expected_source_digest:'a'.repeat(64)});
    await rm(root,{recursive:true,force:true});
  });

  test('原件下载只写入新文件，来源需要明确指定文件ID',async()=>{
    const root=await mkdtemp(join(tmpdir(),'ai-distill-library-download-'));
    try{
      const out=join(root,'original.docx');
      const client=new ApiClient(undefined,async url=>new URL(url).pathname.endsWith('/content')?new Response('original bytes'):Response.json({}));
      const result=await runCommand(['library','file','download','--file',question,'--out',out],client);
      expect(await readFile(out,'utf8')).toBe('original bytes');expect(result.data.source).toBe('library_original');
      await expect(runCommand(['library','file','download','--file',question,'--out',out],client)).rejects.toThrow('无法写入');
    }finally{await rm(root,{recursive:true,force:true});}
  });
});

// 畸形模板不能在本地导出与正式导入间悄悄降级为旧计划。
test('CLI导入和导出共用模板身份校验，失败时不请求API',async()=>{
 const root=await mkdtemp(join(tmpdir(),'material-plan-invalid-'));const path=join(root,'计划.json');const {client,calls}=fixture(()=>({}));
 try{
  await writeFile(path,JSON.stringify({format:'codex-material-export-v1',revision_id:project,extraction_job_id:attempt,files:[{file_id:question,text_sha256:'a'.repeat(64)}],edits:[],documents:[{id:'d',title:'测试',segments:[]}],template_id:'',template_digest:'b'.repeat(64)}));
  await expect(runCommand(['library','documents','import','--plan',path,'--request-key',second],client)).rejects.toThrow('模板身份和摘要');
  await expect(runCommand(['library','documents','export','--plan',path,'--out',join(root,'新目录')],client)).rejects.toThrow('模板身份和摘要');
  expect(calls).toHaveLength(0);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('仅按稳定主项目ID创建期次时读取真实主项目名称，不把期次显示名当主项目',async()=>{
 const {client,calls}=fixture((url)=>url.pathname.endsWith('/phases')?{group:{id:second,name:'项目甲'},items:[]}:{id:project});
 await runCommand(['project','create','--name','第二期独立显示名','--project-group',second,'--phase-name','第二期','--phase-no','2','--material-backend','library_v1','--workspace-path','/tmp/test'],client);
 expect(calls[0]!.url.pathname).toBe(`/api/project-groups/${second}/phases`);
 expect(JSON.parse(String(calls[1]!.init?.body))).toMatchObject({project_group_id:second,parent_name:'项目甲',phase_name:'第二期',phase_no:2});
 const broken=fixture(()=>({items:[]}));
 await expect(runCommand(['project','create','--name','测试','--project-group',second,'--material-backend','library_v1','--workspace-path','/tmp/test'],broken.client)).rejects.toThrow('缺少名称');
 expect(broken.calls).toHaveLength(1);
});

test('材料库期次更新不要求旧材料目录，也不重绑未修改的推断Skill路径',async()=>{
 const {client,calls}=fixture((url,init)=>init?.method==='GET'?{project:{id:project,name:'测试第一期',description:'旧说明',material_backend:'library_v1',material_root:null,local_skill_path:'/missing/inferred/skill'}}:{id:project});
 await runCommand(['project','update','--project',project,'--description','新说明'],client);
 const body=JSON.parse(String(calls[1]!.init?.body));expect(body).toMatchObject({name:'测试第一期',description:'新说明'});
 expect(body).not.toHaveProperty('material_root');expect(body).not.toHaveProperty('local_skill_path');
 const legacy=fixture((url,init)=>init?.method==='GET'?{project:{id:project,name:'旧项目',description:'',material_root:'/tmp/legacy',local_skill_path:'/tmp/skill'}}:{id:project});
 await runCommand(['project','update','--project',project,'--description','更新'],legacy.client);
 expect(JSON.parse(String(legacy.calls[1]!.init?.body)).material_root).toBe('/tmp/legacy');
});

test('批量等待公平覆盖整组，不被最前四个长任务阻塞，终态不再查询',async()=>{
 const ids=Array.from({length:8},(_,i)=>`00000000-0000-4000-8000-${String(i+100).padStart(12,'0')}`);
 const reads=new Map<string,number>();const seen:string[]=[];
 const client=new ApiClient(undefined,async input=>{
  const url=new URL(input),id=url.pathname.split('/').at(-1)!;seen.push(id);reads.set(id,(reads.get(id)??0)+1);
  const index=ids.indexOf(id),status=index<4&&reads.get(id)===1?'running':'succeeded';
  return Response.json({id,status,completed:status==='succeeded'});
 });
 const result=await runCommand(['attempt','wait','--ids',ids.join(','),'--timeout','2s'],client);
 expect(result.outcome).toBe('complete');expect(new Set(seen.slice(0,8)).size).toBe(8);
 for(const id of ids.slice(4))expect(reads.get(id)).toBe(1);
});
