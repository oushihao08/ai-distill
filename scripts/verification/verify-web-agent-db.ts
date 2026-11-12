/**
 * 职责：网页 Agent（lane='web'，6槽位）隔离 PostgreSQL 全链路入库验证。
 * 入口：`bun --no-env-file scripts/verification/verify-web-agent-db.ts --port <本机临时PG端口> --out <证据JSON>`
 * 边界：仅接受 127.0.0.1 的专用空库 `web_verify`，顺序应用全部真实迁移（含 064_web_agent_lane.sql），
 * 使用真实 HTTP 路由（createApp）+ 真实本机队列消费者（runLocalQueueWorker）+ 脚本化 WebChatTransport，
 * 验证容量隔离（6槽独立于 agent/api）、自动网页脱敏被拒、材料整理（prepare，含校验反馈修复回路）及出题（step 4）直接入库，
 * 以及离线作业台（cli/offline.ts）脱敏/整理/出题三类的导出zip→不合格交回→修正轮→合格交回→入库闭环，并在 finally 删 schema；不连接业务库、不调用真实模型。
 */
import {Pool} from 'pg';
import {mkdtemp,readFile,readdir,writeFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createApp} from '../../server/app';
import {createLibraryPackage,createLibraryRevision} from '../../server/material-library/service';
import {saveLibraryProcessingSettings} from '../../server/material-library/settings';
import {insertLibraryTextBlob} from '../../server/material-library/storage';
import {renderRedactedMaterials} from '../../server/materials/redaction';
import {hash} from '../../server/material-library/execution-shared';
import {canonicalJson} from '../../shared/workflow-config';
import {localQueue,withLocalQueueRoot,reconcileRegistrations} from '../../server/execution-queue/runtime';
import {runLocalQueueWorker} from '../../server/execution-queue/worker';
import {setWebTransportForTests} from '../../server/web-executors/common';
import {readOfflineTask} from '../../server/web-agent/offline-transport';
import {offlineExport,offlineImport,type OfflineHttp} from '../../cli/offline';
import type {WebChatTransport,WebChatTurn} from '../../server/web-agent';

const arg=(flag:string)=>process.argv[process.argv.indexOf(flag)+1];
const port=Number(arg('--port')),out=arg('--out');
if(!process.argv.includes('--port')||!process.argv.includes('--out')||!Number.isInteger(port)||port<1024||port>65535){
  throw new Error('需要明确 --port <本机临时PG端口> 与 --out <证据路径>');
}
process.env.EXECUTION_QUEUE_MODE='local';

const root=await mkdtemp(join(tmpdir(),'web-agent-db-verify-'));
// 离线作业台交换目录位于 storageDirectory()/web-offline，指向本次临时根，避免写入仓库 .storage。
process.env.STORAGE_DIR=root;
const queue=localQueue(root);
const options={host:'127.0.0.1',port,user:'postgres',database:'web_verify',ssl:false,max:6,connectionTimeoutMillis:5000,options:'-c statement_timeout=15000'};
const admin=new Pool({...options,application_name:'web-verify-admin'});
const pool=new Pool({...options,application_name:`ai-distill-executor:${queue.executorId}`});
const results:{name:string;passed:boolean;detail?:Record<string,unknown>}[]=[];
let schemaCreated=false,cleaned=false,failure:unknown;

function assert(v:unknown,message:string):asserts v{if(!v)throw new Error(message);}
async function check(name:string,run:()=>Promise<Record<string,unknown>|void>){
  const detail=await run();
  results.push({name,passed:true,...(detail?{detail}:{})});
  console.log('PASS '+name);
}

/** 运行真实 runLocalQueueWorker 直到目标任务进入终态，随后排空退出。 */
async function drainUntil(predicate:()=>Promise<boolean>,limits={agent:2,llmApi:4,web:6},timeoutMs=15000){
  const drain=new AbortController(),hard=new AbortController();
  const worker=withLocalQueueRoot(root,()=>runLocalQueueWorker(pool,root,hard.signal,limits,async()=>true,'all',undefined,'local',drain.signal));
  const deadline=Date.now()+timeoutMs;
  try{
    while(Date.now()<deadline){
      if(await predicate()){drain.abort();await worker;return;}
      await Bun.sleep(60);
    }
    throw new Error('等待本机队列消费者完成超时');
  }finally{
    drain.abort();hard.abort();
    await worker.catch(()=>{});
  }
}

function findUploadedText(turn:WebChatTurn,suffix:string):string{
  for(const file of turn.files??[]){
    const content=typeof file.content==='string'?file.content:new TextDecoder().decode(file.content);
    if(file.name===suffix||file.name.endsWith(suffix))return content;
    const re=/<<<<< FILE: ([^|>]+?)(?:\s*\|[^>]+)? >>>>>\n([\s\S]*?)\n<<<<< END FILE: [^\n]+ >>>>>/g;
    for(const match of content.matchAll(re)){
      if(match[1]!.trim().endsWith(suffix))return match[2]!;
    }
  }
  throw new Error(`上传文件中未找到 ${suffix}`);
}

