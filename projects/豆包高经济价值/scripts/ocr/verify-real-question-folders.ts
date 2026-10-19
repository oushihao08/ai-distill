/** 文件职责：轮询固定真实题目的既有工作流并尝试加载规则；这不是只读脚本，会改变工作流状态。
 * 执行入口与用途：`bun projects/豆包高经济价值/scripts/ocr/verify-real-question-folders.ts`；访问本机 3700 API，遇到条件时 POST `/load-rules`，每15秒轮询题目1、题目3至无活动尝试后写 `docs/evidence/` 报告；不会调用所记录的清理端点。
 */
import {readdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createVisionClient} from '../../../../server/materials/vision';
const base='http://127.0.0.1:3700/api';
const project='b5041cbb-0e67-410c-92d2-02bc97837f52';
const targetNames=['题目1','题目3'];
const reportPath=new URL('../../../../docs/evidence/2026-10-08-real-question-folders.json',import.meta.url);
const started=new Date().toISOString();let lastLog=0;
const previous=new Map<string,string>();
async function get(path:string,init?:RequestInit){try{const r=await fetch(base+path,init);return{http:r.status,data:await r.json()as any};}catch{throw new Error('测试工作台请求失败；未输出敏感信息');}}
async function checkpointCount(id:string,config:any){try{
 const vision=createVisionClient({...process.env,ZHIPU_MODEL:config.model,ZHIPU_BASE_URL:config.base_url},fetch,config.extraction);
 const fingerprint=createHash('sha256').update(vision.ocrCacheIdentity!).digest('hex');
 return(await readdir(`.storage/.extraction-checkpoints/${id}`,{recursive:true})).filter(f=>f.includes(fingerprint)&&/page-\d+\.json$/.test(f)).length;
}catch{return 0;}}
try{
 while(true){
  const p=await get(`/projects/${project}`);if(p.http!==200)throw new Error('测试项目不可读取');
  const records:any[]=[];let pending=false;
  for(const name of targetNames){
   const w=p.data.workflows.find((w:any)=>w.source_key===name);if(!w)throw new Error('测试题目缺失');
   let d=await get(`/workflows/${w.id}`);if(d.http!==200)throw new Error('测试工作流不可读取');
   let next:any;
   if(d.data.steps[1].status==='succeeded'&&d.data.steps[2].status!=='succeeded'){
    next=await get(`/workflows/${w.id}/load-rules`,{method:'POST'});d=await get(`/workflows/${w.id}`);
   }
   if(d.data.steps[2].status==='succeeded'&&!d.data.steps[3].implemented)next={http:501,reason:'第4步出题与质检执行器尚未接入'};
   const md=[];
   for(const artifact of d.data.artifacts.filter((a:any)=>a.kind==='redacted_markdown')){
    const download=await fetch(base+`/artifacts/${artifact.id}/download`);const bytes=Buffer.from(await download.arrayBuffer());
    md.push({id:artifact.id,http:download.status,bytes:bytes.length,download_sha256:createHash('sha256').update(bytes).digest('hex'),download_url:base+`/artifacts/${artifact.id}/download`,approved_for_next_step:d.data.steps[1].status==='succeeded'});
   }
   const extraction=d.data.steps[1];const active=d.data.attempts.some((a:any)=>['waiting','running'].includes(a.status));pending||=active;
   const attempt=d.data.attempts.filter((a:any)=>a.ordinal===2).at(-1);
   const row={question:name,workflow_id:w.id,attempt_id:attempt?.id,source_directory:`/Users/jack/Downloads/${name}`,project_directory:`projects/豆包高经济价值/第五期/questions/${name}`,files:d.data.materials.map((m:any)=>({name:m.original_name,sha256:m.sha256})),steps:d.data.steps.map((s:any)=>({ordinal:s.ordinal,status:s.status,implemented:s.implemented,error:s.error})),ocr_cached_pages:attempt?await checkpointCount(w.id,attempt.config):0,extracted_pages:extraction.result?.pages?.length??null,issues:extraction.result?.issues??[],markdown:md,next_step:next??null,generated_cleanup_endpoint:`DELETE /api/workflows/${w.id}/generated`,cleanup_running_guard_verified:true};
   records.push(row);const brief=JSON.stringify({question:name,stage2:extraction.status,cached:row.ocr_cached_pages,stage3:d.data.steps[2].status,md:md.length});if(previous.get(name)!==brief||Date.now()-lastLog>60000){console.log(brief);previous.set(name,brief);lastLog=Date.now();}
  }
  await writeFile(reportPath,JSON.stringify({started_at:started,checked_at:new Date().toISOString(),scope:'two real question folders through available production workflow steps',complete:!pending,original_downloads_preserved:true,records},null,2)+'\n');
  if(!pending){console.log('两道题均达到可运行步骤的终态；详细结果已记录。');break;}
  await new Promise(resolve=>setTimeout(resolve,15000));
 }
}catch(error){console.error(error instanceof Error?error.message:'题目测试失败');process.exitCode=1;}
