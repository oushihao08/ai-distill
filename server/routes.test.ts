import { test,expect,afterEach } from 'bun:test';
import type {Pool} from 'pg';
import{mkdtemp,rm,writeFile}from'node:fs/promises';
import{join}from'node:path';
import{tmpdir}from'node:os';
import{createApp}from'./app';
const id='11111111-1111-4111-8111-111111111111';
const dirs:string[]=[];
afterEach(async()=>{try{for(const dir of dirs.splice(0))await rm(dir,{recursive:true,force:true});}catch(error){throw error;}});
function setup(query:(sql:string,values?:unknown[])=>unknown|Promise<unknown>){
 const client={query:async(sql:string,values?:unknown[])=>{try{return await query(sql,values);}catch(error){throw error;}},release(){}};
 return createApp({query:client.query,connect:async()=>client}as unknown as Pool,dirs.at(-1)??'/unused');
}
const empty={rows:[],rowCount:0};
test('step-eight publication has an execution route and rejects incomplete prerequisites',async()=>{
 const app=setup(sql=>sql.startsWith('SELECT w.input_revision')?{rows:[{input_revision:1,project_id:id}],rowCount:1}:empty);
 expect((await app.request(`/api/workflows/${id}/publish`,{method:'POST'})).status).toBe(409);
});
test('authored question public package can be downloaded through the artifact whitelist',async()=>{
 const root=await mkdtemp(join(tmpdir(),'authoring-download-'));dirs.push(root);
 const body=JSON.stringify({question:'正式题面',rubric:[],quality_check:{passed:true}});await writeFile(join(root,'authoring.json'),body);
 const app=setup(sql=>sql.includes("'authored_question'")?{rows:[{kind:'authored_question',storage_path:'authoring.json'}],rowCount:1}:empty);
 const response=await app.request(`/api/artifacts/${id}/download`);
 expect(response.status).toBe(200);expect(await response.text()).toBe(body);expect(response.headers.get('Content-Disposition')).toContain('authoring.json');
});
test('health reports database availability and disables caching',async()=>{
 const good=await setup(()=>empty).request('/api/health');expect(good.status).toBe(200);expect(await good.json()).toEqual({database:'connected',phase:2});expect(good.headers.get('Cache-Control')).toBe('no-store');
 const bad=await setup(()=>{throw new Error('secret database URL');}).request('/api/health');expect(bad.status).toBe(503);expect(await bad.json()).toEqual({database:'unavailable',phase:2});
});
test('project creation validates JSON and trims input before persisting',async()=>{
 let saved:unknown[]|undefined;
 const root=await mkdtemp(join(tmpdir(),'create-project-'));dirs.push(root);
 const app=setup((sql,values)=>{if(sql.startsWith('INSERT INTO ai_distill.projects'))saved=values;return {rows:sql.startsWith('INSERT INTO ai_distill.projects')?[{id,name:values?.[1],description:values?.[2]}]:[],rowCount:1};});
 for(const body of ['{',JSON.stringify({name:''}),JSON.stringify({name:'x'.repeat(121)}),JSON.stringify({name:123}),JSON.stringify({name:'test',description:123})]){
  expect((await app.request('/api/projects',{method:'POST',headers:{'Content-Type':'application/json'},body})).status).toBe(400);
 }
 const good=await app.request('/api/projects',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:' test ',description:' text ',material_root:root})});expect(good.status).toBe(201);expect(saved?.slice(1,3)).toEqual(['test','text']);expect((await good.json()as any).name).toBe('test');
});
test('project listing and project detail return persisted rows',async()=>{
 const app=setup(sql=>sql.includes('FROM ai_distill.projects')?{rows:[{id,name:'project',workflow_count:2}],rowCount:1}:{rows:[{id,title:'workflow',material_count:2}],rowCount:1});
 expect((await(await app.request('/api/projects')).json()as any[])[0].workflow_count).toBe(2);
 const detail=await(await app.request(`/api/projects/${id}`)).json()as any;expect(detail.project.id).toBe(id);expect(detail.workflows[0].material_count).toBe(2);
});
test.each(['/api/projects/'+id,'/api/workflows/'+id,'/api/materials/'+id+'/download','/api/artifacts/'+id+'/download'])('missing record returns 404: %s',async path=>{expect((await setup(()=>empty).request(path)).status).toBe(404);});
test.each(['/api/projects/x','/api/workflows/x','/api/materials/x/download','/api/artifacts/x/download'])('malformed ID never reaches database: %s',async path=>{let calls=0;expect((await setup(()=>{calls++;return empty;}).request(path)).status).toBe(400);expect(calls).toBe(0);});
test('workflow detail hides internal rule binding and extraction stages',async()=>{
 const app=setup(sql=>{
  const positions:Record<number,number>={1:1,2:99,3:3,4:4,5:5,6:6,7:7,8:8,9:2};const rows=sql.includes('FROM ai_distill.workflows')?[{id,project_id:id}]:sql.includes('FROM ai_distill.materials')?[{id,size_bytes:'123'}]:sql.includes('FROM ai_distill.steps')?[1,2,3,4,5,6,7,8,9].map(ordinal=>({ordinal,display_position:positions[ordinal],implemented:ordinal===1,status:ordinal===1?'succeeded':'waiting'})).sort((a,b)=>a.display_position-b.display_position):sql.includes('FROM ai_distill.artifacts')?[{id,kind:'redacted_index'}]:[{id}];return{rows,rowCount:rows.length};
 });const d=await(await app.request(`/api/workflows/${id}`)).json()as any;expect(d.steps).toHaveLength(7);expect(d.steps.map((s:any)=>s.ordinal)).toEqual([1,9,4,5,6,7,8]);expect(d.steps.slice(2).every((s:any)=>!s.implemented&&s.status==='waiting')).toBe(true);expect(d.steps.map((s:any)=>s.display_position)).toEqual([1,2,3,4,5,6,7]);expect(d.materials[0].size_bytes).toBe(123);expect(d.artifacts[0].kind).toBe('redacted_index');
});
test('downloads stream exact bytes and correctly encode source names',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'route-test-'));dirs.push(dir);await writeFile(join(dir,'source.pdf'),'%PDF-test');await writeFile(join(dir,'materials.md'),'脱敏文本');
 const app=setup(sql=>({rows:[sql.includes('FROM ai_distill.materials')?{original_name:'中文卷宗.pdf',storage_path:'source.pdf'}:{kind:'redacted_markdown',storage_path:'materials.md'}],rowCount:1}));
 const source=await app.request(`/api/materials/${id}/download`);expect(source.status).toBe(200);expect(await source.text()).toBe('%PDF-test');expect(source.headers.get('Content-Disposition')).toContain(encodeURIComponent('中文卷宗.pdf'));expect(source.headers.get('Content-Type')).toBe('application/pdf');
 const artifact=await app.request(`/api/artifacts/${id}/download`);expect(artifact.status).toBe(200);expect(await artifact.text()).toBe('脱敏文本');expect(artifact.headers.get('Content-Disposition')).toContain('materials.md');
});
test('missing stored files return 404 rather than an empty success',async()=>{
 const app=setup(()=>({rows:[{original_name:'a.pdf',kind:'redacted_index',storage_path:'missing-file'}],rowCount:1}));for(const path of [`/api/materials/${id}/download`,`/api/artifacts/${id}/download`])expect((await app.request(path)).status).toBe(404);
});
test('unexpected database failures keep internal details out of API responses',async()=>{
 const r=await setup(()=>{throw new Error('secret key and SQL details');}).request('/api/projects');expect(r.status).toBe(500);expect(await r.text()).not.toContain('secret');
});
test('extraction API rejects missing workflow and incomplete intake',async()=>{
 expect((await setup(()=>empty).request(`/api/workflows/${id}/extract`,{method:'POST'})).status).toBe(404);
 const app=setup(sql=>sql.startsWith('SELECT input_revision')?{rows:[{input_revision:1}],rowCount:1}:sql.startsWith('SELECT ordinal')?{rows:[{status:'failed'}],rowCount:1}:empty);expect((await app.request(`/api/workflows/${id}/extract`,{method:'POST'})).status).toBe(409);
});
test('step four authoring route is wired and refuses incomplete current prerequisites',async()=>{
 const calls:string[]=[];const app=setup(sql=>{calls.push(sql);return sql.startsWith('SELECT w.* FROM ai_distill.workflows')?{rows:[{id,project_id:id,input_revision:1,rule_version_id:null}],rowCount:1}:sql.startsWith('SELECT ordinal,status')?{rows:[{ordinal:1,status:'succeeded'},{ordinal:3,status:'waiting'},{ordinal:9,status:'succeeded'}],rowCount:3}:empty;});
 const response=await app.request(`/api/workflows/${id}/author`,{method:'POST'});
 expect(response.status).toBe(409);expect(await response.json()).toMatchObject({error:'请先冻结当前项目资料与skill版本'});expect(calls.some(sql=>sql.startsWith('INSERT INTO ai_distill.step_attempts'))).toBe(false);
});
test('step four is accepted by the batch route and reports unready prerequisites',async()=>{
 const app=setup(sql=>sql.startsWith('SELECT id FROM ai_distill.projects')?{rows:[{id}],rowCount:1}:sql.startsWith('SELECT id,project_id FROM ai_distill.workflows')?{rows:[{id,project_id:id}],rowCount:1}:sql.startsWith('SELECT CASE WHEN s.ordinal=1')?{rows:[{status:'waiting',active:false,previous_status:'waiting'}],rowCount:1}:empty);
 const response=await app.request(`/api/projects/${id}/steps/4/run-batch`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
 expect(response.status).toBe(202);expect(await response.json()).toMatchObject({results:[{workflow_id:id,status:'not_ready',reason:'此题目未就绪或此步骤已完成'}]});
});
test('rule binding is no longer exposed as a standalone workflow route or batch step',async()=>{
 const app=setup(()=>empty);
 expect((await app.request(`/api/workflows/${id}/load-rules`,{method:'POST'})).status).toBe(404);
 const response=await app.request(`/api/projects/${id}/steps/3/run-batch`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
 expect(response.status).toBe(400);
});
test('rule mutation parameters are validated before touching files or database',async()=>{
 let calls=0;const app=setup(()=>{calls++;return empty;});const request={method:'POST',headers:{'Content-Type':'application/json'}};
 expect((await app.request(`/api/projects/${id}/rules/publish`,{...request,body:'{}'})).status).toBe(400);
 expect((await app.request(`/api/projects/${id}/rules/register`,{...request,body:JSON.stringify({workspace_path:'relative'})})).status).toBe(400);
 expect((await app.request(`/api/projects/${id}/rules/file`,{method:'PUT',headers:request.headers,body:JSON.stringify({path:'materials/标准.md',text:'新标准'})})).status).toBe(400);
 expect(calls).toBe(0);
});
test('attempt status reports the persisted result and input version',async()=>{
 const app=setup(sql=>sql.startsWith('SELECT a.id,a.workflow_id')?{rows:[{id,workflow_id:id,ordinal:2,status:'succeeded',input_revision:1,current_input_revision:1,result:{pages:[{page:1}]},error:null}],rowCount:1}:empty);
 const response=await app.request(`/api/attempts/${id}`);
 expect(response.status).toBe(200);
 expect(await response.json()).toMatchObject({id,status:'succeeded',completed:true,input_revision:1,result:{pages:[{page:1}]}});
});
test('synchronous extraction waits for the same queued attempt without creating another',async()=>{
 let reads=0,inserts=0;
 const app=setup((sql)=>{
  if(sql.startsWith('SELECT input_revision'))return{rows:[{input_revision:1}],rowCount:1};
  if(sql.startsWith('SELECT ordinal,status'))return{rows:[{status:'succeeded'}],rowCount:1};
  if(sql.startsWith('SELECT id FROM ai_distill.step_attempts'))return{rows:[{id}],rowCount:1};
  if(sql.startsWith('INSERT INTO ai_distill.step_attempts'))inserts++;
  if(sql.startsWith('SELECT a.id,a.workflow_id'))return{rows:[{id,status:++reads===1?'running':'succeeded',result:reads>1?{pages:1}:null}],rowCount:1};
  return empty;
 });
 const response=await app.request(`/api/workflows/${id}/extract?wait_ms=1000`,{method:'POST'});
 expect(response.status).toBe(200);
 expect(await response.json()).toMatchObject({id,reused:true,status:'succeeded',completed:true,result:{pages:1}});
 expect(inserts).toBe(0);expect(reads).toBe(2);
});
test('synchronous timeout returns the attempt ID and leaves the queued job intact',async()=>{
 const calls:string[]=[];
 const app=setup(sql=>{
  calls.push(sql);
  if(sql.startsWith('SELECT input_revision'))return{rows:[{input_revision:1}],rowCount:1};
  if(sql.startsWith('SELECT ordinal,status'))return{rows:[{status:'succeeded'}],rowCount:1};
  if(sql.startsWith('SELECT id FROM ai_distill.step_attempts'))return{rows:[{id}],rowCount:1};
  if(sql.startsWith('SELECT a.id,a.workflow_id'))return{rows:[{id,status:'waiting',result:null}],rowCount:1};
  return empty;
 });
 const response=await app.request(`/api/workflows/${id}/extract?wait_ms=2`,{method:'POST'});
 expect(response.status).toBe(202);expect(await response.json()).toMatchObject({id,status:'waiting',completed:false});
 expect(calls.some(sql=>sql.startsWith('UPDATE'))).toBe(false);
});
test.each(['-1','30001','NaN','1.5'])('invalid wait duration is rejected before enqueue: %s',async wait=>{
 let calls=0;
 const app=setup(()=>{calls++;return empty;});
 expect((await app.request(`/api/workflows/${id}/extract?wait_ms=${wait}`,{method:'POST'})).status).toBe(400);
 expect(calls).toBe(0);
});
test('disconnecting a wait neither cancels nor rewrites its persisted task',async()=>{
 const controller=new AbortController();const calls:string[]=[];
 const app=setup(sql=>{calls.push(sql);controller.abort();return{rows:[{id,status:'running'}],rowCount:1};});
 const response=await app.fetch(new Request(`http://localhost/api/attempts/${id}?wait_ms=1000`,{signal:controller.signal}));
 expect(response.status).toBe(408);expect(calls).toHaveLength(1);expect(calls[0]).toStartWith('SELECT');
});
test('project batch queues each ready workflow once and isolates unready or missing records',async()=>{
 const ready='22222222-2222-4222-8222-222222222222';
 const unready='33333333-3333-4333-8333-333333333333';
 const app=setup((sql,values)=>{
  if(sql.startsWith('SELECT id FROM ai_distill.projects'))return{rows:[{id}],rowCount:1};
  if(sql.startsWith('SELECT id,project_id FROM ai_distill.workflows'))return{rows:[{id:ready,project_id:id},{id:unready,project_id:id}],rowCount:2};
  if(sql.startsWith('SELECT s.status,prev.status'))return {rows:[{status:'waiting',previous_status:values?.[0]===unready?'failed':'succeeded'}],rowCount:1};
  if(sql.startsWith('SELECT input_revision'))return{rows:[{input_revision:1}],rowCount:1};
  if(sql.startsWith('SELECT ordinal,status FROM ai_distill.steps'))return{rows:[{ordinal:1,status:values?.[0]===unready?'failed':'succeeded'},{ordinal:2,status:'waiting'}],rowCount:2};
  if(sql.startsWith('SELECT id FROM ai_distill.step_attempts'))return{rows:[],rowCount:0};
  return{rows:[],rowCount:1};
 });
 const response=await app.request(`/api/projects/${id}/steps/2/run-batch`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({workflow_ids:[ready,ready,unready,'44444444-4444-4444-8444-444444444444']})});
 expect(response.status).toBe(202);
 expect(await response.json()).toEqual({results:[
  {workflow_id:ready,status:'queued',attempt_id:expect.any(String),reused:false},
  {workflow_id:unready,status:'not_ready',reason:'此题目未就绪或此步骤已完成'},
  {workflow_id:'44444444-4444-4444-8444-444444444444',status:'not_found'},
 ]});
});
test('batch endpoint validates step number, workflow IDs, and batch size',async()=>{
 const app=setup(()=>empty);
 const base={method:'POST',headers:{'Content-Type':'application/json'}};
 expect((await app.request(`/api/projects/${id}/steps/7/run-batch`,{...base,body:'{}'})).status).toBe(404);
 expect((await app.request(`/api/projects/${id}/steps/2/run-batch`,{...base,body:JSON.stringify({workflow_ids:['bad']})})).status).toBe(400);
 expect((await app.request(`/api/projects/${id}/steps/2/run-batch`,{...base,body:JSON.stringify({workflow_ids:Array.from({length:101},(_,i)=>`${String(i+1).padStart(8,'0')}-0000-4000-8000-000000000000`)})})).status).toBe(400);
});
test('unknown endpoint is 404 and excessive request body is 413',async()=>{
 const app=setup(()=>empty);expect((await app.request('/api/unknown')).status).toBe(404);
 expect((await app.request('/api/projects',{method:'POST',headers:{'Content-Type':'application/json','Content-Length':String(103*1024*1024)},body:'{}'})).status).toBe(413);
});
test('a 100-question batch queues exactly the 99 whose previous step succeeded',async()=>{
 const workflowIds=Array.from({length:100},(_,i)=>`${String(i+1).padStart(8,'0')}-0000-4000-8000-000000000000`);
 let inserted=0;
 const app=setup((sql,values)=>{
  if(sql.startsWith('SELECT id FROM ai_distill.projects'))return{rows:[{id}],rowCount:1};
  if(sql.startsWith('SELECT id,project_id FROM ai_distill.workflows'))return{rows:workflowIds.map(flow=>({id:flow,project_id:id})),rowCount:100};
  if(sql.startsWith('SELECT s.status,prev.status'))return{rows:[{status:'waiting',previous_status:values?.[0]===workflowIds[99]?'running':'succeeded'}],rowCount:1};
  if(sql.startsWith('SELECT input_revision'))return{rows:[{input_revision:1}],rowCount:1};
  if(sql.startsWith('SELECT ordinal,status'))return{rows:[{ordinal:1,status:'succeeded'},{ordinal:2,status:'waiting'}],rowCount:2};
  if(sql.startsWith('INSERT INTO ai_distill.step_attempts'))inserted++;
  return{rows:[],rowCount:0};
 });
 const result=await(await app.request(`/api/projects/${id}/steps/2/run-batch`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).json()as any;
 expect(result.results.filter((r:any)=>r.status==='queued')).toHaveLength(99);
 expect(result.results.filter((r:any)=>r.status==='not_ready')).toHaveLength(1);
 expect(inserted).toBe(99);
});
test('project skill generation rejects malformed requests before dispatch and lists only live projects',async()=>{
 const calls:string[]=[];const app=setup(sql=>{calls.push(sql);return empty;});
 expect((await app.request(`/api/projects/${id}/skill/generate`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{'})).status).toBe(400);
 expect(calls).toEqual([]);
 expect((await app.request('/api/projects/not-a-uuid/skill/attempts')).status).toBe(400);
 expect((await app.request(`/api/projects/${id}/skill/attempts`)).status).toBe(404);
});