/** 合成合法整理结果：首份文书visible、其余hidden，带组合与可出题评估。 */
function buildPreparation(materials:{units:{id:string;title:string;text:string}[]}){
          const docs=materials.units.map((u,idx)=>idx===0?({
            id:u.id,
            summary:'原告周文远诉被告山城商贸公司民间借贷本金50万元及利息，载明转账凭证与催告经过。',
            document_type:'民事起诉状',
            tags:['民间借贷','本金利息'],
            notes:'',
            visibility:'visible' as const,
            visibility_reason:'',
            hidden_texts:[],
          }):({
            id:u.id,
            summary:'法院执行裁定载明后续终结本次执行结果。',
            document_type:'执行裁定书',
            tags:['执行裁定'],
            notes:'',
            visibility:'hidden' as const,
            visibility_reason:'形成于组合C1的as_of（立案审查与财产保全准备阶段）之后，直接透露执行终本结论，且剩余visible起诉状已具备完整主体、金额与事实依据。',
            hidden_texts:[],
          }));
          const prep={
            package_summary:'周文远与山城商贸公司民间借贷纠纷，借款本金50万元，含起诉请求与转账利息核算基础。',
            documents:docs,
            combinations:[{
              id:'C1',
              direction:'原告代理律师审查民间借贷起诉与保全方案',
              party:'原告周文远代理律师',
              scenes:[{scene:'起诉前证据固定与利息分段核算',as_of:'提交民事起诉状前'}],
              core_work:'核对50万元本金及LPR分段利息上限，制定诉讼请求与财产保全申请方案',
              deliverables:['法律意见书','利息核算表'],
              document_ids:[materials.units[0]!.id],
              notes:'依据起诉状载明事实完成利息核算，不预设法院后续执行结果。',
            }],
            question_support:{
              dimensions:{task_actor:2,factual_basis:2,professional_judgment:2,deliverable_viability:2,information_boundary:2},
              reason:'可见民事起诉状完整载明借贷双方、50万元本金、借款与逾期节点，足以支撑单方代理律师核算与诉讼方案设计。',
              allowed_task_types:['法律意见与利息核算'],
              unsupported_conclusions:['法院终本裁定结果'],
            },
          };
  return prep;
}
/** 解析上传的 input.json / delivery.json，合成满足当前schema的完整出题结果。 */
function buildDraft(turn:WebChatTurn){
        const inputJson=JSON.parse(findUploadedText(turn,'input.json')) as {materials:{id:string}[];material_scope?:string;batch_context?:string};
        const deliveryJson=JSON.parse(findUploadedText(turn,'delivery.json')) as {schema:{properties?:Record<string,any>}};
        const attachmentIds=inputJson.materials.map(m=>m.id);
        const needScope=Boolean(deliveryJson.schema?.properties&&'material_scope_selection' in deliveryJson.schema.properties);
        const isModelReport=Boolean(deliveryJson.schema?.properties?.rubric?.items?.properties?.rule);
        const draft:Record<string,unknown>={
          task_name:'民间借贷纠纷起诉前利息分段核算与保全代理意见',
          task_type:'法律实务综合分析',
          header:{industry_l1:'法律服务',industry_l2:'民商事争议解决',task_form:'single_round',occupation_l1:'律师',occupation_l2:'民商事诉讼律师'},
          question:'你作为周文远的代理律师，请根据附件材料核定借款本金50万元及分段逾期利息计算口径，并出具诉前财产保全与诉讼请求审查意见。',
          attachment_ids:attachmentIds,
          rubric:isModelReport?[
            {id:'R1',criterion:'准确识别借款本金50万元及借贷主体周文远、山城商贸公司',rule:'全部命中得满分，漏一主体或本金错误不得分',metadata:{category:'事实核定'}},
            {id:'R2',criterion:'正确按民间借贷司法解释分段核算逾期利息上限并提出可执行保全建议',rule:'利息口径与保全额度均正确得分，否则不得分',metadata:{category:'法律适用与核算'}},
          ]:[
            {id:'R1',criterion:'准确识别借款本金50万元及借贷主体周文远、山城商贸公司',max_score:4},
            {id:'R2',criterion:'正确按民间借贷司法解释分段核算逾期利息上限并提出可执行保全建议',max_score:6},
          ],
          answer_approach:'先核定附件载明的本金与履行期届满日，再按LPR口径核算利息并拟定保全措施。',
          reference_answer:'一、主体与本金核定：出借人周文远，借款人山城商贸公司，本金50万元。\n二、利息与保全方案：按起诉时一年期LPR四倍上限核定逾期利息，同步申请冻结被申请人银行账户50万元及相应利息额度。',
          answer_requirements:{input_mode:'text',output_mode:'text',tools:[]},
          ...(needScope?{material_scope_selection:{
            business_goal:'为委托人周文远固定诉讼请求金额并推进诉前财产保全',
            core_work:'核定50万元本金与分段利息口径并制定保全及起诉审查方案',
            deliverable_use:'供委托人审签确认诉讼请求及提交法院立案保全',
            direction:'原告代理律师审查民间借贷起诉与保全方案',
            party:'原告周文远代理律师',
            scenes:['起诉前证据固定与利息分段核算'],
            deliverables:['法律意见书','利息核算表'],
            additional_combinations:[],
          }}:{}),
        };
  return draft;
}
const fenced=(value:unknown)=>`\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;

let prepRound=0;
let cachedPrepMaterials:{units:{id:string;title:string;text:string}[]}|null=null;
const scriptedTransport:WebChatTransport={
  async open(provider){
    return{
      url:()=>`https://${provider}.example.test/session/${randomUUID()}`,
      async close(){},
      async ask(turn){
        const fileNames=(turn.files??[]).map(f=>f.name);
        // 1) 材料整理：第1轮故意返回不满足 schema 的结果触发同会话反馈回路，第2轮返回完整合法整理结果
        if(fileNames.includes('materials.json')||prepRound===1){
          if(fileNames.includes('materials.json'))cachedPrepMaterials=JSON.parse(findUploadedText(turn,'materials.json'));
          prepRound++;
          if(prepRound===1)return{text:'```json\n{"package_summary":"缺字段测试"}\n```',conversation_url:`https://${provider}.example.test/prepare`,elapsed_ms:5};
          return{text:fenced(buildPreparation(cachedPrepMaterials!)),conversation_url:`https://${provider}.example.test/prepare`,elapsed_ms:8};
        }
        // 2) 出题（步骤4）
        return{text:fenced(buildDraft(turn)),conversation_url:`https://${provider}.example.test/authoring`,elapsed_ms:10};
      },
    };
  },
};

