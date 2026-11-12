/** CLI 命令契约测试：题目1为合成夹具，验证范围、稳定步骤身份、多模型派发、轻量／完整等待和只读结果边界。 */
import {describe, expect, test} from 'bun:test';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ApiClient} from './client';
import {HELP,runCommand} from './commands';

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
  test('批量派发将已达标跳过视为明确完成回执，不要求重新创建attempt',async()=>{
    const {client,calls}=fixture(()=>({results:[{workflow_id:question,status:'already_accepted',reason:'已达标，已跳过'}]}));
    const result=await runCommand(['step','dispatch','author_question','--project',project,'--ids',question],client);
    expect(result.outcome).toBe('complete');expect(result.attempt_ids).toEqual([]);expect(result.dispatch[0].status).toBe('already_accepted');expect(calls).toHaveLength(1);
  });
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
  test.each([
    [{workflow_id:second,status:'queued',attempt_id:attempt},'其他题目的回执'],
    [{workflow_id:question,status:'unknown',attempt_id:attempt},'未知状态'],
    [{workflow_id:question,status:'queued',attempt_id:'not-a-uuid'},'无效attempt'],
  ])('派发回执拒绝%s，不能用数量相同冒充本次题目已受理',async(row)=>{
    const {client}=fixture(()=>({results:[row]}));
    const result=await runCommand(['step','dispatch','author_question','--project',project,'--ids',question],client);
    expect(result.outcome).toBe('partial');
    expect(result.dispatch).toEqual([]);
    expect(result.batches[0].error).toMatchObject({kind:'invalid_response',outcome_unknown:true});
  });
  test('删除题目要求匹配期次与精确标题，并拒绝存在活动尝试的题目', async () => {
    const {client,calls}=fixture((url,init)=>{
      if(url.pathname===`/api/workflows/${question}`&&init?.method==='DELETE')return{deleted:true};
      if(url.pathname===`/api/workflows/${question}`)return{workflow:{id:question,project_id:project,workflow_kind:'question',title:'重复题目'},attempts:[]};
      return{deleted:true};
    });
    await runCommand(['question','delete','--project',project,'--workflow',question,'--confirm-title','重复题目'],client);
    expect(calls.at(-1)?.init?.method).toBe('DELETE');
    const mismatch=await runCommand(['question','delete','--project',project,'--workflow',question,'--confirm-title','错误题目'],client).catch(error=>error);
    expect(mismatch).toBeInstanceOf(Error);
    expect(calls.filter(call=>call.init?.method==='DELETE')).toHaveLength(1);
    const activeClient=fixture(url=>({workflow:{id:question,project_id:project,workflow_kind:'question',title:'重复题目'},attempts:[{status:'waiting'}]})).client;
    await expect(runCommand(['question','delete','--project',project,'--workflow',question,'--confirm-title','重复题目'],activeClient)).rejects.toThrow('活动尝试');
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
      await writeFile(manifest,JSON.stringify({files:[{path:source,redaction_mode:'declared_redacted',image_review_required:true}]}));
      const {client,calls}=fixture(()=>({id:second,reused:false}));
      await runCommand(['library','revision','create','--package',question,'--version','3','--request-key',attempt,'--manifest',manifest,'--pdf-provider','glm-ocr','--preserve-images'],client);
      const call=calls[0];
      expect(call.url.pathname).toBe(`/api/material-library/packages/${question}/revisions`);
      expect(call.init?.headers).toMatchObject({'If-Match':'3'});
      expect(call.init?.body).toBeInstanceOf(FormData);
      const form=call.init?.body as FormData;
      expect(form.get('request_key')).toBe(attempt);
      expect(form.get('pdf_provider')).toBe('glm-ocr');
      expect(form.get('redaction_modes')).toBe('["declared_redacted"]');
      expect(form.get('preserve_images')).toBe('true');
      expect(form.get('image_review_files')).toBe('[true]');
      expect((form.get('files') as File).name).toBe('附件.docx');
    } finally { await rm(root,{recursive:true,force:true}); }
  });

  test('材料库导入拒绝把临时恢复产物当成原件', async () => {
    const root=await mkdtemp(join(tmpdir(),'ai-distill-library-recovery-cli-'));
    try {
      const source=join(root,'扫描恢复.txt'),manifest=join(root,'manifest.json');
      await writeFile(source,'扫描全能王 创建');
      await writeFile(manifest,JSON.stringify({version:1,recovery:'pdf-to-text',files:[{path:source,source_pdf:'原件.pdf',characters:8}]}));
      const {client,calls}=fixture(()=>({id:second}));
      await expect(runCommand(['library','import','--name','错误恢复包','--request-key',attempt,'--manifest',manifest],client)).rejects.toThrow('临时恢复清单不能作为材料原件入库');
      expect(calls).toHaveLength(0);
      await writeFile(manifest,JSON.stringify({files:[{path:source,source_pdf:'原件.pdf',characters:8}]}));
      await expect(runCommand(['library','import','--name','去掉恢复标记的错误包','--request-key',attempt,'--manifest',manifest],client)).rejects.toThrow('不支持的来源或恢复字段');
      expect(calls).toHaveLength(0);
    } finally { await rm(root,{recursive:true,force:true}); }
  });

  test('CLI区分需预处理格式与不支持直接入库格式',async()=>{
    const root=await mkdtemp(join(tmpdir(),'ai-distill-library-format-cli-'));
    try{
      const {client,calls}=fixture(()=>({id:second})),manifest=join(root,'manifest.json');
      await writeFile(join(root,'legacy.doc'),'source');await writeFile(manifest,JSON.stringify({files:[{path:'legacy.doc'}]}));
      await expect(runCommand(['library','import','--name','需转换','--request-key',attempt,'--manifest',manifest],client)).rejects.toThrow('library files prepare');
      await writeFile(join(root,'sheet.xlsx'),'source');await writeFile(manifest,JSON.stringify({files:[{path:'sheet.xlsx'}]}));
      await expect(runCommand(['library','import','--name','不支持','--request-key',attempt,'--manifest',manifest],client)).rejects.toThrow('不支持直接入库');expect(calls).toHaveLength(0);
    }finally{await rm(root,{recursive:true,force:true});}
  });

  test('新材料任务保留执行目标和 request key，读取与取消复用任务 ID', async () => {
    const revision='00000000-0000-4000-8000-000000000008';
    const job='00000000-0000-4000-8000-000000000009';
    const {client,calls}=fixture((url,init)=>init?.method==='POST'?{id:job,status:'queued',reused:false}:{id:job,status:'running'});
    await runCommand(['library','job','start','--revision',revision,'--kind','extract','--target','server','--request-key',attempt,'--pdf-provider','glm-ocr'],client);
    await runCommand(['library','job','show','--job',job],client);
    await runCommand(['library','job','cancel','--job',job],client);
    expect(calls.map(call=>call.url.pathname)).toEqual([`/api/material-library/revisions/${revision}/jobs`,`/api/material-library/jobs/${job}`,`/api/material-library/jobs/${job}/cancel`]);
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({kind:'extract',request_key:attempt,execution_target:'server',pdf_provider:'glm-ocr'});
  });
  test('材料任务将期次上下文交给服务端选择模式',async()=>{
    const {client,calls}=fixture(()=>({id:second,status:'queued'}));
    await runCommand(['library','job','start','--revision',second,'--kind','extract','--target','local','--request-key',attempt,'--project',project],client);
    expect(JSON.parse(String(calls[0].init?.body)).project_id).toBe(project);
  });

  test('脱敏模板按ID读取，并在Agent化名派发中显式冻结选择', async () => {
    const revision='00000000-0000-4000-8000-000000000014';
    const extraction='00000000-0000-4000-8000-000000000015';
    const template={id:'aliases',name:'Agent化名模板',workflow:'codex_plan',digest:'a'.repeat(64),redaction:{provider:'codex',prompt:'按整包主体表化名'}};
    const {client,calls}=fixture((url,init)=>{
      if(url.pathname==='/api/material-library/redaction-templates')return{items:[template]};
      if(init?.method==='POST')return{id:second,status:'queued',reused:false};
      return{};
    });
    expect((await runCommand(['library','template','list'],client)).data.items).toEqual([template]);
    expect((await runCommand(['library','template','show','--template','aliases'],client)).data).toEqual(template);
    await runCommand(['library','job','start','--revision',revision,'--kind','redact','--target','local','--request-key',attempt,'--extraction-job',extraction,'--template','aliases'],client);
    expect(JSON.parse(String(calls.at(-1)!.init?.body))).toEqual({kind:'redact',request_key:attempt,execution_target:'local',template_id:'aliases',extraction_job_id:extraction});
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

test('CLI advice and local queue commands call the same HTTP operations without implicit task execution',async()=>{
 const {client,calls}=fixture(url=>url.pathname.endsWith('revision-advice')?{available:true,attempts:[]}:{mode:'local',items:[]});
 expect((await runCommand(['advice','show','--workflow',question],client)).outcome).toBe('complete');
 await runCommand(['advice','generate','--workflow',question],client);
 await runCommand(['queue','show'],client);await runCommand(['queue','cancel','--job',attempt],client);
 expect(calls.map(call=>[call.url.pathname,call.init?.method])).toEqual([[`/api/workflows/${question}/revision-advice`,'GET'],[`/api/workflows/${question}/revision-advice`,'POST'],['/api/system/execution-queue','GET'],[`/api/system/execution-queue/${attempt}/cancel`,'POST']]);
});

test('CLI advice stops on capacity overflow and keeps known rejections distinct from unknown outcomes',async()=>{
 const calls:string[]=[];
 const client=new ApiClient(undefined,async(input,init)=>{const path=new URL(input).pathname;calls.push(`${init?.method} ${path}`);if(init?.method==='GET')return Response.json({workflows:[{id:question,workflow_kind:'question'},{id:second,workflow_kind:'question'}]});return Response.json({error:'本机待领取容量不足',code:'local_queue_full',dispatched:false,lane:'agent',limit:4,waiting:4,requested:1},{status:429});});
 const result:any=await runCommand(['advice','generate','--project',project,'--all'],client);
 expect(result.outcome).toBe('partial');expect(result.results).toMatchObject([{status:'capacity_exceeded',outcome_unknown:false,dispatched:false},{status:'not_dispatched'}]);expect(result.advice_attempt_ids).toEqual([]);expect(calls.filter(call=>call.startsWith('POST'))).toHaveLength(1);
 const rejected=new ApiClient(undefined,async()=>Response.json({error:'当前题目已达标'},{status:409}));
 await expect(runCommand(['advice','generate','--workflow',question],rejected)).rejects.toMatchObject({detail:{outcome_unknown:false,dispatched:false,http_status:409}});
});

test('材料导出使用安全独立文件名，保留长标题、冒号和完整正文',async()=>{
 const {createHash}=await import('node:crypto');const {readdir}=await import('node:fs/promises');
 const {exportPreparedMaterials}=await import('./material-export');
 const root=await mkdtemp(join(tmpdir(),'cli-safe-documents-')),text='第一段\n第二段',hash=createHash('sha256').update(text).digest('hex');
 const title='../材料:长标题/'+ '😀'.repeat(100);
 const plan={format:'codex-material-export-v1',revision_id:project,extraction_job_id:attempt,files:[{file_id:question,text_sha256:hash}],edits:[],documents:[{id:'d1',title,segments:[{file_id:question,page:1,start:0,end:4}]},{id:'d2',title,segments:[{file_id:question,page:1,start:4,end:text.length}]}]};
 const {client,calls}=fixture(url=>url.searchParams.has('file_id')?{items:[{file_id:question,page_count:1,pages:[{page:1,text}]}]}:{items:[{file_id:question}]});
 try{
  const path=join(root,'plan.json'),out=join(root,'out');await writeFile(path,JSON.stringify(plan));
  expect((await exportPreparedMaterials(client,path,out)).document_count).toBe(2);
  const files=await readdir(join(out,'材料'));expect(files).toHaveLength(2);
  for(const file of files){expect(Buffer.byteLength(file)).toBeLessThan(255);expect(file).not.toContain('/');}
  const data=JSON.parse(await readFile(join(out,'出题材料.json'),'utf8'));expect(data.documents[0].title).toBe(title);expect(data.documents.map((d:any)=>d.text).join('')).toBe(text);
  expect(calls.every(c=>!c.init?.method||c.init.method==='GET')).toBe(true);
 }finally{await rm(root,{recursive:true,force:true});}
});

// 本轮新增入口仅验证HTTP契约及结果表达，不连接数据库、不执行模型或外部脚本。
describe('工作流配置与显式恢复入口',()=>{
 test('设计更新只发送指定字段，空文本可清空且不隐式派发',async()=>{
  const {client,calls}=fixture(()=>({updated:true}));
  await runCommand(['workflow','design','update','--workflow',question,'--direction','新方向','--role',''],client);
  expect(calls).toHaveLength(1);expect(calls[0].url.pathname).toBe(`/api/workflows/${question}/authoring-direction`);
  expect(calls[0].init?.method).toBe('PATCH');expect(JSON.parse(String(calls[0].init?.body))).toEqual({authoring_direction:'新方向',role_perspective:null});
  await expect(runCommand(['workflow','design','update','--workflow',question],client)).rejects.toThrow();
  await expect(runCommand(['workflow','design','update','--workflow','错误ID','--scenario','场景'],client)).rejects.toThrow();
  expect(calls).toHaveLength(1);
 });
 test('精确恢复、撤回和复核分别调用现有接口，失败复核不报完成',async()=>{
  const {client,calls}=fixture(url=>url.pathname.endsWith('/revalidate')?{id:second,valid:false,usable_for_question:false}:{id:attempt});
  await runCommand(['workflow','authoring','restore','--workflow',question,'--attempt',attempt],client);
  await runCommand(['workflow','archive','withdraw','--workflow',question],client);
  const result=await runCommand(['library','redaction','revalidate','--redaction',second],client);
  expect(calls.map(c=>[c.url.pathname,c.init?.method])).toEqual([
   [`/api/workflows/${question}/authoring-results/${attempt}/restore`,'POST'],
   [`/api/workflows/${question}/withdraw-archive`,'POST'],[`/api/material-library/redactions/${second}/revalidate`,'POST'],
  ]);expect(result.outcome).toBe('partial');
  const ok=fixture(()=>({valid:true,usable_for_question:true}));
  expect((await runCommand(['library','redaction','revalidate','--redaction',second],ok.client)).outcome).toBe('complete');
 });
 test('钩子查询和显式恢复保留副作用确认，不自行判断幂等性',async()=>{
  const {client,calls}=fixture(url=>url.pathname.endsWith('/hooks')?{available:true,runs:[]}:{id:attempt,status:'succeeded'});
  await runCommand(['workflow','hooks','show','--workflow',question],client);
  await runCommand(['hook','retry','--hook',second],client);
  await runCommand(['hook','retry','--hook',second,'--acknowledge-side-effects'],client);
  await runCommand(['attempt','resume-hooks','--attempt',attempt,'--acknowledge-side-effects'],client);
  expect(calls.map(c=>[c.url.pathname,c.init?.method])).toEqual([
   [`/api/workflows/${question}/hooks`,'GET'],[`/api/hooks/${second}/retry`,'POST'],
   [`/api/hooks/${second}/retry`,'POST'],[`/api/attempts/${attempt}/resume-hooks`,'POST'],
  ]);
  expect(calls.slice(1).map(c=>JSON.parse(String(c.init?.body)))).toEqual([{acknowledge_side_effects:false},{acknowledge_side_effects:true},{acknowledge_side_effects:true}]);
  const rejected=new ApiClient(undefined,async()=>Response.json({error:'副作用需核实'},{status:409}));
  await expect(runCommand(['hook','retry','--hook',second],rejected)).rejects.toMatchObject({detail:{http_status:409}});
  for(const status of ['failed','needs_review']){
   const bad=fixture(()=>({id:second,status}));
   expect((await runCommand(['hook','retry','--hook',second],bad.client)).outcome).toBe('partial');expect(bad.calls).toHaveLength(1);
  }
 });
 test('恢复命令无效参数时不产生HTTP请求',async()=>{
  const {client,calls}=fixture(()=>({}));
  for(const args of [
   ['workflow','authoring','restore','--workflow',question,'--attempt','bad'],
   ['workflow','archive','withdraw','--workflow','bad'],['workflow','hooks','show','--workflow','bad'],
   ['hook','retry','--hook','bad'],['attempt','resume-hooks','--attempt','bad'],
   ['library','redaction','revalidate','--redaction','bad'],
  ])await expect(runCommand(args,client)).rejects.toThrow();
  expect(calls).toHaveLength(0);
 });
 test('达标聚合和API评分配置经设置文件原样转交，不在CLI计算或派发',async()=>{
  const root=await mkdtemp(join(tmpdir(),'cli-decision-config-'));
  const {client,calls}=fixture(()=>({saved:true}));
  const score={provider:'api',api:{provider:'openrouter',model:'deepseek/deepseek-v4.1-flash'},prompt:'逐项评分'};
  const acceptance={aggregation:{mode:'mean_at_most',model_count:2,threshold:50}};
  try{
   const path=join(root,'settings.json');await writeFile(path,JSON.stringify({steps:{independent_score:score,accept_or_revise:acceptance}}));
   expect((await runCommand(['project','settings','apply','--project',project,'--file',path],client)).outcome).toBe('complete');
   expect(calls.map(c=>c.url.pathname)).toEqual([`/api/projects/${project}/steps/6/config`,`/api/projects/${project}/steps/7/config`]);
   expect(calls.map(c=>JSON.parse(String(c.init?.body)))).toEqual([score,acceptance]);
   await writeFile(path,JSON.stringify({steps:{accept_or_revise:null}}));
   await expect(runCommand(['project','settings','apply','--project',project,'--file',path],client)).rejects.toThrow('不支持恢复默认');
   expect(calls).toHaveLength(2);
  }finally{await rm(root,{recursive:true,force:true});}
 });
 test('等待仅确认attempt终态，不声称飞书尾段成功',async()=>{
  const {client,calls}=fixture(()=>({id:attempt,workflow_id:question,ordinal:8,status:'succeeded',completed:true}));
  const result=await runCommand(['attempt','wait','--ids',attempt],client);
  expect(result.outcome).toBe('complete');expect(result.completion_scope).toBe('attempt');
  expect(result.note).toContain('飞书');expect(calls).toHaveLength(1);
 });
 for(const status of ['pending','dispatching','unknown','failed','succeeded'])test(`交付查询区分本地归档与飞书${status}回执，不隐式同步`,async()=>{
  const receipt={status,verification:{status:status==='succeeded'?'passed':'incomplete'}};
  const {client,calls}=fixture(()=>({workflow:{id:question},steps:[{ordinal:8,status:'succeeded',result:{archived_at:'2026-10-27',feishu_sync:receipt,feishu_deliveries:{'base/table':receipt}}}]}));
  const result=await runCommand(['workflow','delivery','show','--workflow',question],client);
  expect(result.data.archive.status).toBe('succeeded');expect(result.data.feishu_sync).toEqual(receipt);
  expect(result.data.feishu_deliveries['base/table']).toEqual(receipt);expect(result.note).toContain('回执');
  expect(calls).toHaveLength(1);expect(calls[0].init?.method).toBe('GET');
 });
 test('交付缺回执保持未知，缺步骤或身份不符不伪造成功',async()=>{
  const missing=fixture(()=>({workflow:{id:question},steps:[]}));
  const result=await runCommand(['workflow','delivery','show','--workflow',question],missing.client);
  expect(result.data.archive.status).toBeNull();expect(result.data.feishu_sync).toBeNull();
  const wrong=fixture(()=>({workflow:{id:second},steps:[]}));
  await expect(runCommand(['workflow','delivery','show','--workflow',question],wrong.client)).rejects.toThrow('身份');
 });
 test('新增命令出现在帮助中',()=>{
  for(const command of ['workflow design update','workflow authoring restore','workflow archive withdraw','workflow hooks show','hook retry','attempt resume-hooks','library redaction revalidate','workflow delivery show'])expect(HELP).toContain(command);
 });
});

// 模拟丢失回执，恢复命令不得自动补确认或重复发送。
test('同步钩子补执行响应未知时只提交一次，保留可查询的原hook ID',async()=>{
 let calls=0;const client=new ApiClient(undefined,async()=>{calls++;throw new Error('模拟连接断开');});
 await expect(runCommand(['hook','retry','--hook',second],client)).rejects.toMatchObject({detail:{outcome_unknown:true}});
 expect(calls).toBe(1);
});

test('交付查询规范化UUID大小写，仍核对返回身份且只取轻量视图',async()=>{
 const workflow='abcdefab-0000-4000-8000-000000000001';
 const {client,calls}=fixture(()=>({workflow:{id:workflow},steps:[]}));
 expect((await runCommand(['workflow','delivery','show','--workflow',workflow.toUpperCase()],client)).data.workflow_id).toBe(workflow);
 expect(calls[0].url.searchParams.get('view')).toBe('status');
});

describe('材料整理与使用范围',()=>{
 test('整理启动、查询和任务等待只调用现有HTTP，不自动推进出题',async()=>{
  const f=fixture((url)=>url.pathname.endsWith('/prepare')?{id:attempt}:url.pathname.includes('/jobs/')?{id:attempt,status:'succeeded',result_summary:{preparation_id:attempt}}:{items:[]});
  await runCommand(['library','prepare','start','--revision',question,'--redaction',second,'--request-key',attempt,'--project',project],f.client);
  expect(JSON.parse(String(f.calls[0]!.init?.body))).toEqual({request_key:attempt,redaction_id:second,project_id:project});expect(f.calls[0]!.url.pathname).toBe(`/api/material-library/revisions/${question}/prepare`);
  const r=await runCommand(['library','job','wait','--job',attempt],f.client);expect(r.outcome).toBe('complete');expect(f.calls).toHaveLength(2);
 });
 test('建题不接收人工候选或文书过滤参数，整理结果由服务端按来源自动冻结',async()=>{
  const f=fixture(()=>({id:question}));const base=['project','materials','question','--project',project,'--link',second,'--redaction',attempt,'--version','1','--title','测试','--request-key',question];
  await runCommand(base,f.client);expect(JSON.parse(String(f.calls[0]!.init?.body))).not.toHaveProperty('preparation_id');
  await expect(runCommand([...base,'--candidate','C1'],f.client)).rejects.toThrow('未知参数');expect(f.calls).toHaveLength(1);
 });
 test('模型强度和来源参数错误在CLI提示，不写入任务',async()=>{
  const f=fixture(()=>({}));await expect(runCommand(['library','prepare','start','--revision',question,'--request-key',attempt],f.client)).rejects.toThrow('只能');expect(f.calls).toHaveLength(0);
 });
});

test('整理show的content开关不要求值，完整内容只按需GET',async()=>{
 const f=fixture(()=>({documents:[{id:'doc-a',text:'完整正文'}]}));
 const r=await runCommand(['library','prepare','show','--preparation',attempt,'--content'],f.client);
 expect(f.calls).toHaveLength(1);expect(f.calls[0]!.url.searchParams.get('include_content')).toBe('true');expect((r.data as any).documents[0].text).toBe('完整正文');
});


test('材料整理CLI冻结单次预算，显式续作只发送一次原job请求',async()=>{
 const {client,calls}=fixture(()=>({id:second,reused:false}));
 await runCommand(['library','prepare','start','--revision',question,'--redaction',attempt,'--request-key',project,'--execution-timeout','30m'],client);
 expect(JSON.parse(String(calls[0]!.init?.body)).execution_timeout_ms).toBe(1800000);
 await runCommand(['library','prepare','resume','--job',attempt,'--request-key',project,'--execution-timeout','1h'],client);
 expect(calls[1]!.url.pathname).toBe(`/api/material-library/jobs/${attempt}/prepare-resume`);
 expect(JSON.parse(String(calls[1]!.init?.body))).toEqual({request_key:project,execution_timeout_ms:3600000});expect(calls).toHaveLength(2);
});

test('材料整理CLI诊断只返回安全计数和停止原因，不输出摘要正文',async()=>{
 const {client,calls}=fixture(url=>url.pathname.includes('/jobs/')?{id:attempt,kind:'prepare',status:'succeeded',result_summary:{preparation_id:attempt}}:{result:{package_summary:'私有正文',document_count:1,unassigned_group_count:0,unassigned_block_count:0,documents:[{summary:'私有摘要',visibility:'visible',notes:'私有备注'},{summary:'已有成果',visibility:'hidden'}],combinations:[{direction:'私有方向'}],warnings:['私有警告']}});
 const out=await runCommand(['library','prepare','diagnose','--job',attempt],client);
 expect(out.data).toMatchObject({document_count:1,entry_count:2,visible_count:1,hidden_count:1,summary_count:2,combination_count:1,warning_count:1});
 expect(JSON.stringify(out)).not.toContain('私有');expect(calls.every(call=>!call.init?.method||call.init.method==='GET')).toBe(true);
});

describe('材料库 CLI 与 HTTP 契约映射',()=>{
 test('只读命令逐项命中唯一对应接口且不产生写请求',async()=>{
  const cases:[string[],string][]=[
   [['library','package','list','--page','2','--page-size','10','--ready-only'], '/api/material-library/packages'],
   [['library','package','show','--package',question],`/api/material-library/packages/${question}`],
   [['library','package','usage','--package',question],`/api/material-library/packages/${question}/usage`],
   [['library','package','revisions','--package',question],`/api/material-library/packages/${question}/revisions`],
   [['library','imports','list'],'/api/material-library/imports'],
   [['library','job','show','--job',attempt],`/api/material-library/jobs/${attempt}`],
   [['library','documents','show','--revision',question,'--extraction-job',attempt],`/api/material-library/revisions/${question}/documents`],
   [['library','redaction','show','--redaction',second],`/api/material-library/redactions/${second}/preview`],
   [['library','processing','show'],'/api/material-library/processing-settings'],
   [['library','prepare','list','--package',question],`/api/material-library/packages/${question}/preparations`],
   [['library','prepare','show','--preparation',attempt],`/api/material-library/preparations/${attempt}`],
  ];
  for(const [command,path] of cases){
   const f=fixture(()=>({items:[]}));
   await runCommand(command,f.client);
   expect(f.calls).toHaveLength(1);expect(f.calls[0]!.url.pathname).toBe(path);
   expect(f.calls[0]!.init?.method??'GET').toBe('GET');
  }
 });

 test('模板查询、复核和取消分别保持查询与显式写入语义',async()=>{
  const f=fixture((url)=>url.pathname.endsWith('/redaction-templates')?{items:[{id:'standard',name:'标准'}]}:{ok:true});
  const shown=await runCommand(['library','template','show','--template','standard'],f.client);
  expect((shown.data as any).id).toBe('standard');
  await runCommand(['library','redaction','revalidate','--redaction',second],f.client);
  await runCommand(['library','job','cancel','--job',attempt],f.client);
  expect(f.calls.map(call=>[call.url.pathname,call.init?.method??'GET'])).toEqual([
   ['/api/material-library/redaction-templates','GET'],
   [`/api/material-library/redactions/${second}/revalidate`,'POST'],
   [`/api/material-library/jobs/${attempt}/cancel`,'POST'],
  ]);
 });

 test('版本化修改只发送文件内容与If-Match，不把本机路径传给服务端',async()=>{
  const root=await mkdtemp(join(tmpdir(),'cli-library-contract-'));
  const update=join(root,'update.json'),settings=join(root,'settings.json');
  await writeFile(update,JSON.stringify({name:'新名称'}));await writeFile(settings,JSON.stringify({material_processing_mode:'aliases'}));
  try{
   const f=fixture(()=>({ok:true}));
   await runCommand(['library','package','update','--package',question,'--version','3','--file',update],f.client);
   await runCommand(['library','package','archive','--package',question,'--version','4'],f.client);
   await runCommand(['library','package','restore','--package',question,'--version','5'],f.client);
   await runCommand(['library','processing','update','--version','6','--file',settings],f.client);
   expect(f.calls.map(call=>[call.url.pathname,call.init?.method])).toEqual([
    [`/api/material-library/packages/${question}`,'PATCH'],
    [`/api/material-library/packages/${question}`,'DELETE'],
    [`/api/material-library/packages/${question}/restore`,'POST'],
    ['/api/material-library/processing-settings','PUT'],
   ]);
   expect(f.calls.map(call=>new Headers(call.init?.headers).get('If-Match'))).toEqual(['3','4','5','6']);
   expect(String(f.calls[0]!.init?.body)).toBe(JSON.stringify({name:'新名称'}));
   expect(String(f.calls[0]!.init?.body)).not.toContain(root);
  }finally{await rm(root,{recursive:true,force:true});}
 });

 test('任务启动只发送稳定记录ID、幂等键和明确执行目标',async()=>{
  const f=fixture(()=>({id:attempt}));
  await runCommand(['library','job','start','--revision',question,'--kind','extract','--target','local','--request-key',attempt],f.client);
  expect(f.calls[0]!.url.pathname).toBe(`/api/material-library/revisions/${question}/jobs`);
  expect(JSON.parse(String(f.calls[0]!.init?.body))).toEqual({kind:'extract',request_key:attempt,execution_target:'local'});
 });
});

// Siriser与其他下载入口共用文件安全逻辑，交付语义保持独立。
test('Siriser下载保留原接口和回执，不覆盖已有文件',async()=>{
 const root=await mkdtemp(join(tmpdir(),'cli-siriser-download-'));const paths:string[]=[];
 const client=new ApiClient(undefined,async url=>{paths.push(new URL(url).pathname);return new Response('archive bytes');});
 const out=join(root,'siriser.zip');
 try{
  const result=await runCommand(['siriser','download','--workflow',question,'--out',out],client);
  expect(result).toEqual({outcome:'complete',data:{path:out,bytes:13,package:'siriser_five_piece',submission_performed:false}});
  await expect(runCommand(['siriser','download','--workflow',question,'--out',out],client)).rejects.toThrow('无法写入');
  expect(await readFile(out,'utf8')).toBe('archive bytes');
  expect(paths).toEqual([`/api/workflows/${question}/siriser-zip`,`/api/workflows/${question}/siriser-zip`]);
 }finally{await rm(root,{recursive:true,force:true});}
});

describe('网页Agent派发参数', () => {
  const revision = '00000000-0000-4000-8000-000000000010', request = '00000000-0000-4000-8000-000000000011', extraction = '00000000-0000-4000-8000-000000000012';
  test('author_question 带 --web 时把冻结设置放进批量派发请求体，其余步骤拒绝',async()=>{
    const {client,calls}=fixture(()=>({results:[{workflow_id:question,status:'queued',attempt_id:attempt}]}));
    await runCommand(['step','dispatch','author_question','--project',project,'--ids',question,'--web','gemini','--web-thinking','on','--web-model-label','Code'],client);
    const post=calls.find(call=>call.url.pathname.endsWith('/steps/4/run-batch'));
    expect(JSON.parse(String(post?.init?.body))).toEqual({workflow_ids:[question],web_settings:{provider:'gemini',thinking:true,model_label:'Code'}});
    await expect(runCommand(['step','dispatch','model_answer','--project',project,'--ids',question,'--web','gemini'],client)).rejects.toThrow('author_question');
    await expect(runCommand(['step','dispatch','author_question','--project',project,'--ids',question,'--web','chatgpt'],client)).rejects.toThrow();
    await expect(runCommand(['step','dispatch','author_question','--project',project,'--ids',question,'--web-thinking','on'],client)).rejects.toThrow('--web');
  });
  test('不带 --web 的出题派发请求体保持原样',async()=>{
    const {client,calls}=fixture(()=>({results:[{workflow_id:question,status:'queued',attempt_id:attempt}]}));
    await runCommand(['step','dispatch','author_question','--project',project,'--ids',question],client);
    expect(JSON.parse(String(calls.find(call=>call.url.pathname.endsWith('/steps/4/run-batch'))?.init?.body))).toEqual({workflow_ids:[question]});
  });
  test('脱敏与整理任务把 web_settings 交给API，并拒绝与Agent设置、server目标混用',async()=>{
    const {client,calls}=fixture(()=>({id:request}));
    await runCommand(['library','job','start','--revision',revision,'--kind','redact','--target','local','--request-key',request,'--extraction-job',extraction,'--web','deepseek'],client);
    expect(JSON.parse(String(calls.at(-1)?.init?.body)).web_settings).toEqual({provider:'deepseek'});
    await runCommand(['library','prepare','start','--revision',revision,'--extraction-job',extraction,'--request-key',request,'--web','deepseek','--web-thinking','off'],client);
    expect(JSON.parse(String(calls.at(-1)?.init?.body)).web_settings).toEqual({provider:'deepseek',thinking:false});
    await expect(runCommand(['library','job','start','--revision',revision,'--kind','redact','--target','server','--request-key',request,'--extraction-job',extraction,'--web','deepseek'],client)).rejects.toThrow('本机');
    await expect(runCommand(['library','job','start','--revision',revision,'--kind','extract','--target','local','--request-key',request,'--web','deepseek'],client)).rejects.toThrow();
    await expect(runCommand(['library','job','start','--revision',revision,'--kind','redact','--target','local','--request-key',request,'--extraction-job',extraction,'--web','deepseek','--agent-model','m','--reasoning-effort','low'],client)).rejects.toThrow();
  });
  test('web status 只投影web通道的本机队列项和容量',async()=>{
    const {client}=fixture(()=>({capacity:{web:{limit:6}},items:[{id:'a',lane:'web'},{id:'b',lane:'agent'}]}));
    const result=await runCommand(['web','status'],client);
    expect(result.data.items).toEqual([{id:'a',lane:'web'}]);expect(result.data.capacity).toEqual({limit:6});
  });
});
