/**
 * 职责：验证期次材料包自动选版加载（project materials load）与一键批量建题（project materials onboard）的完整契约。
 * 验证边界：纯 HTTP 替身隔离测试（不连接真实数据库），覆盖 aliases/original 自动选版、<=10页拦截、--require-prepared 门槛、--count 跨页候选筛选、确定性幂等键及中断回执续跑。
 */
import {describe,expect,test} from 'bun:test';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ApiClient} from './client';
import {runCommand} from './commands';

const PROJECT_ID='10000000-0000-4000-8000-000000000001';
const PKG_READY_1='20000000-0000-4000-8000-000000000001';
const PKG_READY_2='20000000-0000-4000-8000-000000000002';
const PKG_SHORT='20000000-0000-4000-8000-000000000003';
const PKG_OTHER_PHASE='20000000-0000-4000-8000-000000000004';
const PKG_ALREADY_Q='20000000-0000-4000-8000-000000000005';
const PKG_UNPREPARED='20000000-0000-4000-8000-000000000006';

const REV_1='30000000-0000-4000-8000-000000000001';
const REV_2='30000000-0000-4000-8000-000000000002';
const REV_SHORT='30000000-0000-4000-8000-000000000003';
const REV_UNPREP='30000000-0000-4000-8000-000000000006';

const RED_1='40000000-0000-4000-8000-000000000001';
const RED_2='40000000-0000-4000-8000-000000000002';
const RED_SHORT='40000000-0000-4000-8000-000000000003';
const RED_UNPREP='40000000-0000-4000-8000-000000000006';

const EXT_1='50000000-0000-4000-8000-000000000001';
const LINK_1='60000000-0000-4000-8000-000000000001';
const LINK_2='60000000-0000-4000-8000-000000000002';
const WF_1='70000000-0000-4000-8000-000000000001';
const WF_2='70000000-0000-4000-8000-000000000002';
const WF_EXISTING='70000000-0000-4000-8000-000000000005';
const PREP_1='80000000-0000-4000-8000-000000000001';
const PREP_2='80000000-0000-4000-8000-000000000002';

