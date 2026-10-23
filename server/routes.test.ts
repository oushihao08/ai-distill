/** HTTP 路由契约：覆盖项目与工作流读写、步骤派发前置、入库等待、产物下载、规则绑定隐藏、错误净化及服务健康状态。
 * 边界：使用Hono内存请求、注入SQL/派发器及临时文件，不证明真实网络、数据库或模型流程。
 * 运行方式：由 Bun test 收集本文件用例；修改对应模块时针对该文件回归验证。
 */
import { test,expect,beforeEach,afterEach } from 'bun:test';
import type {Pool} from 'pg';
import{mkdir,mkdtemp,readFile,readdir,realpath,rm,writeFile}from'node:fs/promises';
import{join}from'node:path';
import{tmpdir}from'node:os';
import{createApp}from'./app';
import{Hono}from'hono';
import{registerWorkflowExecutionRoutes}from'./workflow-execution-routes';
import{waitForAttempt}from'./attempts';
import type{WorkflowStepOrdinal,StepDispatchTask}from'./step-dispatch';
import type{WorkflowStepState}from'./project-folders';
import{createHash}from'node:crypto';
import{redactionInputDigest}from'./materials/redaction-jobs';
import{scanProjectPrompt}from'./rule-files';
const id='11111111-1111-4111-8111-111111111111';
const dirs:string[]=[];
// createApp reads local concurrency settings; each test needs a writable isolated root.
beforeEach(async()=>{try{dirs.push(await mkdtemp(join(tmpdir(),'ai-distill-routes-')));}catch(error){throw error;}});
afterEach(async()=>{try{for(const dir of dirs.splice(0))await rm(dir,{recursive:true,force:true});}catch(error){throw error;}});
function setup(query:(sql:string,values?:unknown[])=>unknown|Promise<unknown>){
 const client={query:async(sql:string,values?:unknown[])=>{try{return await query(sql,values);}catch(error){throw error;}},release(){}};
 return createApp({query:client.query,connect:async()=>client}as unknown as Pool,dirs.at(-1)!);
}
function setupExecutionRoutes(repository:{projectExists:(projectId:string)=>Promise<boolean>;selectWorkflows:(projectId:string,workflowIds?:string[])=>Promise<{id:string;project_id:string}[]>;readStepStates:(projectId:string,workflowIds:string[])=>Promise<(WorkflowStepState&{workflow_id:string})[]>},dispatch:(workflowId:string,ordinal:WorkflowStepOrdinal,context?:{delivery_identity:{task_id:string;org:string}})=>Promise<StepDispatchTask>,batchChunkSize=100,wait?:typeof waitForAttempt){
 const app=new Hono();
 registerWorkflowExecutionRoutes(app,{pool:{} as Pool,repository,dispatch,batchChunkSize,...(wait?{waitForAttempt:wait}:{})});
 return app;
}
const empty={rows:[],rowCount:0};
test('Work archive passes only validated external identity to the archive handler',async()=>{
 let received:unknown;
 const app=setupExecutionRoutes({projectExists:async()=>true,selectWorkflows:async()=>[],readStepStates:async()=>[]},async(_workflowId,_ordinal,context)=>{received=context;return{id,completed:true};});
 const valid=await app.request(`/api/workflows/${id}/publish`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({delivery_identity:{task_id:'LAW-012',org:'org-legal'}})});
 expect(valid.status).toBe(200);expect(received).toEqual({delivery_identity:{task_id:'LAW-012',org:'org-legal'}});
 const custom=await app.request(`/api/workflows/${id}/publish`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({delivery_identity:{task_id:'CUSTOM-42',org:'Project-B'}})});expect(custom.status).toBe(200);expect(received).toEqual({delivery_identity:{task_id:'CUSTOM-42',org:'Project-B'}});
 for(const identity of [{task_id:'',org:'org-legal'},{task_id:'LAW-012',org:''},{task_id:'LAW-012',org:'org-legal',extra:'x'}])expect((await app.request(`/api/workflows/${id}/publish`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({delivery_identity:identity})})).status).toBe(400);
});
test('step-eight publication has an execution route and rejects incomplete prerequisites',async()=>{
 const app=setup(sql=>sql.startsWith('SELECT workflow_kind,source_workflow_id')?{rows:[{workflow_kind:'question',source_workflow_id:null}],rowCount:1}:sql.startsWith('SELECT w.project_id')?{rows:[{project_id:id}],rowCount:1}:empty);
 expect((await app.request(`/api/workflows/${id}/publish`,{method:'POST'})).status).toBe(409);
});
test('authored question public package can be downloaded through the artifact whitelist',async()=>{
 const root=await mkdtemp(join(tmpdir(),'authoring-download-'));dirs.push(root);
 const body=JSON.stringify({question:'正式题面',rubric:[],quality_check:{passed:true}});await writeFile(join(root,'authoring.json'),body);
 const app=setup(sql=>sql.includes("'authored_question'")?{rows:[{kind:'authored_question',storage_path:'authoring.json'}],rowCount:1}:empty);
 const response=await app.request(`/api/artifacts/${id}/download`);
 expect(response.status).toBe(200);expect(await response.text()).toBe(body);expect(response.headers.get('Content-Disposition')).toContain('authoring.txt');
});
test('health reports database availability and disables caching',async()=>{
 const names=(await readdir(new URL('../migrations/',import.meta.url))).filter(name=>name.endsWith('.sql'));
 const statements:string[]=[];
 const good=await setup(sql=>{statements.push(sql);return sql.startsWith('SELECT name FROM ai_distill.schema_migrations')?{rows:names.map(name=>({name})),rowCount:names.length}:empty;}).request('/api/health');expect(good.status).toBe(200);expect(await good.json()).toMatchObject({database:'connected',schema:'ready',phase:2});expect(good.headers.get('Cache-Control')).toBe('no-store');expect(statements).toHaveLength(1);
 const bad=await setup(()=>{throw new Error('secret database URL');}).request('/api/health');expect(bad.status).toBe(503);expect(await bad.json()).toMatchObject({database:'unavailable',schema:'unavailable',phase:2});
});
test('monitor starts active workflow and material library reads concurrently',async()=>{
 let started=0,releaseReads!:()=>void;
 const readGate=new Promise<void>(resolve=>{releaseReads=resolve;});
 const app=setup(sql=>{
  if(sql.includes('FROM ai_distill.step_attempts a JOIN ai_distill.workflows')){started++;return readGate.then(()=>({rows:[],rowCount:0}));}
  if(sql.includes("to_regclass('ai_distill.library_jobs')")){started++;return readGate.then(()=>({rows:[{available:false}],rowCount:1}));}
  return empty;
 });
 const pending=app.request('/api/monitor');
 await new Promise(resolve=>setTimeout(resolve,0));
 const startedBeforeRelease=started;
 releaseReads();
 const response=await pending;
 expect(startedBeforeRelease).toBe(2);
 expect(response.status).toBe(200);
});
test('project group phase listing starts group and phase reads concurrently',async()=>{
 let started=0,releaseReads!:()=>void;
 const readGate=new Promise<void>(resolve=>{releaseReads=resolve;});
 const app=setup(sql=>{
  if(sql.startsWith('SELECT id,name,created_at FROM ai_distill.project_groups')){started++;return readGate.then(()=>({rows:[{id,name:'group'}],rowCount:1}));}
  if(sql.startsWith('SELECT p.*,count(w.id)::int AS workflow_count')){started++;return readGate.then(()=>({rows:[],rowCount:0}));}
  return empty;
 });
 const pending=app.request(`/api/project-groups/${id}/phases`);
 await new Promise(resolve=>setTimeout(resolve,0));
 const startedBeforeRelease=started;
 releaseReads();
 const response=await pending;
 expect(startedBeforeRelease).toBe(2);
 expect(response.status).toBe(200);
});
test('project export listing starts project and export reads concurrently',async()=>{
 let started=0,releaseReads!:()=>void;
 const readGate=new Promise<void>(resolve=>{releaseReads=resolve;});
 const app=setup(sql=>{
  if(sql.startsWith('SELECT id FROM ai_distill.projects')){started++;return readGate.then(()=>({rows:[{id}],rowCount:1}));}
  if(sql.startsWith('SELECT id,batch,status,sha256,workflow_count,error,created_at,finished_at FROM ai_distill.project_exports')){started++;return readGate.then(()=>({rows:[],rowCount:0}));}
  return empty;
 });
 const pending=app.request(`/api/projects/${id}/exports`);
 await new Promise(resolve=>setTimeout(resolve,0));
 const startedBeforeRelease=started;
 releaseReads();
 const response=await pending;
 expect(startedBeforeRelease).toBe(2);
 expect(response.status).toBe(200);
 expect(await response.json()).toEqual([]);
});
test('answer generation policy reads project and config in one scoped query',async()=>{
 const statements:string[]=[];
 const app=setup(sql=>{statements.push(sql);if(sql.includes('LEFT JOIN ai_distill.project_step_configs'))return{rows:[{id,config:{}}],rowCount:1};return empty;});
 const response=await app.request(`/api/projects/${id}/answer-generation-policy`);
 expect(response.status).toBe(200);
 expect(await response.json()).toMatchObject({source:'default'});
 expect(statements).toHaveLength(1);
 expect(statements[0]).toContain('ordinal=5');
 const missing=await setup(()=>empty).request(`/api/projects/${id}/answer-generation-policy`);
 expect(missing.status).toBe(404);
});
test('project creation validates JSON and trims input before persisting',async()=>{
 let saved:unknown[]|undefined;
 const root=await mkdtemp(join(tmpdir(),'create-project-'));dirs.push(root);
 const app=setup((sql,values)=>{if(sql.startsWith('INSERT INTO ai_distill.project_groups'))return{rows:[{id:'55555555-5555-4555-8555-555555555555',name:values?.[1],deleted_at:null}],rowCount:1};if(sql.startsWith('INSERT INTO ai_distill.projects'))saved=values;return {rows:sql.startsWith('INSERT INTO ai_distill.projects')?[{id,name:values?.[1],description:values?.[2]}]:[],rowCount:1};});
 for(const body of ['{',JSON.stringify({name:''}),JSON.stringify({name:'x'.repeat(121)}),JSON.stringify({name:123}),JSON.stringify({name:'test',description:123})]){
  expect((await app.request('/api/projects',{method:'POST',headers:{'Content-Type':'application/json'},body})).status).toBe(400);
 }
 const good=await app.request('/api/projects',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:' test ',description:' text ',material_backend:'legacy',material_root:root})});expect(good.status).toBe(201);expect(saved?.slice(1,3)).toEqual(['test','text']);expect(saved?.[12]).toBeNull();expect((await good.json()as any).name).toBe('test');
});
test('project creation records the parent and phase and reuses that parent skill path',async()=>{
 const root=await mkdtemp(join(tmpdir(),'create-project-phase-'));dirs.push(root);
 const materialRoot=join(root,'第五期','questions'),skillPath=join(root,'skill');await mkdir(materialRoot,{recursive:true});await mkdir(skillPath,{recursive:true});
 let inserted:unknown[]|undefined;
 const app=setup((sql,values)=>{
  if(sql.startsWith('SELECT DISTINCT local_skill_path FROM ai_distill.projects'))return{rows:[{local_skill_path:skillPath}],rowCount:1};
  if(sql.startsWith('INSERT INTO ai_distill.project_groups'))return{rows:[{id:'55555555-5555-4555-8555-555555555555',name:values?.[1],deleted_at:null}],rowCount:1};
  if(sql.startsWith('INSERT INTO ai_distill.projects')){inserted=values;return{rows:[{id,name:values?.[1],parent_name:values?.[5],phase_name:values?.[6],local_skill_path:values?.[4]}],rowCount:1};}
  return empty;
 });
 const response=await app.request('/api/projects',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'豆包高经济价值 - 第五期',parent_name:'豆包高经济价值',phase_name:'第五期',material_backend:'legacy',material_root:materialRoot})});
 expect(response.status).toBe(201);
 expect(inserted?.slice(5,7)).toEqual(['豆包高经济价值','第五期']);
 expect(inserted?.[4]).toBe(skillPath);
 expect(inserted?.[12]).toBeNull();
});
test('project listing and project detail return persisted rows',async()=>{
 const app=setup(sql=>sql.includes('FROM ai_distill.projects')?{rows:[{id,name:'project',workflow_count:2}],rowCount:1}:{rows:[{id,title:'workflow',material_count:2}],rowCount:1});
 expect((await(await app.request('/api/projects')).json()as any[])[0].workflow_count).toBe(2);
 const detail=await(await app.request(`/api/projects/${id}`)).json()as any;expect(detail.project.id).toBe(id);expect(detail.workflows[0].material_count).toBe(2);
});
test('project detail shares one step-state read with the question table projection',async()=>{
 const workflowId='22222222-2222-4222-8222-222222222222',calls:string[]=[];
 const app=setup(sql=>{
  calls.push(sql);
  if(sql.includes('FROM ai_distill.projects p LEFT JOIN ai_distill.system_codex_config'))return{rows:[{id,name:'project',local_skill_path:'/nonexistent',material_backend:'legacy',codex_model:null,codex_reasoning_effort:null,__system_codex_model:'gpt-6-luna',__system_codex_reasoning_effort:'medium'}],rowCount:1};
  if(sql.startsWith('SELECT w.id,w.project_id,w.title'))return{rows:[{id:workflowId,has_authored:true}],rowCount:1};
  if(sql.startsWith('SELECT COALESCE(jsonb_agg(to_jsonb(state_rows))'))return{rows:[{items:[
   {workflow_id:workflowId,workflow_kind:'question',source_workflow_id:null,library_source:false,ordinal:4,status:'succeeded',error:null,started_at:null,finished_at:null,result:null,implemented:true,enabled:true,has_pdf:false,extraction_status:null,active:false},
   {workflow_id:workflowId,workflow_kind:'question',source_workflow_id:null,library_source:false,ordinal:5,status:'waiting',error:null,started_at:null,finished_at:null,result:null,implemented:true,enabled:true,has_pdf:false,extraction_status:null,active:false},
  ]}],rowCount:1};
  if(sql.startsWith('SELECT ordinal,config FROM ai_distill.project_step_configs'))return{rows:[],rowCount:0};
  return empty;
 });
 const response=await app.request(`/api/projects/${id}`),body=await response.json()as any;
 expect(response.status).toBe(200);
 expect(body.workflow_status[workflowId].attempt_summary).toEqual({has_authored:true});
 expect(body.workflow_status[workflowId].steps.map((step:any)=>step.ordinal)).toEqual([4,5]);
 expect(calls.filter(sql=>sql.startsWith('SELECT COALESCE(jsonb_agg(to_jsonb(state_rows))'))).toHaveLength(1);
 expect(calls.filter(sql=>sql.includes('LEFT JOIN ai_distill.system_codex_config'))).toHaveLength(1);
 expect(calls.some(sql=>sql.startsWith('SELECT credential_home,model,reasoning_effort'))).toBe(false);
 expect(body.project).not.toHaveProperty('__system_codex_model');
});
test('project detail starts independent workflow and step reads before project lookup resolves',async()=>{
 let releaseProject!:(value:unknown)=>void,workflowStarted=false,stepSummaryStarted=false;
 const projectPending=new Promise(resolve=>{releaseProject=resolve;});
 const app=setup(sql=>{
  if(sql.includes('FROM ai_distill.projects p LEFT JOIN ai_distill.system_codex_config'))return projectPending;
  if(sql.startsWith('SELECT codex_model,codex_reasoning_effort FROM ai_distill.projects'))return{rows:[{codex_model:null,codex_reasoning_effort:null}],rowCount:1};
  if(sql.startsWith('SELECT w.id,w.project_id,w.title')){workflowStarted=true;return{rows:[],rowCount:0};}
  if(sql.startsWith('SELECT COALESCE(jsonb_agg(to_jsonb(state_rows))')){stepSummaryStarted=true;return{rows:[{items:[]}],rowCount:1};}
  return empty;
 });
 const responsePending=app.request(`/api/projects/${id}`);
 await new Promise(resolve=>setTimeout(resolve,0));
 expect(workflowStarted).toBe(true);expect(stepSummaryStarted).toBe(true);
 releaseProject({rows:[{id,name:'project',local_skill_path:'/nonexistent',material_backend:'legacy'}],rowCount:1});
 expect((await responsePending).status).toBe(200);
});
test('changing the project skill path invalidates current archive and exports',async()=>{
 const root=await mkdtemp(join(tmpdir(),'project-skill-binding-'));dirs.push(root);
 const oldSkill=join(root,'old-skill'),newSkill=join(root,'new-skill');await mkdir(oldSkill);await mkdir(newSkill);
 const previous={id,name:'项目',description:'',material_root:root,local_skill_path:oldSkill},updated={...previous,local_skill_path:newSkill};
 const statements:string[]=[];
 const app=setup((sql)=>{statements.push(sql);if(sql.startsWith('SELECT * FROM ai_distill.projects WHERE id=$1'))return{rows:[previous],rowCount:1};if(sql.startsWith('UPDATE ai_distill.projects SET name='))return{rows:[updated],rowCount:1};return{rows:[],rowCount:1};});
 const response=await app.request(`/api/projects/${id}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'项目',description:'',material_root:root,local_skill_path:newSkill})});
 expect(response.status).toBe(200);
 expect(statements.some(sql=>sql.includes("UPDATE ai_distill.project_exports SET status='stale'"))).toBe(true);
 expect(statements.some(sql=>sql.includes('UPDATE ai_distill.steps')||sql.startsWith('UPDATE ai_distill.step_attempts'))).toBe(false);
});
test('moving a legacy period into a shared project keeps the target project skill path',async()=>{
 const tempRoot=await mkdtemp(join(tmpdir(),'project-period-move-'));dirs.push(tempRoot);const root=await realpath(tempRoot),oldSkill=join(root,'old-skill'),sharedSkill=join(root,'shared-skill');await mkdir(oldSkill);await mkdir(sharedSkill);
 const previous={id,name:'旧项目 - 第五期',description:'',material_root:root,local_skill_path:oldSkill,parent_name:'旧项目 - 第五期',phase_name:''},updated={...previous,name:'统一项目 - 第五期',local_skill_path:sharedSkill,parent_name:'统一项目',phase_name:'第五期'};const updates:unknown[][]=[];
 const app=setup((sql,values)=>{if(sql.startsWith('SELECT * FROM ai_distill.projects WHERE id=$1'))return{rows:[previous],rowCount:1};if(sql.startsWith('SELECT DISTINCT local_skill_path'))return{rows:[{local_skill_path:sharedSkill}],rowCount:1};if(sql.startsWith('UPDATE ai_distill.projects SET name='))return{rows:[updated],rowCount:1};if(sql.startsWith('UPDATE ai_distill.projects SET local_skill_path='))updates.push(values??[]);return empty;});
 const response=await app.request(`/api/projects/${id}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'统一项目 - 第五期',parent_name:'统一项目',phase_name:'第五期',description:'',material_root:root,local_skill_path:oldSkill})});
 expect(response.status).toBe(200);expect((await response.json()as any).local_skill_path).toBe(sharedSkill);expect(updates).toContainEqual(['统一项目',sharedSkill]);
});
test('export download follows the frozen skill snapshot after the live skill changes',async()=>{
 const root=dirs.at(-1)!,skill=join(root,'skill'),exportId='22222222-2222-4222-8222-222222222222',workbook=Buffer.from('xlsx fixture');
 await mkdir(skill);await writeFile(join(skill,'SKILL.md'),'---\nname: route-skill\ndescription: download fixture\n---\n原规则');await mkdir(join(root,'exports'),{recursive:true});await writeFile(join(root,'exports',`${exportId}.xlsx`),workbook);
 const prompt=await scanProjectPrompt(root,skill),sha=createHash('sha256').update(workbook).digest('hex');
 const statements:string[]=[];
 const app=setup(sql=>{
  statements.push(sql);
  if(sql.startsWith('SELECT project_id,workflow_ids,storage_path,sha256'))return{rows:[{project_id:id,workflow_ids:[id],storage_path:join('exports',`${exportId}.xlsx`),sha256:sha}],rowCount:1};
  if(sql.startsWith('SELECT id FROM ai_distill.projects'))return{rows:[{id}],rowCount:1};
  if(sql.startsWith('SELECT material_root,local_skill_path'))return{rows:[{material_root:join(root,'questions'),local_skill_path:skill}],rowCount:1};
  if(sql.startsWith('SELECT DISTINCT ON (workflow_id)'))return{rows:[{workflow_id:id,id:'33333333-3333-4333-8333-333333333333',status:'succeeded',input:{project_prompt:prompt}}],rowCount:1};
  return empty;
 });
 expect((await app.request(`/api/exports/${exportId}/download`)).status).toBe(200);
 expect(statements[0]).toBe('BEGIN');
 expect(statements.some(sql=>sql.includes('FOR SHARE'))).toBe(true);
 expect(statements.at(-1)).toBe('COMMIT');
 await writeFile(join(skill,'SKILL.md'),'---\nname: route-skill\ndescription: download fixture\n---\n新规则');
 expect((await app.request(`/api/exports/${exportId}/download`)).status).toBe(200);
});
test.each(['/api/projects/'+id,'/api/workflows/'+id,'/api/materials/'+id+'/download','/api/artifacts/'+id+'/download'])('missing record returns 404: %s',async path=>{expect((await setup(()=>empty).request(path)).status).toBe(404);});
test.each(['/api/projects/x','/api/workflows/x','/api/materials/x/download','/api/artifacts/x/download'])('malformed ID never reaches database: %s',async path=>{let calls=0;expect((await setup(()=>{calls++;return empty;}).request(path)).status).toBe(400);expect(calls).toBe(0);});
test('workflow detail hides internal rule binding and extraction stages',async()=>{
 const app=setup(sql=>{
  const positions:Record<number,number>={1:1,2:99,3:3,4:4,5:5,6:6,7:7,8:8,9:2};const rows=sql.includes('FROM ai_distill.workflows w JOIN ai_distill.projects')?[{id,project_id:id,project:{id,name:'测试项目'}}]:sql.includes('FROM ai_distill.materials')?[{id,size_bytes:'123'}]:sql.includes('FROM ai_distill.steps')?[1,2,3,4,5,6,7,8,9].map(ordinal=>({ordinal,display_position:positions[ordinal],implemented:ordinal===1,status:ordinal===1?'succeeded':'waiting'})).sort((a,b)=>a.display_position-b.display_position):sql.includes('FROM ai_distill.artifacts')?[{id,kind:'redacted_index'}]:[{id}];return{rows,rowCount:rows.length};
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
test('optional redacted DOCX export is separate from workflow steps and safely downloadable',async()=>{
 const root=await mkdtemp(join(tmpdir(),'redacted-docx-route-'));dirs.push(root);const materialRoot=join(root,'project','questions');await mkdir(materialRoot,{recursive:true});
 const sourceBytes=Buffer.from('original PDF bytes'),sourcePath=join(root,id,'source.pdf');await mkdir(join(root,id),{recursive:true});await writeFile(sourcePath,sourceBytes);
 const source=[{material_id:'33333333-3333-4333-8333-333333333333',source_sha256:createHash('sha256').update(sourceBytes).digest('hex'),artifact_id:'44444444-4444-4444-8444-444444444444',artifact_sha256:'extract-hash'}],markdown='【附件 1】\n\n【原附件第 1 页】\n仅含脱敏内容',sha256=createHash('sha256').update(markdown).digest('hex'),attemptId='22222222-2222-4222-8222-222222222222';
 const attemptInput={materials:source,digest:redactionInputDigest(source)},steps=[1,9,4,10,5,6,7,8].map(ordinal=>({ordinal,status:'succeeded'})),calls:string[]=[];let attachmentsChanged=false,exported:{id:string;workflow_id:string;attempt_id:string;storage_path:string;sha256:string}|undefined;
 const query=async(sql:string,values?:unknown[])=>{
  calls.push(sql);
  if(sql.includes('FROM ai_distill.workflows w JOIN ai_distill.projects p')&&sql.includes('FOR UPDATE OF w'))return{rows:[{workflow_id:id,project_id:id,project_name:'测试项目 - 第五期',parent_name:'测试项目',phase_name:'第五期',title:'问题1',source_key:'题目1',material_root:materialRoot}],rowCount:1};
  if(sql.includes('FROM ai_distill.steps WHERE workflow_id=$1 AND ordinal NOT IN'))return{rows:steps,rowCount:steps.length};
  if(sql.startsWith('SELECT id FROM ai_distill.step_attempts')&&sql.includes("status IN ('waiting','running')"))return{rows:[],rowCount:0};
  if(sql.includes('SELECT status FROM ai_distill.steps WHERE workflow_id=$1 AND ordinal=9'))return{rows:[{status:'succeeded'}],rowCount:1};
  if(sql.includes("ar.kind='redacted_markdown'"))return{rows:[{id:attemptId,status:'succeeded',input:attemptInput,result:{redacted_sha256:sha256},content:markdown,sha256}],rowCount:1};
  if(sql.includes("kind='redacted_index'")){const content=JSON.stringify({redacted_sha256:sha256,materials:[{material_id:source[0]!.material_id,markdown}]});return{rows:[{content,sha256:createHash('sha256').update(content).digest('hex')}],rowCount:1};}
  if(sql.includes("ar.kind='private_extracted_pages'"))return{rows:attachmentsChanged?[{...source[0],source_sha256:'changed-source-hash'}]:source,rowCount:1};
  if(sql.startsWith('SELECT count(*)::int'))return{rows:[{count:1}],rowCount:1};
  if(sql.startsWith('SELECT id,original_name,storage_path,sha256,size_bytes FROM ai_distill.materials'))return{rows:[{id:source[0]!.material_id,original_name:'source.pdf',storage_path:`${id}/source.pdf`,sha256:source[0]!.source_sha256,size_bytes:sourceBytes.byteLength}],rowCount:1};
  if(sql.startsWith('SELECT ar.id,ar.workflow_id')&&sql.includes("ar.kind IN ('redacted_docx','original_docx')"))return{rows:exported?[{...exported,kind:'redacted_docx',source_key:'题目1',material_root:materialRoot}]:[],rowCount:exported?1:0};
  if(sql.startsWith('SELECT kind,storage_path,sha256,content')&&sql.includes('redacted_docx'))return{rows:exported?[{kind:'redacted_docx',...exported,source_key:'题目1',material_root:materialRoot}]:[],rowCount:exported?1:0};
  if(sql.includes("ar.kind='redacted_docx'"))return{rows:exported?[{...exported,source_key:'题目1',material_root:materialRoot}]:[],rowCount:exported?1:0};
  if(sql.includes("kind='redacted_docx'"))return{rows:exported?[exported]:[],rowCount:exported?1:0};
  if(sql.startsWith('INSERT INTO ai_distill.artifacts')&&values?.[3]==='redacted_docx'){exported={id:String(values?.[0]),workflow_id:String(values?.[1]),attempt_id:String(values?.[2]),storage_path:String(values?.[4]),sha256:String(values?.[5])};return{rows:[],rowCount:1};}
  return{rows:[],rowCount:1};
 };
 const client={query,release(){}};const assetRoot=join(root,'assets','out');const app=createApp({query,connect:async()=>client}as unknown as Pool,root,assetRoot);
 const response=await app.request(`/api/workflows/${id}/redacted-docx`,{method:'POST'});expect(response.status).toBe(201);expect(await response.json()).toMatchObject({artifact_id:expect.any(String),reused:false});
 expect(exported?.storage_path).toBe('附件库/测试项目/第五期/题目1/成果/source-脱敏-33333333.docx');expect((await readFile(join(assetRoot,exported!.storage_path))).readUInt32LE(0)).toBe(0x04034b50);
 expect(await readFile(join(assetRoot,'附件库','测试项目','第五期','题目1','原件','33333333_source.pdf'))).toEqual(sourceBytes);
 const download=await app.request(`/api/artifacts/${exported!.id}/download`);expect(download.headers.get('Content-Type')).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
 attachmentsChanged=true;expect((await app.request(`/api/artifacts/${exported!.id}/download`)).status).toBe(409);
 expect(calls.some(sql=>/^(INSERT|UPDATE|DELETE).*ai_distill\.(steps|step_attempts)/.test(sql))).toBe(false);
});
test('unexpected database failures keep internal details out of API responses',async()=>{
 const r=await setup(()=>{throw new Error('secret key and SQL details');}).request('/api/projects');expect(r.status).toBe(500);expect(await r.text()).not.toContain('secret');
});
test('extraction API rejects missing workflow and incomplete intake',async()=>{
 expect((await setup(()=>empty).request(`/api/workflows/${id}/extract`,{method:'POST'})).status).toBe(404);
 const app=setup(sql=>sql.startsWith('SELECT workflow_kind,source_workflow_id')?{rows:[{workflow_kind:'question',source_workflow_id:null}],rowCount:1}:sql.startsWith('SELECT id')?{rows:[{}],rowCount:1}:sql.startsWith('SELECT ordinal')?{rows:[{status:'failed'}],rowCount:1}:empty);expect((await app.request(`/api/workflows/${id}/extract`,{method:'POST'})).status).toBe(409);
});
test('authoring route refuses to enqueue when the current redacted artifact is missing',async()=>{
 const calls:string[]=[];const app=setup(sql=>{calls.push(sql);if(sql.startsWith('SELECT workflow_kind,source_workflow_id'))return{rows:[{workflow_kind:'question',source_workflow_id:null}],rowCount:1};if(sql.startsWith('SELECT w.*,p.name AS project_name'))return{rows:[{project_id:id,title:'题目1',source_key:'题目1',source_manifest:[],project_name:'项目',local_skill_path:'/unused/skill',material_root:'/unused',ingestion_status:'succeeded',redaction_status:'succeeded'}],rowCount:1};if(sql.includes("ordinal=9 AND status='succeeded'"))return{rows:[{id:'22222222-2222-4222-8222-222222222222'}],rowCount:1};return empty;});
 const response=await app.request(`/api/workflows/${id}/author`,{method:'POST'});
 expect(response.status).toBe(409);expect(await response.json()).toMatchObject({error:'当前版本没有可用于出题的脱敏文本'});expect(calls.some(sql=>sql.startsWith('INSERT INTO ai_distill.step_attempts'))).toBe(false);
});
test('step four is accepted by the batch route and reports unready prerequisites',async()=>{
 let dispatchCount=0;
 const app=setupExecutionRoutes({
  projectExists:async()=>true,
  selectWorkflows:async()=>[{id,project_id:id}],
  readStepStates:async()=>[
   {workflow_id:id,ordinal:1,status:'succeeded',enabled:true,active:false},
   {workflow_id:id,ordinal:9,status:'waiting',enabled:true,active:false},
   {workflow_id:id,ordinal:4,status:'waiting',enabled:true,active:false},
  ],
 },async()=>{dispatchCount++;return{id:'attempt'};});
 const response=await app.request(`/api/projects/${id}/steps/4/run-batch`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
 expect(response.status).toBe(202);expect(await response.json()).toMatchObject({results:[{workflow_id:id,status:'not_ready',reason:'前置步骤「脱敏与检查」尚未完成'}]});
 expect(dispatchCount).toBe(0);
});
test('single-step routes pass the stable ordinal to the shared dispatch boundary',async()=>{
 const dispatched:Array<[string,number]>=[];
 const app=setupExecutionRoutes({
  projectExists:async()=>true,
  selectWorkflows:async()=>[],
  readStepStates:async()=>[],
 },async(workflowId,ordinal)=>{dispatched.push([workflowId,ordinal]);return{id:'attempt-1'};});
 const response=await app.request(`/api/workflows/${id}/author`,{method:'POST'});
 expect(response.status).toBe(202);
 expect(await response.json()).toMatchObject({id:'attempt-1'});
 expect(dispatched).toEqual([[id,4]]);
});
test('rule binding is no longer exposed as a standalone workflow route or batch step',async()=>{
 const app=setup(()=>empty);
 expect((await app.request(`/api/workflows/${id}/load-rules`,{method:'POST'})).status).toBe(404);
 const response=await app.request(`/api/projects/${id}/steps/3/run-batch`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
 expect(response.status).toBe(400);
});
test('current rule file routes validate malformed requests before touching database',async()=>{
 let calls=0;const app=setup(()=>{calls++;return empty;});const request={method:'POST',headers:{'Content-Type':'application/json'}};
 expect((await app.request(`/api/projects/${id}/rules/file`,{...request,body:'{}'})).status).toBe(400);
 expect((await app.request(`/api/projects/${id}/rules/file`,{method:'PUT',headers:request.headers,body:JSON.stringify({path:'materials/标准.md',text:'新标准'})})).status).toBe(400);
 expect(calls).toBe(0);
});
test('attempt status reports the persisted result and input version',async()=>{
 const app=setupExecutionRoutes({projectExists:async()=>true,selectWorkflows:async()=>[],readStepStates:async()=>[]},async()=>({id:'unused'}),100,async(_pool,attemptId)=>({id:attemptId,status:'succeeded',completed:true,result:{pages:[{page:1}]},input:{revision:'v1'}}));
 const response=await app.request(`/api/attempts/${id}`);
 expect(response.status).toBe(200);
 expect(await response.json()).toMatchObject({id,status:'succeeded',completed:true,result:{pages:[{page:1}]}});
});
test('synchronous extraction waits for the same queued attempt without creating another',async()=>{
 const waits:Array<[string,number]>=[];
 const app=setupExecutionRoutes({projectExists:async()=>true,selectWorkflows:async()=>[],readStepStates:async()=>[]},async()=>({id,reused:true}),100,async(_pool,attemptId,waitMs)=>{waits.push([attemptId,waitMs]);return{id:attemptId,status:'succeeded',completed:true,result:{pages:1}};});
 const response=await app.request(`/api/workflows/${id}/extract?wait_ms=1000`,{method:'POST'});
 expect(response.status).toBe(200);
 expect(await response.json()).toMatchObject({id,reused:true,status:'succeeded',completed:true,result:{pages:1}});
 expect(waits).toEqual([[id,1000]]);
});
test('synchronous timeout returns the attempt ID and leaves the queued job intact',async()=>{
 const app=setupExecutionRoutes({projectExists:async()=>true,selectWorkflows:async()=>[],readStepStates:async()=>[]},async()=>({id}),100,async(_pool,attemptId)=>({id:attemptId,status:'waiting',completed:false}));
 const response=await app.request(`/api/workflows/${id}/extract?wait_ms=2`,{method:'POST'});
 expect(response.status).toBe(202);expect(await response.json()).toMatchObject({id,status:'waiting',completed:false});
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
test('attempt status view omits result SQL while default view stays full; invalid view is rejected',async()=>{
 const views:string[]=[];
 const app=setupExecutionRoutes({projectExists:async()=>true,selectWorkflows:async()=>[],readStepStates:async()=>[]},async()=>({id:'unused'}),100,async(_pool,attemptId,_waitMs,_signal,view)=>{views.push(view??'full');return{id:attemptId,status:'succeeded',...(view==='status'?{}:{result:{text:'答案正文'}}),completed:true};});
 const brief=await app.request(`/api/attempts/${id}?view=status`);
 expect(brief.status).toBe(200);expect(await brief.json()).not.toHaveProperty('result');
 const full=await app.request(`/api/attempts/${id}`);
 expect(await full.json()).toHaveProperty('result.text','答案正文');
 expect((await app.request(`/api/attempts/${id}?view=invalid`)).status).toBe(400);expect(views).toEqual(['status','full']);
});
test('single-step waiting preserves every model attempt and derives completion from all responses',async()=>{
 const waited:string[]=[];
 const app=setupExecutionRoutes({projectExists:async()=>true,selectWorkflows:async()=>[],readStepStates:async()=>[]},async()=>({id:'model-a',ids:['model-a','model-b']}),100,async(_pool,attemptId)=>{waited.push(attemptId);return{id:attemptId,status:attemptId==='model-a'?'succeeded':'failed',completed:true};});
 const response=await app.request(`/api/workflows/${id}/answer?wait_ms=1000`,{method:'POST'});
 expect(response.status).toBe(200);
 expect(await response.json()).toMatchObject({id:'model-a',ids:['model-a','model-b'],completed:true,results:[{id:'model-a',status:'succeeded'},{id:'model-b',status:'failed'}]});
 expect(waited).toEqual(['model-a','model-b']);
});
test('project batch queues each ready workflow once and isolates unready or missing records',async()=>{
 const ready='22222222-2222-4222-8222-222222222222';
 const unready='33333333-3333-4333-8333-333333333333';
 const broken='55555555-5555-4555-8555-555555555555';
 const missing='44444444-4444-4444-8444-444444444444';
 const stepRows=[ready,unready,broken].flatMap(workflow_id=>[
  {workflow_id,ordinal:1,status:workflow_id===unready?'failed':'succeeded',enabled:true,active:false},
  {workflow_id,ordinal:9,status:'waiting',enabled:true,active:false},
 ]);
 const dispatched:string[]=[];
 const app=setupExecutionRoutes({
  projectExists:async()=>true,
  selectWorkflows:async()=>[{id:ready,project_id:id},{id:unready,project_id:id},{id:broken,project_id:id}],
  readStepStates:async()=>stepRows,
 },async workflowId=>{dispatched.push(workflowId);if(workflowId===broken)throw new Error('private dispatch details');return{id:'attempt-'+workflowId};});
 const response=await app.request(`/api/projects/${id}/steps/9/run-batch`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({workflow_ids:[ready,ready,unready,broken,missing,missing]})});
 expect(response.status).toBe(202);
 expect(await response.json()).toEqual({results:[
  {workflow_id:ready,status:'queued',attempt_id:expect.any(String),reused:false},
  {workflow_id:unready,status:'not_ready',reason:'前置步骤「入库（含PDF文本提取）」尚未完成'},
  {workflow_id:broken,status:'failed',reason:'派发失败，请检查任务记录和服务端日志'},
  {workflow_id:missing,status:'not_found'},
 ]});
 expect(dispatched).toEqual([ready,broken]);
});
test('batch endpoint rejects hidden step numbers and malformed workflow IDs',async()=>{
 const app=setup(()=>empty);
 const base={method:'POST',headers:{'Content-Type':'application/json'}};
 expect((await app.request(`/api/projects/${id}/steps/2/run-batch`,{...base,body:'{}'})).status).toBe(400);
 expect((await app.request(`/api/projects/${id}/steps/9/run-batch`,{...base,body:JSON.stringify({workflow_ids:['bad']})})).status).toBe(400);
});
test('unknown endpoint is 404 and excessive request body is 413',async()=>{
 const app=setup(()=>empty);expect((await app.request('/api/unknown')).status).toBe(404);
 expect((await app.request('/api/projects',{method:'POST',headers:{'Content-Type':'application/json','Content-Length':String(103*1024*1024)},body:'{}'})).status).toBe(413);
});
test('a 100-question redaction batch queues exactly the 99 whose previous visible step succeeded',async()=>{
 const workflowIds=Array.from({length:100},(_,i)=>`${String(i+1).padStart(8,'0')}-0000-4000-8000-000000000000`);
 let dispatchCount=0;
 const stateReads:number[]=[];
 const app=setupExecutionRoutes({
  projectExists:async()=>true,
  selectWorkflows:async()=>workflowIds.map(workflow_id=>({id:workflow_id,project_id:id})),
  readStepStates:async(_projectId,workflowBatch)=>{
   stateReads.push(workflowBatch.length);
   return workflowBatch.flatMap(workflow_id=>[
    {workflow_id,ordinal:1,status:workflow_id===workflowIds[99]?'running':'succeeded',enabled:true,active:false},
    {workflow_id,ordinal:9,status:'waiting',enabled:true,active:false},
   ]);
  },
 },async()=>({id:`attempt-${++dispatchCount}`}),20);
 const result=await(await app.request(`/api/projects/${id}/steps/9/run-batch`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).json()as any;
 expect(result.results.filter((r:any)=>r.status==='queued')).toHaveLength(99);
 expect(result.results.filter((r:any)=>r.status==='not_ready')).toHaveLength(1);
 expect(dispatchCount).toBe(99);
 expect(stateReads).toEqual([20,20,20,20,20]);
});
test('project skill generation rejects malformed requests before dispatch and lists only live projects',async()=>{
 const calls:string[]=[];const app=setup(sql=>{calls.push(sql);return empty;});
 expect((await app.request(`/api/projects/${id}/skill/generate`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{'})).status).toBe(400);
 expect(calls).toEqual([]);
 expect((await app.request('/api/projects/not-a-uuid/skill/attempts')).status).toBe(400);
 expect((await app.request(`/api/projects/${id}/skill/attempts`)).status).toBe(404);
});

test('空钩子无需033迁移即可健康，其他必需迁移缺失仍报未就绪',async()=>{
 const names=(await readdir(new URL('../migrations/',import.meta.url))).filter(name=>name.endsWith('.sql')&&name!=='033_workflow_hooks.sql');
 const health=async(applied:string[])=>setup(sql=>sql.startsWith('SELECT name FROM ai_distill.schema_migrations')?{rows:applied.map(name=>({name})),rowCount:applied.length}:empty).request('/api/health');
 const optionalMissing=await health(names);expect(optionalMissing.status).toBe(200);expect(await optionalMissing.json()).toMatchObject({schema:'ready'});
 const requiredMissing=await health(names.filter(name=>name!=='032_workflow_authoring_direction.sql'));expect(requiredMissing.status).toBe(503);expect(await requiredMissing.json()).toMatchObject({schema:'migrations_pending',pending_count:1});
});


test('HTTP新期缺省共享材料库并冻结出题专用默认，首期不猜Skill路径',async()=>{
 const root=await mkdtemp(join(tmpdir(),'library-phase-default-'));dirs.push(root);
 const saved:any[][]=[],configs:any[][]=[];let scanned=false;
 const app=setup((sql,values)=>{
  if(sql.startsWith('INSERT INTO ai_distill.project_groups'))return{rows:[{id:'55555555-5555-4555-8555-555555555555',name:'新主项目'}],rowCount:1};
  if(sql.startsWith('SELECT authoring_defaults'))return{rows:[{authoring_defaults:{model:'gpt-6.1-sol',reasoning_effort:'low'}}],rowCount:1};
  if(sql.startsWith('INSERT INTO ai_distill.projects')){saved.push(values as any[]);return{rows:[{id}],rowCount:1};}
  if(sql.startsWith('INSERT INTO ai_distill.project_step_configs'))configs.push(values as any[]);
  if(sql.startsWith('INSERT INTO ai_distill.workflows'))scanned=true;
  return{rows:[],rowCount:0};
 });
 const body={name:'新主项目',workspace_path:root,local_skill_path:root};
 const response=await app.request('/api/projects',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 expect(response.status).toBe(201);expect(saved[0]?.[3]).toBeNull();expect(saved[0]?.[7]).toBe('material_packages');expect(saved[0]?.[9]).toBe('library_v1');expect(saved[0]?.[12]).toBe(1);expect(scanned).toBe(false);
 expect(JSON.parse(configs.find(v=>v[1]===4)![2])).toMatchObject({model:'gpt-6.1-sol',reasoning_effort:'low',material_processing_mode:'aliases',material_source_mode:'redacted'});
 const invalid=await app.request('/api/projects',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'新主项目',workspace_path:root})});expect(invalid.status).toBe(400);
});

test('项目详情按本期覆盖或共享Skill报告真实生效路径，两期不串用',async()=>{
 const root=await mkdtemp(join(tmpdir(),'phase-skill-status-'));dirs.push(root);
 const shared=join(root,'shared'),phase1=join(root,'one'),phase2=join(root,'two');
 await mkdir(shared);await mkdir(join(phase1,'skill'),{recursive:true});await mkdir(phase2);
 await writeFile(join(shared,'SKILL.md'),'---\nname: shared\ndescription: fixture\n---\n共享');
 await writeFile(join(phase1,'skill','SKILL.md'),'---\nname: override\ndescription: fixture\n---\n本期');
 const second='22222222-2222-4222-8222-222222222222';
 const app=setup((sql,values)=>sql.startsWith('SELECT p.*,system_config.model')?{rows:[{id:values?.[0],name:'测试期次',parent_name:'测试主项目',material_backend:'library_v1',material_mode:'material_packages',workspace_path:values?.[0]===id?phase1:phase2,local_skill_path:shared,__step_configs:[]}],rowCount:1}:{rows:[],rowCount:0});
 const first=await (await app.request(`/api/projects/${id}`)).json() as any;
 const other=await (await app.request(`/api/projects/${second}`)).json() as any;
 expect(first.project).toMatchObject({skill_exists:true,effective_skill_path:join(phase1,'skill')});
 expect(other.project).toMatchObject({skill_exists:true,effective_skill_path:shared});
});
