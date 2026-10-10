/** 文件职责：在临时 PostgreSQL schema 核对项目 skill 生成队列、候选采用及冻结状态。
 * 执行入口与用途：`bun scripts/verify-project-skill-queue.ts`；在临时 schema 注入生成器，调用 enqueue／worker／adopt 路径核对候选和冻结状态。
 */
import {createPool} from '../server/db';
import {createApp} from '../server/app';
import {adoptProjectSkill,registerProjectRules,publishProjectRules} from '../server/rules';
import {generateProjectSkill} from '../server/skill-generation/generate';
import {enqueueProjectSkill,runNextProjectSkill} from '../server/skill-generation/jobs';
import {mkdtemp,mkdir,writeFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {Pool} from 'pg';
const pool=createPool(),schema=`test_skill_${crypto.randomUUID().replaceAll('-','')}`,root=await mkdtemp(join(tmpdir(),'skill-queue-db-'));
const rewrite=(sql:string)=>sql.replaceAll('ai_distill',schema);
const testPool={query:async(sql:string,values?:unknown[])=>{try{return await pool.query(rewrite(sql),values);}catch(error){throw error;}},connect:async()=>{try{const db=await pool.connect();return{query:async(sql:string,values?:unknown[])=>{try{return await db.query(rewrite(sql),values);}catch(error){throw error;}},release:()=>db.release()};}catch(error){throw error;}}} as unknown as Pool;
const checks:{name:string;passed:boolean}[]=[];
function check(name:string,passed:boolean){checks.push({name,passed});console.log(`${passed?'PASS':'FAIL'} ${name}`);if(!passed)throw new Error(name);}
try{
 for(const name of (await readdir(new URL('../migrations/',import.meta.url))).filter(f=>f.endsWith('.sql')).sort())await testPool.query(await Bun.file(new URL(`../migrations/${name}`,import.meta.url)).text());
 const project=crypto.randomUUID(),other=crypto.randomUUID(),workspace=join(root,'project'),template=join(root,'template');await mkdir(join(workspace,'materials'),{recursive:true});await mkdir(template);await writeFile(join(workspace,'materials/rules.md'),'本期规则');await writeFile(join(template,'SKILL.md'),'---\nname: fixture\ndescription: fixture\n---');
 await testPool.query('INSERT INTO ai_distill.projects(id,name,material_root,local_skill_path) VALUES($1,$2,$3,$4)',[project,'skill fixture',join(workspace,'questions'),join(workspace,'skill')]);await testPool.query('INSERT INTO ai_distill.projects(id,name) VALUES($1,$2)',[other,'isolated other']);
 await mkdir(join(workspace,'skill'));await writeFile(join(workspace,'skill/SKILL.md'),'---\nname: imported\ndescription: imported\n---');
 const initial=await registerProjectRules(testPool,project,workspace);const baseline=await publishProjectRules(testPool,project,initial.manifest.source_digest!);
 const config={model:'gpt-6-luna',reasoning_effort:'low'},options={template};
 const [one,two]=await Promise.all([enqueueProjectSkill(testPool,project,config,options),enqueueProjectSkill(testPool,project,config,options)]);check('concurrent enqueues reuse one persistent project task',one.id===two.id&&one.reused!==two.reused);
 check('exactly one active project generation',(await testPool.query("SELECT id FROM ai_distill.project_skill_attempts WHERE project_id=$1 AND status='waiting'",[project])).rowCount===1);
 const app=createApp(testPool,root);check('list API returns queued attempt',(await (await app.request(`/api/projects/${project}/skill/attempts`)).json() as any[])[0].id===one.id);
 check('other project cannot see this generation',(await (await app.request(`/api/projects/${other}/skill/attempts`)).json() as any[]).length===0);
 check('worker uses snapshot and saves candidate result',await runNextProjectSkill(testPool,root,async input=>{check('worker receives frozen inputs',input.project.includes('snapshots/skill-input-'));return{candidate_path:join(root,'candidate'),publishable:false,issues:[],unresolved:[{id:'threshold',detail:'门槛未确定'}],session_id:'fixture-session',usage:{input_tokens:10}} as any;}));
 const saved=(await testPool.query('SELECT status,result,session_id FROM ai_distill.project_skill_attempts WHERE id=$1',[one.id])).rows[0];check('unresolved candidate remains recorded without publication',saved.status==='succeeded'&&saved.result.publishable===false&&saved.session_id==='fixture-session');
 check('project current skill is untouched',(await testPool.query('SELECT local_skill_path FROM ai_distill.projects WHERE id=$1',[project])).rows[0].local_skill_path===join(workspace,'skill'));
 await writeFile(join(workspace,'materials/rules.md'),'修改后的规则');const next=await enqueueProjectSkill(testPool,project,config,options);check('changed rules create new immutable attempt',next.id!==one.id);
 await runNextProjectSkill(testPool,root,async options=>generateProjectSkill({...options,execute:(async (invocation:any)=>({result:invocation.validate({files:[{path:'SKILL.md',content:'---\nname: generated\ndescription: generated\n---'}],remove:[],unresolved:[{id:'external',detail:'外部资格未核实',blocking:false}],summary:'本期候选'}),session_id:'fixture-new-protocol',usage:null,events_path:'private',duration_ms:1})) as any}));
 const adopted=await adoptProjectSkill(testPool,project,next.id,root);check('candidate adoption creates a new draft',adopted.status==='draft'&&adopted.version===baseline.version+1);
 const published=await publishProjectRules(testPool,project,adopted.manifest.source_digest!);check('adopted skill freezes with generation lineage',published.status==='published'&&published.manifest.generation?.attempt_id===next.id);
 check('old published snapshot is retained',(await testPool.query('SELECT status,manifest FROM ai_distill.rule_versions WHERE id=$1',[baseline.id])).rows[0].manifest.source_digest===baseline.manifest.source_digest);
 check('duplicate adoption reuses published version',(await adoptProjectSkill(testPool,project,next.id,root)).id===published.id);
 await writeFile(join(workspace,'materials/rules.md'),'再次更新规则');const late=await enqueueProjectSkill(testPool,project,config,options);
 await runNextProjectSkill(testPool,root,async()=>{await testPool.query('UPDATE ai_distill.projects SET deleted_at=now() WHERE id=$1',[project]);return{candidate_path:'private',publishable:true,issues:[],unresolved:[],session_id:'late',usage:null} as any;});check('deleted project blocks late result',(await testPool.query('SELECT status FROM ai_distill.project_skill_attempts WHERE id=$1',[late.id])).rows[0].status==='failed');
}catch{console.error('skill队列隔离验证失败；未输出私有资料或数据库凭证');process.exitCode=1;}
finally{try{await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);}catch{process.exitCode=1;}await pool.end();await rm(root,{recursive:true,force:true});await mkdir('docs/evidence',{recursive:true});await writeFile('docs/evidence/project-skill-queue-results.json',JSON.stringify({checked_at:new Date().toISOString(),scope:'isolated PostgreSQL + synthetic source/template + injected generation; no real model call',checks},null,2)+'\n');}