const SERVER_STRICT_UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function buildMockEnvironment(mode:'aliases'|'original'='aliases'){
 const calls:{method:string;path:string;search:string;body?:any}[]=[];
 const createdByRequestKey=new Map<string,{id:string;body:any}>();
 let disconnectOnQuestionAttempt=false;

 const packages:Record<string,{name:string;rev:string;red:string;pages:number;eligible:boolean;prepared:boolean}>={
  [PKG_READY_1]:{name:'建设工程施工合同纠纷案-L4',rev:REV_1,red:RED_1,pages:28,eligible:true,prepared:true},
  [PKG_READY_2]:{name:'股权转让对赌协议纠纷案-L3',rev:REV_2,red:RED_2,pages:19,eligible:true,prepared:true},
  [PKG_SHORT]:{name:'简短借条案-L2',rev:REV_SHORT,red:RED_SHORT,pages:8,eligible:false,prepared:true},
  [PKG_UNPREPARED]:{name:'尚未整理买卖合同案-L3',rev:REV_UNPREP,red:RED_UNPREP,pages:25,eligible:true,prepared:false},
 };

 const client=new ApiClient(undefined,async(input,init)=>{
  const url=new URL(String(input));
  const method=init?.method??'GET';
  const body=typeof init?.body==='string'&&init.body?JSON.parse(init.body):undefined;
  calls.push({method,path:url.pathname,search:url.search,body});

  if(url.pathname===`/api/projects/${PROJECT_ID}/material-processing`){
   return Response.json({material_processing_mode:mode,material_source_mode:mode==='original'?'original':'redacted'});
  }
  if(url.pathname===`/api/projects/${PROJECT_ID}/loaded-materials`&&method==='GET'){
   return Response.json({items:[{id:'60000000-0000-4000-8000-000000000099',package_id:PKG_ALREADY_Q,lock_version:1}],page:1,page_size:200,has_more:false});
  }
  if(url.pathname===`/api/projects/${PROJECT_ID}/questions`&&method==='GET'){
   return Response.json({workflows:[{id:WF_EXISTING,package_id:PKG_ALREADY_Q,title:'已建题目'}],page:1,has_more:false});
  }
  if(url.pathname===`/api/projects/${PROJECT_ID}/material-candidates`){
   const page=Number(url.searchParams.get('page')??'1');
   const allCandidates=[
    {id:PKG_OTHER_PHASE,name:'他期已占用包',used_in_project:true,load_eligible:true,load_estimated_docx_pages:30},
    {id:PKG_ALREADY_Q,name:'本期已建题包',used_in_project:true,load_eligible:true,load_estimated_docx_pages:22},
    {id:PKG_SHORT,name:packages[PKG_SHORT]!.name,used_in_project:false,load_eligible:false,load_estimated_docx_pages:8},
    {id:PKG_UNPREPARED,name:packages[PKG_UNPREPARED]!.name,used_in_project:false,load_eligible:true,load_estimated_docx_pages:25},
    {id:PKG_READY_1,name:packages[PKG_READY_1]!.name,used_in_project:false,load_eligible:true,load_estimated_docx_pages:28},
    {id:PKG_READY_2,name:packages[PKG_READY_2]!.name,used_in_project:false,load_eligible:true,load_estimated_docx_pages:19},
   ];
   const items=page===1?allCandidates.slice(0,4):allCandidates.slice(4);
   return Response.json({items,page,page_size:200,total_count:400});
  }
  const pkgMatch=/^\/api\/material-library\/packages\/([^/]+)$/.exec(url.pathname);
  if(pkgMatch){
   const info=packages[pkgMatch[1]!];
   if(!info)return Response.json({message:'不存在'},{status:404});
   return Response.json({id:pkgMatch[1],name:info.name,current_revision_id:info.rev,deleted_at:null});
  }
  const revMatch=/^\/api\/material-library\/packages\/([^/]+)\/revisions$/.exec(url.pathname);
  if(revMatch){
   const info=packages[revMatch[1]!]!;
   return Response.json([{
    id:info.rev,
    package_id:revMatch[1],
    state:'ready',
    load_eligible:info.eligible,
    load_estimated_docx_pages:info.pages,
    jobs:[{id:EXT_1,kind:'extract',status:'succeeded'}],
    redactions:[{
     id:info.red,
     extraction_job_id:EXT_1,
     usable_for_question:true,
     redaction_template_id:'aliases',
     redaction_template_workflow:'codex_plan',
     load_eligible:info.eligible,
     load_estimated_docx_pages:info.pages,
    }],
   }]);
  }
  const prepMatch=/^\/api\/material-library\/packages\/([^/]+)\/preparations$/.exec(url.pathname);
  if(prepMatch){
   const info=packages[prepMatch[1]!]!;
   return Response.json({
    available:true,
    items:info.prepared?[{id:prepMatch[1]===PKG_READY_1?PREP_1:PREP_2,result:{format:'material-preparation-v2'}}]:[],
   });
  }
  if(url.pathname===`/api/projects/${PROJECT_ID}/loaded-materials`&&method==='POST'){
   const pkgId=body.package_id;
   const info=packages[pkgId]!;
   return Response.json({
    id:pkgId===PKG_READY_1?LINK_1:LINK_2,
    project_id:PROJECT_ID,
    package_id:pkgId,
    selected_revision_id:info.rev,
    selected_redaction_id:mode==='aliases'?info.red:null,
    lock_version:2,
    load_eligible:info.eligible,
    load_estimated_docx_pages:info.pages,
    reused:false,
   });
  }
  const qMatch=/^\/api\/projects\/[^/]+\/loaded-materials\/([^/]+)\/questions$/.exec(url.pathname);
  if(qMatch&&method==='POST'){
   if(disconnectOnQuestionAttempt){
    disconnectOnQuestionAttempt=false;
    throw new Error('network reset during question creation');
   }
   const existing=createdByRequestKey.get(body.request_key);
   if(existing)return Response.json({id:existing.id,reused:true,source_digest:'sd',snapshot_digest:'snd'});
   const wfId=qMatch[1]===LINK_1?WF_1:WF_2;
   createdByRequestKey.set(body.request_key,{id:wfId,body});
   return Response.json({id:wfId,reused:false,source_digest:'sd',snapshot_digest:'snd'},{status:201});
  }
  return Response.json({});
 });

 return{
  client,
  calls,
  createdByRequestKey,
  triggerDisconnectOnce(){disconnectOnQuestionAttempt=true;},
 };
}

