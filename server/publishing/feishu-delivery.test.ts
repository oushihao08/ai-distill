/**
 * 职责：严谨验证飞书交付共用模块（feishu-delivery.ts）、进程内 token 缓存与 >20MB 分片上传（client.ts）、
 *       多项目目标路由（feishu-targets.ts）、本地快照零跨网索引读取（redacted-docx-export.ts）及本地清单同步（cli/feishu-local.ts）。
 * 验证边界：使用内存替身与本机回环 HTTP 假服务（127.0.0.1），不触碰真实飞书或远端数据库。
 */
import {describe,expect,test} from 'bun:test';
import {createHash} from 'node:crypto';
import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {Pool} from 'pg';
import {syncLocalFeishu} from '../../cli/feishu-local';
import {canonicalJson} from '../../shared/workflow-config';
import {createAppClient,clearFeishuAuthTokenCache} from '../../toolSkills/feishu-operations/scripts/client';
import {REDACTED_DOCX_RENDERER_VERSION,buildDocx} from '../document-generation/docx';
import {exportCurrentMaterialDocx} from '../materials/redacted-docx-export';
import {
 clearFeishuDeliverySessionCache,
 createFeishuDeliverySession,
 deliverQuestionToFeishu,
 uploadFeishuAttachments,
} from './feishu-delivery';
import {readFeishuDeliveryConfig} from './feishu-targets';
import {feishuTextFields} from './feishu-verification';
import {materialPdfAttachments,peekCachedMaterialPdfNames} from './material-pdf';

const sha256=(v:string|Uint8Array)=>createHash('sha256').update(v).digest('hex');
const WF_A='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const WF_B='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2';
const WF_C='cccccccc-cccc-4ccc-8ccc-ccccccccccc3';
const BASE='baseTestToken12345';
const TABLE='tblTestTable12345';

const SAMPLE_QUESTION={
 question_version:'qv-1',
 rubric_version:'rv-1',
 task_name:'测试法律任务',
 task_type:'法律咨询',
 question:'请起草审查意见。',
 rubric:[{id:'R1',max_score:10,criterion:'识别核心违约条款',rule:'准确引用给满分'}],
 answer_approach:'先梳理合同时间线。',
 reference_answer:'标准审查意见正文。',
};

describe('uploadFeishuAttachments 并发与严格保序',()=>{
 test('逆序返回的多文件上传受控并发且输出 file_token 严格与输入索引一一对应',async()=>{
  let active=0,maxActive=0;
  const payloads=Array.from({length:9},(_,i)=>({
   name:`00${i+1}-文书.pdf`,
   bytes:new Uint8Array([i,1,2,3]),
   mimeType:'application/pdf',
  }));
  const api={
   async call(_path:string,_method?:string,body?:unknown){
    active++;
    maxActive=Math.max(maxActive,active);
    const form=body as FormData;
    const name=String(form.get('file_name'));
    const idx=Number(name.slice(0,3))-1;
    // 索引越小延迟越长，刻意制造乱序完成
    await new Promise(resolve=>setTimeout(resolve,(9-idx)*4));
    active--;
    return{file_token:`tok_${idx}`};
   },
  };
  const uploaded=await uploadFeishuAttachments(api,BASE,payloads,{concurrency:4});
  expect(maxActive).toBeLessThanOrEqual(4);
  expect(maxActive).toBeGreaterThan(1);
  expect(uploaded.map(item=>item.file_token)).toEqual(Array.from({length:9},(_,i)=>`tok_${i}`));
 });
});

