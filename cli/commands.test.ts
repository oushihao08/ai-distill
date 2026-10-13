/** CLI 命令契约测试：题目1为合成夹具，验证范围、稳定步骤身份、多模型派发、轻量／完整等待和只读结果边界。 */
import {describe, expect, test} from 'bun:test';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
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
      [['project','create','--name','测试','--material-root','/tmp/questions','--skill-path','/tmp/skill'], '/api/projects','POST',{name:'测试',description:'',material_root:'/tmp/questions',local_skill_path:'/tmp/skill'}],
      [['project','create','--name','测试 - 第五期','--parent-name','测试','--phase-name','第五期','--material-root','/tmp/测试/第五期/questions'], '/api/projects','POST',{name:'测试 - 第五期',description:'',material_root:'/tmp/测试/第五期/questions',parent_name:'测试',phase_name:'第五期'}],
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
});