describe('project materials load 与 onboard',()=>{
 test('project materials load 省略版本参数时按 aliases 与 original 模式自动选版并拦截 <=10 页包',async()=>{
  const aliasesEnv=buildMockEnvironment('aliases');
  const loadedAliases=await runCommand(['project','materials','load','--project',PROJECT_ID,'--package',PKG_READY_1],aliasesEnv.client);
  expect(loadedAliases.data.selected_redaction_id).toBe(RED_1);
  expect(aliasesEnv.calls.find(c=>c.method==='POST'&&c.path.endsWith('/loaded-materials'))?.body).toEqual({
   package_id:PKG_READY_1,
   redaction_id:RED_1,
  });

  const origEnv=buildMockEnvironment('original');
  const loadedOrig=await runCommand(['project','materials','load','--project',PROJECT_ID,'--package',PKG_READY_1],origEnv.client);
  expect(loadedOrig.data.selected_revision_id).toBe(REV_1);
  expect(origEnv.calls.find(c=>c.method==='POST'&&c.path.endsWith('/loaded-materials'))?.body).toEqual({
   package_id:PKG_READY_1,
   revision_id:REV_1,
  });

  await expect(runCommand(['project','materials','load','--project',PROJECT_ID,'--package',PKG_SHORT],aliasesEnv.client)).rejects.toThrow('不足11页门槛');
 });

 test('单包 onboard 自动推导标题、L4 等级标签与严格 v5 确定性幂等键，重复执行严格重放同一 request_key',async()=>{
  const env=buildMockEnvironment('aliases');
  const first=await runCommand(['project','materials','onboard','--project',PROJECT_ID,'--package',PKG_READY_1],env.client);
  expect(first.outcome).toBe('complete');
  expect(first.data.workflow_ids).toEqual([WF_1]);
  expect(first.data.counts).toEqual({created:1});

  const postBody=env.calls.find(c=>c.method==='POST'&&c.path.endsWith('/questions'))?.body;
  expect(postBody).toMatchObject({
   expected_link_version:2,
   redaction_id:RED_1,
   title:'建设工程施工合同纠纷案-L4',
   target_level:'L4',
  });
  expect(SERVER_STRICT_UUID.test(postBody.request_key)).toBe(true);

  const second=await runCommand(['project','materials','onboard','--project',PROJECT_ID,'--package',PKG_READY_1],env.client);
  expect(second.outcome).toBe('complete');
  expect(second.data.counts).toEqual({reused:1});
  expect(second.data.workflow_ids).toEqual([WF_1]);
  const questionPosts=env.calls.filter(c=>c.method==='POST'&&c.path.endsWith('/questions'));
  expect(questionPosts).toHaveLength(2);
  expect(questionPosts[1]!.body.request_key).toBe(questionPosts[0]!.body.request_key);
 });

 test('--count 跨分页自动过滤他期占用、已建题、<=10 页及未整理包，凑满目标数量即停',async()=>{
  const env=buildMockEnvironment('aliases');
  const res=await runCommand([
   'project','materials','onboard',
   '--project',PROJECT_ID,
   '--count','2',
   '--require-prepared',
  ],env.client);
  expect(res.outcome).toBe('complete');
  expect(res.data.accepted_count).toBe(2);
  expect(res.data.workflow_ids).toEqual([WF_1,WF_2]);
  // 未整理的 PKG_UNPREPARED 在加载前即被跳过，不会向 /loaded-materials 发送 POST
  const loadedPkgs=env.calls.filter(c=>c.method==='POST'&&c.path.endsWith('/loaded-materials')).map(c=>c.body.package_id);
  expect(loadedPkgs).toEqual([PKG_READY_1,PKG_READY_2]);
 });

 test('批量 --file 与 --out 遇写请求未知立即停止后续项，续跑复用原 request_key 不重复建题',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'onboard-resume-'));
  try{
   const planPath=join(dir,'plan.json');
   const receipt1=join(dir,'receipt-1.json');
   const receipt2=join(dir,'receipt-2.json');
   await writeFile(planPath,JSON.stringify({
    items:[
     {package_id:PKG_READY_1,title:'定制标题一',direction:'方向一'},
     {package_id:PKG_READY_2,title:'定制标题二',direction:'方向二'},
    ],
   }));

   const env=buildMockEnvironment('aliases');
   // 先让第一题正常创建，第二题在 POST /questions 时模拟断连（先把连接切到第2题时触发）
   let questionCallCount=0;
   const flakyClient=new ApiClient(undefined,async(input,init)=>{
    const url=new URL(String(input));
    if(init?.method==='POST'&&url.pathname.endsWith('/questions')){
     questionCallCount++;
     if(questionCallCount===2)throw new Error('socket hang up');
    }
    return (env.client as any).fetcher(input,init);
   });

   const interrupted=await runCommand(['project','materials','onboard','--project',PROJECT_ID,'--file',planPath,'--out',receipt1],flakyClient);
   expect(interrupted.outcome).toBe('partial');
   expect(interrupted.data.items[0].state).toBe('created');
   expect(interrupted.data.items[1].state).toBe('unknown');
   const persisted=JSON.parse(await readFile(receipt1,'utf8'));
   const savedUnknownKey=persisted.items[1].request_key;
   expect(SERVER_STRICT_UUID.test(savedUnknownKey)).toBe(true);

   // 模拟服务端其实已收到第2题落库，再用原 receipt1 作为 --file 续跑：第1题跳过不重发，第2题按同一 request_key 幂等重放恢复为 reused
   env.createdByRequestKey.set(savedUnknownKey,{id:WF_2,body:{}});
   const beforeCalls=env.calls.length;
   const resumed=await runCommand(['project','materials','onboard','--project',PROJECT_ID,'--file',receipt1,'--out',receipt2],env.client);
   expect(resumed.outcome).toBe('complete');
   expect(resumed.data.workflow_ids).toEqual([WF_1,WF_2]);
   expect(resumed.data.items[0].state).toBe('created');
   expect(resumed.data.items[1].state).toBe('reused');
   const resumeQuestionPosts=env.calls.slice(beforeCalls).filter(c=>c.method==='POST'&&c.path.endsWith('/questions'));
   expect(resumeQuestionPosts).toHaveLength(1);
   expect(resumeQuestionPosts[0]!.body.request_key).toBe(savedUnknownKey);
  }finally{
   await rm(dir,{recursive:true,force:true});
  }
 });
});