describe('deliverQuestionToFeishu 共用函数核心行为',()=>{
 test('远端已有同题草稿且附件名匹配时，升为归档直接跳过 PDF prepare 与媒体上传，仅更新完成状态',async()=>{
  clearFeishuDeliverySessionCache();
  let prepareCount=0,uploadCount=0,schemaFieldCalls=0;
  const recordFields:Record<string,any>={
   ...feishuTextFields(WF_A,SAMPLE_QUESTION,'未完成'),
   '输入附件':[{file_token:'existing_pdf_tok',name:'案卷材料.pdf'}],
  };
  const clientFactory=async()=>({
   async close(){},
   async list(path:string){
    if(path.endsWith('/fields')){
     schemaFieldCalls++;
     return[
      ['题目ID',1],['飞书账号',11],['xpert uid',1],['专家来源',3],['一级行业',3],['L1职业簇',3],
      ['任务名称',1],['任务类型',1],['prompt',1],['输入附件',17],['考点rubric',1],['作答思路',1],
      ['标准答案-文本',1],['标准答案-附件',17],['题目是否完成',3],['系统同步ID',1],
     ].map(([field_name,type],i)=>({field_id:`fld_${i}`,field_name,type}));
    }
    if(path.endsWith('/views'))return[{view_id:'vew_1',view_type:'grid'}];
    return[];
   },
   async call(path:string,method='GET',body?:any){
    if(path.includes('/views/'))return{view:{property:{hidden_fields:['fld_15']}}};
    if(path.includes('upload_all')){uploadCount++;return{file_token:'unexpected'};}
    if(path.includes('/records/search'))return{items:[{record_id:'recExisting1',fields:{'题目ID':WF_A,'系统同步ID':WF_A}}]};
    if(method==='PUT'){Object.assign(recordFields,body.fields);return{record:{record_id:'recExisting1',fields:recordFields}};}
    return{record:{record_id:'recExisting1',fields:recordFields}};
   },
   async download(){return new Uint8Array();},
  });

  const session=await createFeishuDeliverySession({clientFactory:clientFactory as any});
  try{
   const r1=await deliverQuestionToFeishu({
    workflowId:WF_A,
    question:SAMPLE_QUESTION,
    stage:'archived',
    target:{base_token:BASE,table_id:TABLE},
    attachmentFormat:'pdf',
    session,
    attachments:{
     knownCurrentNames:['案卷材料.pdf'],
     async prepare(){
      prepareCount++;
      return{currentNames:['案卷材料.pdf'],payloads:[{name:'案卷材料.pdf',bytes:new Uint8Array([1]),mimeType:'application/pdf'}],isUpgradeableAttachmentFormat:()=>false};
     },
    },
   });
   expect(r1.status).toBe('succeeded');
   expect(r1.reused).toBe(true);
   expect(r1.verification.status).toBe('passed');
   expect(recordFields['题目是否完成']).toBe('已完成');
   expect(prepareCount).toBe(0);
   expect(uploadCount).toBe(0);

   // 同会话第二次核对同一表，复用 10 分钟表结构缓存，不再重复拉取 /fields
   const r2=await deliverQuestionToFeishu({
    workflowId:WF_A,
    question:SAMPLE_QUESTION,
    stage:'archived',
    target:{base_token:BASE,table_id:TABLE},
    attachmentFormat:'pdf',
    session,
    attachments:{
     knownCurrentNames:['案卷材料.pdf'],
     async prepare(){prepareCount++;throw new Error('should not prepare');},
    },
   });
   expect(r2.status).toBe('succeeded');
   expect(schemaFieldCalls).toBe(1);
  }finally{
   await session.close();
  }
 });

 test('同表并发交付：prepare 与上传并行执行，withWriteCriticalSection 严格串行进入不冲突',async()=>{
  clearFeishuDeliverySessionCache();
  const records=new Map<string,any>();
  let concurrentPrepares=0,maxConcurrentPrepares=0;
  let concurrentWrites=0,maxConcurrentWrites=0;

  const clientFactory=async()=>({
   async close(){},
   async list(path:string){
    if(path.endsWith('/fields')){
     return[
      ['题目ID',1],['飞书账号',11],['xpert uid',1],['专家来源',3],['一级行业',3],['L1职业簇',3],
      ['任务名称',1],['任务类型',1],['prompt',1],['输入附件',17],['考点rubric',1],['作答思路',1],
      ['标准答案-文本',1],['标准答案-附件',17],['题目是否完成',3],['系统同步ID',1],
     ].map(([field_name,type],i)=>({field_id:`fld_${i}`,field_name,type}));
    }
    return[];
   },
   async call(path:string,method='GET',body?:any){
    if(path.includes('upload_all')){
     await new Promise(r=>setTimeout(r,15));
     return{file_token:`tok_${Math.random().toString(36).slice(2,8)}`};
    }
    if(path.includes('/records/search')){
     const wf=body.filter.conditions[0].value[0];
     const found=[...records.entries()].filter(([,fields])=>fields['题目ID']===wf).map(([record_id,fields])=>({record_id,fields}));
     return{items:found};
    }
    if(method==='POST'&&path.includes('/records?client_token=')){
     const recId=`rec_${records.size+1}`;
     const stored={...body.fields,'输入附件':body.fields['输入附件'].map((a:any)=>({...a,name:'案卷材料.pdf'}))};
     records.set(recId,stored);
     return{record:{record_id:recId,fields:stored}};
    }
    const recId=path.split('/').at(-1)!;
    return{record:{record_id:recId,fields:records.get(recId)}};
   },
   async download(){return new Uint8Array();},
  });

  const session=await createFeishuDeliverySession({clientFactory:clientFactory as any});
  try{
   const results=await Promise.all([WF_A,WF_B,WF_C].map(wf=>deliverQuestionToFeishu({
    workflowId:wf,
    question:SAMPLE_QUESTION,
    stage:'draft',
    target:{base_token:BASE,table_id:TABLE},
    attachmentFormat:'pdf',
    session,
    attachments:{
     async prepare(){
      concurrentPrepares++;
      maxConcurrentPrepares=Math.max(maxConcurrentPrepares,concurrentPrepares);
      await new Promise(r=>setTimeout(r,20));
      concurrentPrepares--;
      return{
       currentNames:['案卷材料.pdf'],
       payloads:[{name:'案卷材料.pdf',bytes:new Uint8Array([1,2,3]),mimeType:'application/pdf'}],
       isUpgradeableAttachmentFormat:()=>false,
      };
     },
    },
    async withWriteCriticalSection(_target,_fields,run){
     concurrentWrites++;
     maxConcurrentWrites=Math.max(maxConcurrentWrites,concurrentWrites);
     await new Promise(r=>setTimeout(r,10));
     try{
      return{kind:'completed',value:await run({})};
     }finally{
      concurrentWrites--;
     }
    },
   })));
   expect(results.every(r=>r.status==='succeeded'&&r.verification.status==='passed')).toBe(true);
   expect(maxConcurrentPrepares).toBeGreaterThan(1);
   expect(maxConcurrentWrites).toBe(1);
   expect(records.size).toBe(3);
  }finally{
   await session.close();
  }
 });
});