/** 解压作业台中的zip，按导出内容生成上传回合，供模拟人工构造回复。 */
async function readExportedZip(zipPath:string):Promise<{dir:string;turn:WebChatTurn}>{
  const dir=zipPath.replace(/\.zip$/,'');
  await rm(dir,{recursive:true,force:true});await mkdir(dir,{recursive:true});
  const proc=Bun.spawn(['unzip','-q',zipPath,'-d',dir],{stdout:'ignore',stderr:'pipe'});
  if(await proc.exited!==0)throw new Error('解压导出包失败');
  const names=await readdir(join(dir,'files')).catch(()=>[] as string[]);
  return{dir,turn:{prompt:await readFile(join(dir,'prompt.md'),'utf8'),files:await Promise.all(names.map(async name=>({name,content:await readFile(join(dir,'files',name),'utf8')})))}};
}
/** 模拟人工把网页回复存进解压文件夹的 reply/ 下（可多段）。 */
async function returnReply(dir:string,parts:string[]){
  await mkdir(join(dir,'reply'),{recursive:true});
  for(const [index,part] of parts.entries())await writeFile(join(dir,'reply',`reply-${index+1}.md`),part);
}
/** 由导出的 source.json 合成合法化名计划：只回改动条目（稀疏），每个文件一个文书范围。 */
function buildRedactionPlan(turn:WebChatTurn){
  const source=JSON.parse(findUploadedText(turn,'source.json')) as {texts:{id:string;text:string}[]};
  const changed=source.texts.filter(item=>item.text.includes('周文远')).map(item=>({id:item.id,text:item.text.replaceAll('周文远','张明远')}));
  const blocks=[...new Set(source.texts.map(item=>item.id.split('#')[0]!))];
  const byFile=new Map<string,string[]>();
  for(const block of blocks){const file=block.match(/^(f\d+)/)?.[1]??'f';byFile.set(file,[...(byFile.get(file)??[]),block]);}
  const documents=[...byFile.entries()].map(([file,ids],index)=>({id:`doc${index+1}`,title:index===0?'民事起诉状':'执行裁定书',ranges:[{first_block_id:ids[0]!,last_block_id:ids.at(-1)!}],duplicate_of:null}));
  return{texts:changed,documents,unresolved:[]};
}
let offlineHttp:OfflineHttp;
/** 在本机队列消费者运行期间执行CLI离线命令（命令内部轮询任务终态）。 */
async function withWorker<T>(run:()=>Promise<T>):Promise<T>{
  const drain=new AbortController(),hard=new AbortController();
  const worker=withLocalQueueRoot(root,()=>runLocalQueueWorker(pool,root,hard.signal,{agent:2,llmApi:4,web:6},async()=>true,'all',undefined,'local',drain.signal));
  try{return await run();}finally{drain.abort();hard.abort();await worker.catch(()=>{});}
}
/** 完整一轮离线闭环：导出→第1轮交回不合格→导出第2轮修正→交回合格→入库。 */
async function offlineRoundTrip(stage:'redact'|'prepare'|'author',out:string,exportOptions:{project?:string;ids?:string[]},build:(turn:WebChatTurn)=>unknown){
  const exported=await withWorker(()=>offlineExport(offlineHttp,{stage,out,count:1,...exportOptions,timeoutMs:60000}));
  const first=exported.results[0];
  assert(first?.status==='待交回'&&first.zip,`${stage} 导出失败: ${JSON.stringify(first)}`);
  const round1=await readExportedZip(join(out,first.zip));
  assert(round1.turn.files!.length>0&&round1.turn.prompt.length>50,`${stage} 导出包缺少文件或提示词`);
  await returnReply(round1.dir,['```json\n{"invalid":true}\n```']);
  const afterInvalid=await withWorker(()=>offlineImport(offlineHttp,{out,timeoutMs:60000}));
  const second=afterInvalid.results.find((row:any)=>row.seq===first.seq);
  assert(second?.status==='待交回'&&second.round===2&&String(second.zip).includes('第2轮'),`${stage} 不合格回复未生成第2轮: ${JSON.stringify(second)}`);
  const round2=await readExportedZip(join(out,second.zip));
  assert(round2.turn.prompt.includes('校验'),`${stage} 第2轮提示词未含校验反馈`);
  // 合格回复拆成两段交回，验证续写拼接
  const full='```json\n'+JSON.stringify(build(round1.turn))+'\n```',cut=Math.floor(full.length/2);
  await returnReply(round2.dir,[full.slice(0,cut)+'\n```',full.slice(cut)]);
  const done=await withWorker(()=>offlineImport(offlineHttp,{out,timeoutMs:60000}));
  const final=done.results.find((row:any)=>row.seq===first.seq);
  assert(final?.status==='已入库',`${stage} 合格回复未入库: ${JSON.stringify(final)}`);
  const ledger=JSON.parse(await readFile(join(out,'对账台.json'),'utf8'));
  const item=ledger.items.find((row:any)=>row.seq===first.seq);
  assert(item.status==='已入库'&&item.history.some((h:any)=>h.event==='exported_correction'),'对账台未记录完整轮次');
  assert((await readFile(join(out,'对账台.md'),'utf8')).includes('已入库'),'对账台.md 未更新');
  const state=await readOfflineTask(item.task);
  assert(state?.status==='imported','离线交换目录未标记为已入库');
  return{task:item.task,job_id:item.job_id,rounds:item.round};
}

