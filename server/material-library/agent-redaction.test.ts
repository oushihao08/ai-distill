/** 验证Agent整包执行的提示词转交、主体表私有保存、精确计划编译及硬超时；注入合成执行器，不调用真实模型/业务库。 */
import {test,expect} from 'bun:test';
import {mkdtemp,mkdir,readFile,writeFile,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {prepareAgentLibraryMaterials} from './agent-redaction';
import {readLibraryProcessingSettings,saveLibraryProcessingSettings} from './settings';

const settings={version:1,extraction:{protocol:'v1',provider_config:{}},redaction:{provider:'codex',model:'fixture',reasoning_effort:'medium',prompt:'旧模板'},execution:{task_timeout_ms:1200000,request_timeout_ms:1000},policy:{preserve_dates:true,preserve_amounts:true}};
function options(directory:string){return{directory,model:'fixture',reasoning_effort:'medium',revision_id:'11111111-1111-4111-8111-111111111111',extraction_job_id:'22222222-2222-4222-8222-222222222222',template:{id:'aliases',digest:'a'.repeat(64),redaction:{prompt:'本次数据库冻结提示词'}},files:[{file_id:'33333333-3333-4333-8333-333333333333',text_sha256:'h',pages:[{page:1,text:'赵安向北京市东城区人民法院申请100元',structure:[{id:'b',kind:'paragraph' as const,text:'赵安向北京市东城区人民法院申请100元'}]}]}]};}
test('persisted template is reread on each request instead of cached markdown/default text',async()=>{
 const root=await mkdtemp(join(tmpdir(),'agent-settings-'));const pool={query:async()=>{throw new Error('已保存时不应读取默认模型');}} as any;
 try{saveLibraryProcessingSettings(root,0,settings);const first=await readLibraryProcessingSettings(pool,root);expect((first.processing_settings as any).redaction_templates[0].workflow).toBe('codex_plan');
  const next:any=first.processing_settings;next.redaction_templates[0].redaction.prompt='数据库更新后的模板';saveLibraryProcessingSettings(root,first.lock_version,next);
  expect((await readLibraryProcessingSettings(pool,root)).processing_settings).toMatchObject({redaction_templates:[{redaction:{prompt:'数据库更新后的模板'}}]});
 }finally{await rm(root,{recursive:true,force:true});}
});
test('one Agent call receives frozen template and stores a private reusable identity map',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'agent-preparation-'));let calls=0;
 try{const out=await prepareAgentLibraryMaterials({...options(directory),execute:async task=>{calls++;expect(task.prompt).toContain('本次数据库冻结提示词');expect(task.timeout_ms).toBeLessThanOrEqual(600000);expect(task.schema?.properties).toHaveProperty('plan_file');await mkdir(join(directory,'output'),{recursive:true});await writeFile(join(directory,'output','material-plan.json'),JSON.stringify({entities:[{id:'p',kind:'person',alias:'周文远',variants:[{text:'赵安',targets:[]}]}],edits:[],documents:[{id:'d',title:'申请书',ranges:[{first_block_id:'f1p1b1',last_block_id:'f1p1b1'}],duplicate_of:null}],unresolved:[]}));const validator=Bun.spawn([process.execPath,'validate-plan.mjs'],{cwd:directory,stdout:'pipe',stderr:'pipe'});expect(await validator.exited).toBe(0);expect(JSON.parse(await new Response(validator.stdout).text()).valid).toBe(true);return{result:{plan_file:'output/material-plan.json'},session_id:'fixture',usage:null,diagnostic_path:'private',duration_ms:1,provider:'fixture',model:'fixture'} as any;}});
  expect(calls).toBe(1);expect(out.prepared.documents[0]!.text).toBe('周文远向北京市东城区人民法院申请100元');
  const map=join(directory,'主体对应表.private.json');expect(JSON.parse(await readFile(map,'utf8')).entities[0].alias).toBe('周文远');expect((await stat(map)).mode&0o777).toBe(0o600);
 }finally{await rm(directory,{recursive:true,force:true});}
});
test('hard budget aborts the active executor without retrying',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'agent-deadline-'));let calls=0;const started=performance.now();
 try{await expect(prepareAgentLibraryMaterials({...options(directory),timeout_ms:40,execute:async task=>{calls++;return await new Promise((_,reject)=>{task.signal!.addEventListener('abort',()=>reject(task.signal!.reason),{once:true});});}})).rejects.toMatchObject({reason_code:'agent_redaction_timeout'});
  expect(calls).toBe(1);expect(performance.now()-started).toBeLessThan(1000);
 }finally{await rm(directory,{recursive:true,force:true});}
});
test('completion message alone cannot publish without the complete plan artifact',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'agent-artifact-'));
 try{await expect(prepareAgentLibraryMaterials({...options(directory),execute:async()=>({result:{plan_file:'output/material-plan.json'},session_id:'fixture',usage:null,model:'fixture'} as any)})).rejects.toMatchObject({reason_code:'agent_plan_file_missing'});
 }finally{await rm(directory,{recursive:true,force:true});}
});
test('an empty plan artifact still fails full source coverage',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'agent-empty-plan-'));
 try{await expect(prepareAgentLibraryMaterials({...options(directory),execute:async()=>{await mkdir(join(directory,'output'));await writeFile(join(directory,'output','material-plan.json'),JSON.stringify({entities:[],edits:[],documents:[],unresolved:[]}));return{result:{plan_file:'output/material-plan.json'},session_id:'fixture',usage:null,model:'fixture'} as any;}})).rejects.toMatchObject({reason_code:'agent_document_coverage_missing'});
 }finally{await rm(directory,{recursive:true,force:true});}
});
test('revalidation withdraws unusable Agent results without rewriting source or execution history',async()=>{
 const {revalidateAgentLibraryRedaction}=await import('./redaction-review');
 const root=await mkdtemp(join(tmpdir(),'agent-review-')),directory=join(root,'material-library','jobs','job','private'),input=options(directory);
 const plan={entities:[{id:'p',kind:'person',alias:'周文远',variants:[{text:'赵安',targets:[]}]}],edits:[],documents:[{id:'d',title:'申请书',ranges:[{first_block_id:'f1p1b1',last_block_id:'f1p1b1'}],duplicate_of:null}],unresolved:[{target_id:'all',kind:'identity',blocking:false,reason:'其他自然人未处理'}]};
 const queries:string[]=[],patches:any[]=[];
 const pool={query:async(sql:string,v:any[])=>{queries.push(sql);if(sql.startsWith('SELECT'))return{rows:[{redaction_job_id:'job',output_digest:'digest',validation_report:{protocol:'agent-material-plan-v1'}}]};patches.push(JSON.parse(v[1]));return{rowCount:1};}} as any;
 try{
  await mkdir(join(directory,'output'),{recursive:true});await writeFile(join(directory,'validation-source.json'),JSON.stringify({files:input.files,identity:{revision_id:input.revision_id,extraction_job_id:input.extraction_job_id,template_id:'aliases',template_digest:input.template.digest}}));
  await writeFile(join(directory,'output','material-plan.json'),JSON.stringify(plan));
  expect(await revalidateAgentLibraryRedaction(pool,root,'redaction')).toMatchObject({usable_for_question:false,reason_code:'agent_uncertainty_target_invalid'});
  plan.unresolved=[];await writeFile(join(directory,'output','material-plan.json'),JSON.stringify(plan));
  expect(await revalidateAgentLibraryRedaction(pool,root,'redaction')).toMatchObject({usable_for_question:true});
  expect(patches.map(p=>p.valid)).toEqual([false,true]);expect(queries.filter(q=>q.startsWith('UPDATE')).every(q=>q.startsWith('UPDATE ai_distill.library_jobs'))).toBe(true);
 }finally{await rm(root,{recursive:true,force:true});}
});