describe('多项目目标路由、大文件分片上传与本地快照零跨网读取',()=>{
 test('非豆包主项目未配置时返回 unconfigured(null) 防自动误投，配置 default_target 后正常返回',async()=>{
  const unconfiguredPool={
   query:async()=>({rows:[{project_group_id:'99999999-9999-4999-8999-999999999999',phase_name:'第一期',settings:null}]}),
  } as unknown as Pick<Pool,'query'>;
  const res1=await readFeishuDeliveryConfig(unconfiguredPool,'11111111-1111-4111-8111-111111111111');
  expect(res1).toEqual({default_target:null,source:'unconfigured',attachment_format:'docx'});

  const configuredPool={
   query:async()=>({rows:[{
    project_group_id:'99999999-9999-4999-8999-999999999999',
    phase_name:'第一期',
    settings:{default_target:{base_token:BASE,table_id:TABLE},attachment_format:'pdf'},
   }]}),
  } as unknown as Pick<Pool,'query'>;
  const res2=await readFeishuDeliveryConfig(configuredPool,'11111111-1111-4111-8111-111111111111');
  expect(res2).toEqual({default_target:{base_token:BASE,table_id:TABLE},source:'configured',attachment_format:'pdf'});
 });

 test('createAppClient 对超过 20MB 的多维表格附件自动拆分为 upload_prepare / upload_part / upload_finish',async()=>{
  clearFeishuAuthTokenCache();
  const calls:string[]=[];
  const partSizes:number[]=[];
  const client=await createAppClient({
   appId:'cli_test',
   appSecret:'sec_test',
   root:'http://127.0.0.1:39999/open-apis',
   fetcher:(async(input:any,init?:RequestInit)=>{
    const url=new URL(String(input));
    calls.push(url.pathname);
    if(url.pathname.endsWith('/tenant_access_token/internal')){
     return Response.json({code:0,tenant_access_token:'tok_1',expire:7200});
    }
    if(url.pathname.endsWith('/upload_prepare')){
     const body=JSON.parse(String(init?.body));
     const blockSize=10*1024*1024;
     return Response.json({code:0,data:{upload_id:'up_123',block_size:blockSize,block_num:Math.ceil(body.size/blockSize)}});
    }
    if(url.pathname.endsWith('/upload_part')){
     const form=init?.body as FormData;
     partSizes.push(Number(form.get('size')));
     return Response.json({code:0,data:{}});
    }
    if(url.pathname.endsWith('/upload_finish')){
     return Response.json({code:0,data:{file_token:'chunked_file_tok'}});
    }
    return Response.json({code:0,data:{}});
   }) as any,
  });

  const bigBytes=new Uint8Array(21*1024*1024+123);
  const form=new FormData();
  form.set('file_name','超长案卷.pdf');
  form.set('parent_type','bitable_file');
  form.set('parent_node',BASE);
  form.set('size',String(bigBytes.byteLength));
  form.set('file',new Blob([bigBytes],{type:'application/pdf'}),'超长案卷.pdf');

  const res=await client.call('/drive/v1/medias/upload_all','POST',form);
  expect(res.file_token).toBe('chunked_file_tok');
  expect(partSizes).toEqual([10*1024*1024,10*1024*1024,1*1024*1024+123]);
  expect(calls.some(p=>p.endsWith('/upload_all'))).toBe(false);
 });

 test('library_v1 导出材料 DOCX 直接命中本机快照索引并返回内存 files，二次复用零 artifacts 写操作',async()=>{
  const root=await mkdtemp(join(tmpdir(),'lib-docx-fast-'));
  try{
   const storageRoot=join(root,'storage'),exportsRoot=join(root,'exports');
   const wfDir=join(storageRoot,WF_A);
   await mkdir(wfDir,{recursive:true});
   await mkdir(exportsRoot,{recursive:true});

   const matId='11111111-2222-4333-8444-555555555555';
   const libFileId='22222222-2222-4333-8444-555555555555';
   const mdArtId='33333333-2222-4333-8444-555555555555';
   const idxArtId='44444444-2222-4333-8444-555555555555';
   const pkgId='55555555-2222-4333-8444-555555555555';
   const revId='66666666-2222-4333-8444-555555555555';
   const redId='77777777-2222-4333-8444-555555555555';

   const markdown='民事起诉状正文内容';
   const docStruct={format:'redacted-structure-v1',pages:[{page:1,blocks:[{id:'b1',kind:'heading',level:1,text:markdown}]}]};
   const indexText=JSON.stringify({
    format:'redacted-index-v2',
    redacted_sha256:sha256(markdown),
    materials:[{material_id:matId,markdown,document:docStruct}],
    pages:[{material_id:matId,page:1}],
   });
   await writeFile(join(wfDir,'redacted_markdown.md'),markdown);
   await writeFile(join(wfDir,'redacted_index.json'),indexText);

   const snapshotManifest={
    version:2,
    origin:{
     kind:'library_v1',
     material_processing_mode:'aliases',
     material_mode:'redacted',
     package_id:pkgId,
     package_name:'测试材料包',
     revision_id:revId,
     redaction_id:redId,
     source_digest:sha256('src'),
    },
    files:[{
     library_file_id:libFileId,
     material_id:matId,
     source_sha256:sha256('orig-pdf'),
     document_sha256:sha256('doc'),
     original_copy:'omitted',
     pages_artifact_id:'88888888-2222-4333-8444-555555555555',
     position:1,
     original_name:'起诉状.pdf',
    }],
    material_markdown:{artifact_id:mdArtId,sha256:sha256(markdown),kind:'redacted_markdown'},
    material_index:{artifact_id:idxArtId,sha256:sha256(indexText),kind:'redacted_index'},
   };
   const snapshotDigest=sha256(canonicalJson(snapshotManifest));

   const savedDocx:any[]=[],savedManifests:any[]=[];
   let writeSqlCount=0;
   const dbClient={
    release(){},
    async query(sql:string,values?:any[]){
     // 核心断言：本地快照命中时严禁跨网拉取 artifacts.content 大文本列！
     if(sql.includes('FROM ai_distill.artifacts')&&sql.includes('content')&&!sql.includes("kind='redacted_docx_manifest'")&&!sql.startsWith('INSERT')&&!sql.startsWith('UPDATE')){
      throw new Error(`禁止在本地快照存在时查询远端大字段 content: ${sql}`);
     }
     if(sql.startsWith('INSERT')||sql.startsWith('UPDATE')||sql.startsWith('DELETE'))writeSqlCount++;
     if(sql.startsWith('SELECT w.id AS workflow_id')){
      return{rows:[{workflow_id:WF_A,project_id:pkgId,title:'测试题',source_key:null,workflow_kind:'question',material_backend:'library_v1',has_library_snapshot:true,project_name:'豆包高经济价值 - 第八期',parent_name:'豆包高经济价值',phase_name:'第八期'}]};
     }
     if(sql.startsWith('SELECT p.material_backend')){
      return{rows:[{material_backend:'library_v1',has_library_snapshot:true}]};
     }
     if(sql.includes('FROM ai_distill.question_library_sources WHERE workflow_id=$1')){
      return{rows:[{
       project_id:pkgId,package_id:pkgId,revision_id:revId,redaction_id:redId,material_mode:'redacted',
       source_digest:snapshotManifest.origin.source_digest,snapshot_manifest:snapshotManifest,snapshot_digest:snapshotDigest,
       markdown_artifact_id:mdArtId,index_artifact_id:idxArtId,
      }]};
     }
     if(sql.includes('SELECT id,kind,attempt_id,sha256,storage_path,size_bytes FROM ai_distill.artifacts')){
      return{rows:[
       {id:mdArtId,kind:'redacted_markdown',attempt_id:null,sha256:sha256(markdown),storage_path:`${WF_A}/redacted_markdown.md`,size_bytes:Buffer.byteLength(markdown)},
       {id:idxArtId,kind:'redacted_index',attempt_id:null,sha256:sha256(indexText),storage_path:`${WF_A}/redacted_index.json`,size_bytes:Buffer.byteLength(indexText)},
      ]};
     }
     if(sql.startsWith('SELECT id,original_name,storage_path,sha256,size_bytes FROM ai_distill.materials')){
      return{rows:[{id:matId,original_name:'起诉状.pdf',storage_path:`${WF_A}/missing.source`,sha256:sha256('orig-pdf'),size_bytes:8}]};
     }
     if(sql.includes('CROSS JOIN LATERAL jsonb_array_elements(s.snapshot_manifest')){
      return{rows:[{
       id:matId,sha256:sha256('orig-pdf'),artifact_declared:false,source_artifact_id:null,original_copy:'omitted',
       frozen_mode:'redacted',library_sha256:sha256('orig-pdf'),library_size_bytes:8,
      }]};
     }
     if(sql.includes("kind='redacted_docx_manifest'"))return{rows:savedManifests};
     if(sql.includes('kind=$2'))return{rows:savedDocx};
     if(sql.startsWith('INSERT INTO ai_distill.artifacts')){
      if(sql.includes("'redacted_docx_manifest'"))savedManifests.push({id:values![0],attempt_id:values![2],storage_path:values![3],sha256:values![4],content:values![6]});
      else savedDocx.push({id:values![0],attempt_id:values![2],storage_path:values![4],sha256:values![5],material_id:values![7]});
      return{rows:[],rowCount:1};
     }
     return{rows:[],rowCount:1};
    },
   };
   const pool={connect:async()=>dbClient,query:dbClient.query} as unknown as Pool;
   const authoringInput={
    materials:[{id:mdArtId,sha256:sha256(markdown)}],
    material_origin:{kind:'library_v1',material_mode:'redacted',material_processing_mode:'aliases',package_id:pkgId,revision_id:revId,redaction_id:redId,snapshot_digest:snapshotDigest},
   };

   const first=await exportCurrentMaterialDocx(pool,WF_A,storageRoot,exportsRoot,undefined,{expectedAuthoringInput:authoringInput,deliveryLayout:'combined'});
   expect(first.reused).toBe(false);
   expect(first.files).toHaveLength(1);
   expect(first.files[0]!.filename).toBe('脱敏材料.docx');
   expect(first.files[0]!.bytes.readUInt32LE(0)).toBe(0x04034b50);
   expect(JSON.parse(savedManifests[0]!.content).renderer_version).toBe(REDACTED_DOCX_RENDERER_VERSION);

   // 第二次同源导出：命中 reused 且跳过全部 INSERT/UPDATE/DELETE 数据库写操作
   writeSqlCount=0;
   const second=await exportCurrentMaterialDocx(pool,WF_A,storageRoot,exportsRoot,undefined,{expectedAuthoringInput:authoringInput,deliveryLayout:'combined'});
   expect(second.reused).toBe(true);
   expect(second.files).toHaveLength(1);
   expect(writeSqlCount).toBe(0);
  }finally{
   await rm(root,{recursive:true,force:true});
  }
 });

 test('syncLocalFeishu 复用共用交付会话：多题仅认证 1 次、校验表结构 1 次并完整对账通过',async()=>{
  clearFeishuDeliverySessionCache();
  const root=await mkdtemp(join(tmpdir(),'local-feishu-e2e-'));
  let authCalls=0,fieldCalls=0;
  const tableRows=new Map<string,any>();
  const uploadedNames=new Map<string,string>();

  const server=Bun.serve({
   hostname:'127.0.0.1',
   port:0,
   async fetch(req){
    const url=new URL(req.url);
    if(url.pathname.endsWith('/tenant_access_token/internal')){
     authCalls++;
     return Response.json({code:0,tenant_access_token:'local_tok',expire:7200});
    }
    if(url.pathname.endsWith('/fields')){
     fieldCalls++;
     return Response.json({code:0,data:{items:[
      ['题目ID',1],['飞书账号',11],['xpert uid',1],['专家来源',3],['一级行业',3],['L1职业簇',3],
      ['任务名称',1],['任务类型',1],['prompt',1],['输入附件',17],['考点rubric',1],['作答思路',1],
      ['标准答案-文本',1],['标准答案-附件',17],['题目是否完成',3],['系统同步ID',1],
     ].map(([field_name,type],i)=>({field_id:`fld_${i}`,field_name,type})),has_more:false}});
    }
    if(url.pathname.endsWith('/views')){
     return Response.json({code:0,data:{items:[],has_more:false}});
    }
    if(url.pathname.endsWith('/upload_all')){
     const form=await req.formData();
     const tok=`ftok_${uploadedNames.size+1}`;
     uploadedNames.set(tok,String(form.get('file_name')));
     return Response.json({code:0,data:{file_token:tok}});
    }
    if(url.pathname.endsWith('/records/search')){
     const body=await req.json() as any;
     const wf=body.filter.conditions[0].value[0];
     const items=[...tableRows.entries()].filter(([,f])=>f['题目ID']===wf).map(([record_id,fields])=>({record_id,fields}));
     return Response.json({code:0,data:{items,has_more:false}});
    }
    if(req.method==='POST'&&url.pathname.endsWith('/records')){
     const body=await req.json() as any;
     const recId=`rec_${tableRows.size+1}`;
     const fields={
      ...body.fields,
      '输入附件':body.fields['输入附件'].map((a:any)=>({file_token:a.file_token,name:uploadedNames.get(a.file_token)??'unknown.pdf'})),
     };
     tableRows.set(recId,fields);
     return Response.json({code:0,data:{record:{record_id:recId,fields}}});
    }
    if(req.method==='GET'&&url.pathname.endsWith('/records')){
     const items=[...tableRows.entries()].map(([record_id,fields])=>({record_id,fields}));
     return Response.json({code:0,data:{items,has_more:false}});
    }
    if(req.method==='GET'&&url.pathname.includes('/records/rec_')){
     const recId=url.pathname.split('/').at(-1)!;
     return Response.json({code:0,data:{record:{record_id:recId,fields:tableRows.get(recId)}}});
    }
    return Response.json({code:0,data:{}});
   },
  });

  const prevId=process.env.FEISHU_APP_ID,prevSec=process.env.FEISHU_APP_SECRET,prevBase=process.env.FEISHU_API_BASE_URL;
  process.env.FEISHU_APP_ID='cli_local_test';
  process.env.FEISHU_APP_SECRET='sec_local_test';
  process.env.FEISHU_API_BASE_URL=`http://127.0.0.1:${server.port}/open-apis`;
  try{
   const docxBytes=Buffer.from(await buildDocx('测试合同条款正文'));
   const docxPath=join(root,'001-借款合同.docx');
   await writeFile(docxPath,docxBytes);

   // 为两道题预置本地已验证 PDF 缓存，专注验证 syncLocalFeishu 会话复用与字段/附件对账闭环
   const fakePdf=Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
   for(const wf of [WF_A,WF_B]){
    const cacheDir=join(root,'local-pdf-cache','feishu-material-pdfs',wf);
    await mkdir(cacheDir,{recursive:true});
    const pdfPath=join(cacheDir,'0-借款合同.pdf');
    await writeFile(pdfPath,fakePdf);
    const cacheKey=sha256(JSON.stringify({
     version:'feishu-delivery-pdf-cache-v1',
     maxBytes:15_000_000,
     items:[{stem:'借款合同',size:docxBytes.byteLength,sha256:sha256(docxBytes)}],
    })).slice(0,24);
    await writeFile(join(cacheDir,`delivery-cache-${cacheKey}.json`),JSON.stringify({
     items:[{name:'借款合同.pdf',path:pdfPath,size:fakePdf.byteLength,sha256:sha256(fakePdf)}],
    }));
   }

   const manifestPath=join(root,'manifest.json');
   const receiptPath=join(root,'receipt.json');
   await writeFile(manifestPath,JSON.stringify({
    version:1,
    items:[
     {workflow_id:WF_A,question:SAMPLE_QUESTION,files:[{path:'001-借款合同.docx',sha256:sha256(docxBytes)}]},
     {workflow_id:WF_B,question:SAMPLE_QUESTION,files:[{path:'001-借款合同.docx',sha256:sha256(docxBytes)}]},
    ],
   }));

   const result=await syncLocalFeishu(manifestPath,receiptPath,{base_token:BASE,table_id:TABLE});
   expect(result.outcome).toBe('complete');
   expect(result.data.succeeded).toBe(2);
   expect(authCalls).toBe(1);
   expect(fieldCalls).toBe(1);
   expect(result.data.reconciliation).toMatchObject({missing:[],duplicates:[],non_pdf:[]});
  }finally{
   server.stop(true);
   if(prevId===undefined)delete process.env.FEISHU_APP_ID;else process.env.FEISHU_APP_ID=prevId;
   if(prevSec===undefined)delete process.env.FEISHU_APP_SECRET;else process.env.FEISHU_APP_SECRET=prevSec;
   if(prevBase===undefined)delete process.env.FEISHU_API_BASE_URL;else process.env.FEISHU_API_BASE_URL=prevBase;
   clearFeishuDeliverySessionCache();
   await rm(root,{recursive:true,force:true});
  }
 });

 test('真实中文多页 DOCX 转图像 PDF（含 >6 页多核分块栅格化）、毫秒级缓存命中与缓存防篡改校验',async()=>{
  const root=await mkdtemp(join(tmpdir(),'pdf-cache-tamper-'));
  try{
   const multiPageDocx=await buildDocx({
    format:'redacted-structure-v1',
    pages:Array.from({length:8},(_,i)=>({
     page:i+1,
     blocks:[
      {id:`h_${i}`,kind:'heading' as const,level:1,text:`案件证据卷第${i+1}组`},
      ...Array.from({length:8},(__,j)=>({
       id:`p_${i}_${j}`,
       kind:'paragraph' as const,
       text:`原告与被告签署补充协议第${i+1}.${j+1}条约定违约金计算基数为人民币壹佰贰拾万元整。`.repeat(8),
      })),
     ],
    })),
   });
   const files=[{bytes:multiPageDocx,filename:'001-证据卷宗.docx'}];
   expect(await peekCachedMaterialPdfNames(files,WF_C,root)).toBeUndefined();

   const cold=await materialPdfAttachments(files,WF_C,root);
   expect(cold).toHaveLength(1);
   expect(cold[0]!.name).toBe('证据卷宗.pdf');
   expect(cold[0]!.bytes.subarray(0,5).toString('utf8')).toBe('%PDF-');
   expect(await peekCachedMaterialPdfNames(files,WF_C,root)).toEqual(['证据卷宗.pdf']);

   const tWarm=performance.now();
   const warm=await materialPdfAttachments(files,WF_C,root);
   expect(performance.now()-tWarm).toBeLessThan(100);
   expect(Buffer.compare(warm[0]!.bytes,cold[0]!.bytes)).toBe(0);

   // 篡改磁盘缓存 PDF 末尾 1 字节：peek 必须立即失效返回 undefined，杜绝带毒缓存进入交付
   const cachedPdfPath=join(root,'feishu-material-pdfs',WF_C,'delivery-sources','0-证据卷宗.pdf');
   const tampered=Buffer.from(await readFile(cachedPdfPath));
   tampered[tampered.length-2]^=0xff;
   await writeFile(cachedPdfPath,tampered);
   expect(await peekCachedMaterialPdfNames(files,WF_C,root)).toBeUndefined();
  }finally{
   await rm(root,{recursive:true,force:true});
  }
 },60_000);

 test('无附件纯文本题目交付时，兼容真实飞书回读省略空的“输入附件”字段（undefined/null）',async()=>{
  clearFeishuDeliverySessionCache();
  let storedFields:Record<string,any>={};
  const clientFactory=async()=>({
   async close(){},
   async list(path:string){
    if(path.endsWith('/fields')){
     return[
      ['题目ID',1],['飞书账号',11],['xpert uid',1],['专家来源',3],['一级行业',3],['L1职业簇',3],
      ['任务名称',1],['任务类型',1],['prompt',1],['输入附件',17],['考点rubric',1],['作答思路',1],
      ['标准答案-文本',1],['标准答案-附件',17],['题目是否完成',3],['系统同步ID',1],
     ].map(([field_name,type],i)=>({field_id:`fld_${i}`,field_name,type}));
    }
    if(path.endsWith('/views'))return[{view_id:'vew_1',view_type:'grid'}];
    return[];
   },
   async call(path:string,method='GET',body?:any){
    if(path.includes('/views/'))return{view:{property:{hidden_fields:['fld_15']}}};
    if(path.includes('/records/search'))return{items:[]};
    if(method==='POST'&&path.includes('/records')){
     storedFields={...body.fields};
     delete storedFields['输入附件'];
     return{record:{record_id:'recNoFiles1',fields:storedFields}};
    }
    return{record:{record_id:'recNoFiles1',fields:storedFields}};
   },
   async download(){return new Uint8Array();},
  });
  const session=await createFeishuDeliverySession({clientFactory:clientFactory as any});
  const draft=await deliverQuestionToFeishu({
   workflowId:WF_A,
   question:SAMPLE_QUESTION,
   stage:'draft',
   target:{base_token:BASE,table_id:TABLE},
   attachmentFormat:'pdf',
   session,
   attachments:{
    knownCurrentNames:[],
    knownUpgradeableAttachmentFormat:()=>false,
    async prepare(){return{currentNames:[],payloads:[],isUpgradeableAttachmentFormat:()=>false};},
   },
  });
  expect(draft.status).toBe('succeeded');
  expect(draft.verification.status).toBe('passed');
  await session.close();
 });
});