try{
  assert((await admin.query('SELECT current_database() AS name')).rows[0].name==='web_verify','拒绝非 web_verify 数据库');
  assert(!(await admin.query("SELECT to_regclass('ai_distill.schema_migrations') AS name")).rows[0].name,'验收只接受空的专用数据库 web_verify');
  await admin.query('CREATE SCHEMA ai_distill');schemaCreated=true;
  await admin.query('CREATE TABLE ai_distill.schema_migrations(name text PRIMARY KEY,applied_at timestamptz DEFAULT now())');
  for(const name of (await readdir(new URL('../../migrations/',import.meta.url))).filter(n=>n.endsWith('.sql')).sort()){
    await admin.query('BEGIN');
    try{
      await admin.query(await readFile(new URL(`../../migrations/${name}`,import.meta.url),'utf8'));
      await admin.query('INSERT INTO ai_distill.schema_migrations(name) VALUES($1)',[name]);
      await admin.query('COMMIT');
    }catch(e){
      await admin.query('ROLLBACK');
      throw new Error(`隔离库迁移 ${name} 失败`,{cause:e});
    }
  }

  await check('064_web_agent_lane.sql 与全部迁移在空库顺序应用',async()=>{
    const r=await admin.query("SELECT name FROM ai_distill.schema_migrations WHERE name='064_web_agent_lane.sql'");
    assert(r.rowCount===1,'064_web_agent_lane.sql 未登记');
    return{migration:'064_web_agent_lane.sql'};
  });

  saveLibraryProcessingSettings(root,0,{
    version:1,
    extraction:{protocol:'v1',provider_config:{}},
    redaction:{provider:'codex',model:'gpt-5.4',reasoning_effort:'high',prompt:'保留法院与金额日期，当事人姓名电话身份证整包统一化名'},
    execution:{task_timeout_ms:120000,request_timeout_ms:30000},
    policy:{preserve_dates:true,preserve_amounts:true},
  });
  setWebTransportForTests(scriptedTransport);
  const app=createApp(pool,root);

  await check('本机队列容量接口暴露6个独立web槽位，且agent满载不阻塞web、第7个web被拦截',async()=>{
    const res0=await withLocalQueueRoot(root,()=>app.request('/api/system/execution-queue'));
    assert(res0.status===200,'读取执行队列失败');
    const body0=await res0.json();
    assert(body0.capacity?.web?.limit===6&&body0.capacity?.web?.waiting===0&&body0.capacity?.web?.available===6,'web槽位初始容量异常');

    const syntheticAgentIds:string[]=[],syntheticWebIds:string[]=[];
    const agentLimit=body0.capacity.agent.limit as number;
    for(let i=0;i<agentLimit;i++){const id=randomUUID();queue.reserveIntents([{id,kind:'step',lane:'agent',route:'authoring'}],{agent:agentLimit});queue.confirm(id,agentLimit);syntheticAgentIds.push(id);}
    for(let i=0;i<6;i++){const id=randomUUID();queue.reserveIntents([{id,kind:'library',lane:'web',route:'library:prepare'}],{web:6});queue.confirm(id,6);syntheticWebIds.push(id);}
    let seventhBlocked=false;
    try{queue.reserveIntents([{id:randomUUID(),kind:'library',lane:'web',route:'library:prepare'}],{web:6});}catch(e:any){seventhBlocked=e?.lane==='web'&&e?.limit===6;}
    assert(seventhBlocked,'第7个web任务未被6槽上限拒绝');
    const resFull=await withLocalQueueRoot(root,()=>app.request('/api/system/execution-queue'));
    const bodyFull=await resFull.json();
    assert(bodyFull.capacity.agent.available===0&&bodyFull.capacity.web.waiting===6&&bodyFull.capacity.web.available===0,'满载容量视图不准确');
    for(const id of [...syntheticAgentIds,...syntheticWebIds]){queue.cancel(id);queue.settle(id,'cancelled',0);}
    return{agent_limit:agentLimit,web_limit:body0.capacity.web.limit,seventh_blocked:true};
  });

  // 准备合成双文件材料包（满足 >10 页拼接 DOCX 准入线）并完成本地 TXT 入库与提取
  const bodyLines=Array.from({length:480},(_,i)=>`第${i+1}节事实记载：原告周文远与被告山城商贸公司于履行期内多次核对借款本金50万元往来凭证、银行流水摘要、催告函回执及利息分段明细。`).join('\n\n');
  const doc1Text=`民事起诉状\n\n原告周文远（身份证50010319800101****，电话138****8000）诉被告山城商贸公司偿还借款本金50万元及逾期利息，2026年3月1日向渝中区人民法院起诉。\n\n${bodyLines}`;
  const doc2Text='执行裁定书\n\n申请执行人周文远与被执行人山城商贸公司民间借贷纠纷一案，渝中区人民法院于2026年9月15日裁定终结本次执行程序。';
  const pkg=await createLibraryPackage(pool,{name:'web-verify-民间借贷样本'});
  const rev=await createLibraryRevision(pool,root,pkg.id,Number(pkg.lock_version),randomUUID(),[
    {original_name:'01-民事起诉状.txt',bytes:Buffer.from(doc1Text)},
    {original_name:'02-执行裁定书.txt',bytes:Buffer.from(doc2Text)},
  ]);
  const intakeRes=await withLocalQueueRoot(root,()=>app.request(`/api/material-library/revisions/${rev.id}/jobs`,{
    method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({kind:'intake',request_key:randomUUID(),execution_target:'local'}),
  }));
  assert(intakeRes.status===202,'入库任务派发失败');
  const intakeJob=(await intakeRes.json()) as {id:string};
  await drainUntil(async()=>(await admin.query('SELECT status FROM ai_distill.library_jobs WHERE id=$1',[intakeJob.id])).rows[0]?.status==='succeeded');

  const extractRes=await withLocalQueueRoot(root,()=>app.request(`/api/material-library/revisions/${rev.id}/jobs`,{
    method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({kind:'extract',request_key:randomUUID(),execution_target:'local'}),
  }));
  assert(extractRes.status===202,'提取任务派发失败');
  const extractJob=(await extractRes.json()) as {id:string};
  await drainUntil(async()=>(await admin.query('SELECT status FROM ai_distill.library_jobs WHERE id=$1',[extractJob.id])).rows[0]?.status==='succeeded');

  let redactionId='';
  await check('自动网页脱敏被拒：HTTP 返回 400；PG 约束只允许本机目标的 redact/web（离线作业台）',async()=>{
    const badRes=await withLocalQueueRoot(root,()=>app.request(`/api/material-library/revisions/${rev.id}/jobs`,{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({kind:'redact',extraction_job_id:extractJob.id,request_key:randomUUID(),execution_target:'local',web_settings:{provider:'deepseek'}}),
    }));
    assert(badRes.status===400,`脱敏传 web_settings 应返回 400，实际 ${badRes.status}`);

    let sqlRejected=false;
    try{
      await admin.query(`INSERT INTO ai_distill.library_jobs(id,package_id,revision_id,kind,status,request_key,input_digest,input_snapshot,config_digest,config_snapshot,executor_kind,execution_target)
        VALUES($1,$2,$3,'redact','queued',$4,$5,'{}'::jsonb,$5,'{}'::jsonb,'web','server')`,
        [randomUUID(),pkg.id,rev.id,randomUUID(),'a'.repeat(64)]);
    }catch{sqlRejected=true;}
    assert(sqlRejected,'library_jobs 约束未拦截 kind=redact, executor_kind=web, execution_target=server');

    // 预置常规 Agent 脱敏产物（与 redaction-runner 同形的 redacted-index-v2）作为下游网页整理与网页出题的真实输入
    const client=await admin.connect();
    try{
      await client.query('BEGIN');
      const docRows=(await client.query(`SELECT f.id AS file_id,f.original_name,b.text_content
        FROM ai_distill.library_files f
        JOIN ai_distill.library_documents d ON d.revision_id=f.revision_id AND d.file_id=f.id AND d.extraction_job_id=$2
        JOIN ai_distill.library_blobs b ON b.id=d.document_blob_id
        WHERE f.revision_id=$1 ORDER BY f.position`,[rev.id,extractJob.id])).rows;
      const materials=docRows.map((r:any)=>{
        const parsed=JSON.parse(r.text_content);
        return{material_id:String(r.file_id),pages:parsed.pages};
      });
      const rendered=renderRedactedMaterials(materials);
      const indexObj=JSON.parse(rendered.index);
      indexObj.prepared_documents=[
        {id:'doc_claim',title:'民事起诉状',text:doc1Text,duplicate_of:null,segments:[],unit_kind:'document',document:{format:'redacted-structure-v1',pages:[{page:1,blocks:[{id:'b1',kind:'paragraph',text:doc1Text}]}]}},
        {id:'doc_ruling',title:'执行裁定书',text:doc2Text,duplicate_of:null,segments:[],unit_kind:'document',document:{format:'redacted-structure-v1',pages:[{page:1,blocks:[{id:'b2',kind:'paragraph',text:doc2Text}]}]}},
      ];
      rendered.markdown=[doc1Text,doc2Text].join('\n\n');
      indexObj.redacted_sha256=hash(rendered.markdown);
      indexObj.preparation_layout='preserved-structure';
      indexObj.redaction_template={id:'aliases',digest:'a'.repeat(64),workflow:'codex_plan'};
      const indexText=JSON.stringify(indexObj);
      const redactJobId=randomUUID();
      const inputDigest=hash(canonicalJson({extract:extractJob.id}));
      const outputDigest=hash(canonicalJson({markdown:hash(rendered.markdown),index:hash(indexText)}));
      const report={material_processing_mode:'aliases',redaction_template_workflow:'codex_plan',usable_for_question:true,protocol:'agent-material-plan-v1',structure_mode:'preserved-structure',redaction_template_id:'aliases'};
      await client.query(`INSERT INTO ai_distill.library_jobs(id,package_id,revision_id,kind,status,request_key,input_digest,input_snapshot,config_digest,config_snapshot,executor_kind,execution_target,result_summary,finished_at)
        VALUES($1,$2,$3,'redact','succeeded',$4,$5,$6::jsonb,$7,$8::jsonb,'agent','local',$9::jsonb,now())`,
        [redactJobId,pkg.id,rev.id,randomUUID(),inputDigest,JSON.stringify({extraction_job_id:extractJob.id}),hash('cfg'),JSON.stringify({version:1,redaction_template:{id:'aliases',workflow:'codex_plan'}}),JSON.stringify(report)]);
      const mdBlob=await insertLibraryTextBlob(client,rendered.markdown,'text/markdown; charset=utf-8');
      const idxBlob=await insertLibraryTextBlob(client,indexText,'application/vnd.ai-distill.redacted-index+json');
      redactionId=randomUUID();
      await client.query(`INSERT INTO ai_distill.library_redactions(id,package_id,revision_id,extraction_job_id,redaction_job_id,markdown_blob_id,index_blob_id,input_digest,output_digest,validation_report)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`,
        [redactionId,pkg.id,rev.id,extractJob.id,redactJobId,mdBlob.id,idxBlob.id,inputDigest,outputDigest,JSON.stringify(report)]);
      await client.query('COMMIT');
    }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
    return{http_rejected:400,sql_rejected:true,seeded_redaction_id:redactionId};
  });

  let preparationId='';
  await check('网页Agent材料整理（lane=web, provider=deepseek）经校验修复回路与compileFixedPreparation直接入库PG',async()=>{
    const prepRes=await withLocalQueueRoot(root,()=>app.request(`/api/material-library/revisions/${rev.id}/prepare`,{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({request_key:randomUUID(),redaction_id:redactionId,web_settings:{provider:'deepseek',thinking:false}}),
    }));
    assert(prepRes.status===202,`网页整理派发失败: ${prepRes.status}`);
    const prepJob=(await prepRes.json()) as {id:string};
    const dispatchRow=(await admin.query('SELECT lane FROM ai_distill.execution_dispatches WHERE job_id=$1',[prepJob.id])).rows[0];
    assert(dispatchRow?.lane==='web','整理任务 execution_dispatches.lane 未设为 web');

    await drainUntil(async()=>{
      const st=(await admin.query('SELECT status FROM ai_distill.library_jobs WHERE id=$1',[prepJob.id])).rows[0]?.status;
      return st==='succeeded'||st==='failed';
    });
    const jobRow=(await admin.query('SELECT status,executor_kind,error_code,error_message FROM ai_distill.library_jobs WHERE id=$1',[prepJob.id])).rows[0];
    assert(jobRow?.status==='succeeded'&&jobRow?.executor_kind==='web',`网页整理入库失败: ${jobRow?.error_code} ${jobRow?.error_message}`);
    assert(prepRound===2,'未验证同会话结构校验反馈修复回路');
    const prepRow=(await admin.query('SELECT id,result FROM ai_distill.library_preparations WHERE job_id=$1',[prepJob.id])).rows[0];
    assert(prepRow?.result?.format==='material-preparation-v2','library_preparations 格式无效');
    assert(prepRow.result.question_support?.status==='usable'&&prepRow.result.question_support?.score===10,'question_support 未编译入库');
    assert(prepRow.result.documents.some((d:any)=>d.visibility==='visible')&&prepRow.result.documents.some((d:any)=>d.visibility==='hidden'),'visible/hidden 分类未入库');
    preparationId=String(prepRow.id);
    return{job_id:prepJob.id,preparation_id:preparationId,rounds:prepRound,support_score:prepRow.result.question_support.score};
  });

  await check('网页Agent出题（step 4, lane=web, provider=gemini）经run-batch派发并直接入库PG',async()=>{
    const projRes=await withLocalQueueRoot(root,()=>app.request('/api/projects',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({
        parent_name:'豆包高经济价值',
        phase_name:'网页通道验证期',
        phase_no:99,
        material_backend:'library_v1',
        material_mode:'material_packages',
        workspace_path:'projects/豆包高经济价值',
        local_skill_path:'projects/豆包高经济价值/skill',
        question_tags:['民间借贷'],
      }),
    }));
    assert(projRes.status===201,`创建验证项目失败: ${projRes.status} ${await projRes.clone().text()}`);
    const project=(await projRes.json()) as {id:string};

    const loadRes=await withLocalQueueRoot(root,()=>app.request(`/api/projects/${project.id}/loaded-materials`,{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({package_id:pkg.id,redaction_id:redactionId}),
    }));
    assert(loadRes.status===201,`加载材料包失败: ${loadRes.status} ${await loadRes.clone().text()}`);
    const loaded=(await loadRes.json()) as {id:string;lock_version?:number};

    const qRes=await withLocalQueueRoot(root,()=>app.request(`/api/projects/${project.id}/loaded-materials/${loaded.id}/questions`,{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({
        request_key:randomUUID(),
        redaction_id:redactionId,
        expected_link_version:Number(loaded.lock_version??1),
        title:'验证题-民间借贷周文远',
        scenario:'诉前证据与利息审查',
        role_perspective:'原告代理律师',
        target_level:'L5',
        authoring_direction:'审查50万元本金与分段利息并制定保全方案',
        question_tags:['民间借贷'],
      }),
    }));
    assert(qRes.status===201,`创建题目失败: ${qRes.status} ${await qRes.clone().text()}`);
    const createdQ=(await qRes.json()) as {workflow_id?:string;id?:string;workflow?:{id:string}};
    const workflowId=String(createdQ.workflow_id??createdQ.workflow?.id??createdQ.id);

    const batchRes=await withLocalQueueRoot(root,()=>app.request(`/api/projects/${project.id}/steps/4/run-batch`,{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({workflow_ids:[workflowId],web_settings:{provider:'gemini'}}),
    }));
    assert(batchRes.status===202,`run-batch 派发失败: ${batchRes.status}`);
    const batchBody=(await batchRes.json()) as {results:{workflow_id:string;status:string;attempt_id?:string;reason?:string}[]};
    assert(batchBody.results[0]?.status==='queued'&&batchBody.results[0]?.attempt_id,`出题未进入排队: ${JSON.stringify(batchBody.results[0])}`);
    const attemptId=batchBody.results[0]!.attempt_id!;

    const dispatchRow=(await admin.query('SELECT lane FROM ai_distill.execution_dispatches WHERE job_id=$1',[attemptId])).rows[0];
    assert(dispatchRow?.lane==='web','步骤4 execution_dispatches.lane 未设为 web');

    await drainUntil(async()=>{
      const st=(await admin.query('SELECT status FROM ai_distill.step_attempts WHERE id=$1',[attemptId])).rows[0]?.status;
      return st==='succeeded'||st==='failed';
    });
    const attemptRow=(await admin.query('SELECT status,config,result,error FROM ai_distill.step_attempts WHERE id=$1',[attemptId])).rows[0];
    assert(attemptRow?.status==='succeeded',`网页出题入库失败: ${attemptRow?.error} ${JSON.stringify(attemptRow?.result)}`);
    assert(attemptRow.config?.provider==='web'&&attemptRow.config?.web?.provider==='gemini','step_attempts.config 未冻结 web 设置');

    const stepRow=(await admin.query('SELECT status,result FROM ai_distill.steps WHERE workflow_id=$1 AND ordinal=4',[workflowId])).rows[0];
    assert(stepRow?.status==='succeeded'&&typeof stepRow?.result?.question_version==='string'&&typeof stepRow?.result?.rubric_version==='string','steps 表未写入版本摘要');

    const artifacts=(await admin.query('SELECT kind,sha256,length(content)::int AS chars FROM ai_distill.artifacts WHERE workflow_id=$1 AND attempt_id=$2 ORDER BY kind',[workflowId,attemptId])).rows;
    const kinds=artifacts.map((r:any)=>r.kind);
    assert(kinds.includes('authored_question')&&Number(artifacts[0]?.chars)>50,`artifacts 缺失: ${JSON.stringify(kinds)}`);

    const scopeUses=(await admin.query('SELECT direction,scene FROM ai_distill.question_material_scope_uses WHERE workflow_id=$1',[workflowId])).rows;
    assert(scopeUses.length===1,'question_material_scope_uses 未落库');
    return{workflow_id:workflowId,attempt_id:attemptId,artifact_kinds:kinds,scope_uses:scopeUses.length};
  });

  offlineHttp={
    get:async path=>{const res=await withLocalQueueRoot(root,()=>app.request(path));if(!res.ok)throw new Error(`GET ${path} ${res.status} ${await res.text()}`);return res.json();},
    post:async(path,body)=>{const res=await withLocalQueueRoot(root,()=>app.request(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body??{})}));if(!res.ok)throw new Error(`POST ${path} ${res.status} ${await res.text()}`);return res.json();},
  };
  const workbench=join(root,'作业台');
  let offlineRedactionId='';

  await check('离线作业台·脱敏：导出zip+对账台，不合格回复导出修正轮，稀疏两段回复拼接后经同一编译器发布 library_redactions',async()=>{
    const result=await offlineRoundTrip('redact',workbench,{ids:[pkg.id]},buildRedactionPlan);
    const row=(await admin.query(`SELECT r.id,j.executor_kind,j.config_snapshot FROM ai_distill.library_redactions r JOIN ai_distill.library_jobs j ON j.id=r.redaction_job_id WHERE j.id=$1`,[result.job_id])).rows[0];
    assert(row&&row.executor_kind==='web'&&row.config_snapshot?.settings?.redaction?.web?.mode==='offline','离线脱敏结果未入库或未冻结离线设置');
    const md=(await admin.query('SELECT b.text_content FROM ai_distill.library_redactions r JOIN ai_distill.library_blobs b ON b.id=r.markdown_blob_id WHERE r.id=$1',[row.id])).rows[0]?.text_content as string;
    assert(md.includes('张明远')&&!md.includes('周文远'),'化名未按回复回填');
    const auto=await withLocalQueueRoot(root,()=>app.request(`/api/material-library/revisions/${rev.id}/jobs`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({kind:'redact',extraction_job_id:extractJob.id,request_key:randomUUID(),execution_target:'local',web_settings:{provider:'deepseek'}})}));
    assert(auto.status===400,`自动网页脱敏应被拒绝，实际 ${auto.status}`);
    offlineRedactionId=String(row.id);
    return{...result,redaction_id:row.id,auto_web_redact_rejected:400};
  });

  await check('离线作业台·整理：导出zip+对账台，不合格回复导出修正轮，回复经compileFixedPreparation直接入库 library_preparations',async()=>{
    // 用上一阶段离线脱敏刚产出的结果继续整理（串起 脱敏→整理）
    const result=await offlineRoundTrip('prepare',join(root,'作业台'),{ids:[offlineRedactionId]},turn=>buildPreparation(JSON.parse(findUploadedText(turn,'materials.json'))));
    const row=(await admin.query('SELECT p.result,j.config_snapshot FROM ai_distill.library_preparations p JOIN ai_distill.library_jobs j ON j.id=p.job_id WHERE j.id=$1',[result.job_id])).rows[0];
    assert(row?.result?.format==='material-preparation-v2'&&row.config_snapshot?.web?.mode==='offline','离线整理结果未入库');
    return result;
  });

  await check('离线作业台·出题：导出input文件zip+对账台，不合格回复导出修正轮，回复经validateDraft直接入库 step_attempts/artifacts',async()=>{
    const projRes=await withLocalQueueRoot(root,()=>app.request('/api/projects',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({parent_name:'离线作业台验证项目',phase_name:'离线验证期',phase_no:1,material_backend:'library_v1',material_mode:'material_packages',workspace_path:'projects/豆包高经济价值',local_skill_path:'projects/豆包高经济价值/skill',question_tags:['民间借贷']}),
    }));
    assert(projRes.status===201,`创建离线验证项目失败: ${projRes.status} ${await projRes.clone().text()}`);
    const project=(await projRes.json()) as {id:string};
    const loadRes=await withLocalQueueRoot(root,()=>app.request(`/api/projects/${project.id}/loaded-materials`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({package_id:pkg.id,redaction_id:redactionId})}));
    assert(loadRes.status===201,`离线项目加载材料失败: ${loadRes.status} ${await loadRes.clone().text()}`);
    const loaded=(await loadRes.json()) as {id:string;lock_version?:number};
    const qRes=await withLocalQueueRoot(root,()=>app.request(`/api/projects/${project.id}/loaded-materials/${loaded.id}/questions`,{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({request_key:randomUUID(),redaction_id:redactionId,expected_link_version:Number(loaded.lock_version??1),title:'离线验证题-民间借贷',scenario:'诉前证据与利息审查',role_perspective:'原告代理律师',target_level:'L5',authoring_direction:'审查50万元本金与分段利息并制定保全方案',question_tags:['民间借贷']}),
    }));
    assert(qRes.status===201,`离线创建题目失败: ${qRes.status} ${await qRes.clone().text()}`);
    const createdQ=(await qRes.json()) as {workflow_id?:string;id?:string;workflow?:{id:string}};
    const workflowId=String(createdQ.workflow_id??createdQ.workflow?.id??createdQ.id);
    const result=await offlineRoundTrip('author',join(root,'作业台'),{project:project.id,ids:[workflowId]},turn=>buildDraft(turn));
    const attemptRow=(await admin.query('SELECT status,config FROM ai_distill.step_attempts WHERE id=$1',[result.job_id])).rows[0];
    assert(attemptRow?.status==='succeeded'&&attemptRow.config?.web?.mode==='offline','离线出题尝试未成功或未冻结离线设置');
    const kinds=(await admin.query('SELECT kind FROM ai_distill.artifacts WHERE workflow_id=$1 AND attempt_id=$2',[workflowId,result.job_id])).rows.map((r:any)=>r.kind);
    assert(kinds.includes('authored_question'),'离线出题 artifacts 未入库');
    const stages=await readdir(join(root,'作业台'));
    assert(['脱敏','整理','出题','对账台.json','对账台.md'].every(name=>stages.includes(name)),`作业台目录结构不完整: ${stages.join(',')}`);
    return{...result,workflow_id:workflowId};
  });

  await reconcileRegistrations(pool,queue);
}catch(error){
  failure=error;
  console.error(error);
}finally{
  setWebTransportForTests(undefined);
  try{
    if(schemaCreated){
      await admin.query('DROP SCHEMA ai_distill CASCADE');
      cleaned=!(await admin.query("SELECT to_regnamespace('ai_distill') AS name")).rows[0].name;
    }
  }finally{
    await Promise.all([pool.end(),admin.end()]);
    queue.close();
    await rm(root,{recursive:true,force:true});
    await mkdir(dirname(out),{recursive:true});
    await writeFile(out,JSON.stringify({
      at:new Date().toISOString(),
      passed:results.length,
      results,
      cleaned,
      models_called:false,
      error:failure instanceof Error?failure.message:null,
    },null,2));
  }
}
if(failure)throw failure;
