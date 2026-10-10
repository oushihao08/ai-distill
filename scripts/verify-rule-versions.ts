/** 文件职责：以两个临时项目验证规则文件编辑、并发冻结、历史快照及指纹检查。
 * 执行入口与用途：`bun scripts/verify-rule-versions.ts`；创建两个临时项目，经 API 验证规则编辑、并发冻结、独立快照、历史保留和指纹校验。
 */
import {createPool} from '../server/db';
import {createApp} from '../server/app';
import {verifyRuleSnapshot} from '../server/rule-files';
import type {ProjectRules,RuleVersion,RuleFile} from '../shared/types';
import type {Pool} from 'pg';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

const pool=createPool();
const schema=`test_rules_${crypto.randomUUID().replaceAll('-','')}`;
const root=await mkdtemp(join(tmpdir(),'ai-distill-rules-'));
const checks:{name:string;passed:boolean}[]=[];
const sql=(query:string)=>query.replaceAll('ai_distill',schema);
const testPool={
 query:async(query:string,values?:unknown[])=>{try{return await pool.query(sql(query),values);}catch(error){throw error;}},
 connect:async()=>{try{const client=await pool.connect();return{query:async(query:string,values?:unknown[])=>{try{return await client.query(sql(query),values);}catch(error){throw error;}},release:()=>client.release()};}catch(error){throw error;}},
} as unknown as Pool;
function check(name:string,passed:boolean){checks.push({name,passed});console.log(`${passed?'PASS':'FAIL'} ${name}`);if(!passed)throw new Error(name);}
try{
 for(const name of(await readdir(new URL('../migrations/',import.meta.url))).filter(name=>name.endsWith('.sql')).sort())await pool.query(sql(await Bun.file(new URL(`../migrations/${name}`,import.meta.url)).text()));
 const app=createApp(testPool,join(root,'store'));
 async function request(path:string,method='GET',body?:unknown){try{return await app.request(`/api${path}`,{method,...(body===undefined?{}:{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})});}catch(error){throw error;}}
 async function view(id:string){try{const response=await request(`/projects/${id}/rules`);if(response.status!==200)throw new Error('rule workspace unavailable');return await response.json() as ProjectRules;}catch(error){throw error;}}
 async function setup(name:string){
  try{
   const directory=join(root,name);const input=join(directory,'questions');const skill=join(directory,'skill');
   for(const path of[input,join(directory,'materials'),join(skill,'references'),join(skill,'assets')])await mkdir(path,{recursive:true});
   await writeFile(join(directory,'materials','规则.md'),`${name} body v1`);
   await writeFile(join(skill,'SKILL.md'),`---\nname: ${name}\ndescription: fixture\n---\n[rule](references/rule.md) [template](assets/template.docx)\n`);
   await writeFile(join(skill,'references','rule.md'),`${name} methodology`);
   const template=new Uint8Array([80,75,3,4,1,0,2]);await writeFile(join(skill,'assets','template.docx'),template);
   await writeFile(join(directory,'project.json'),JSON.stringify({assessment:{models:[name]},unresolved:[{id:'qualification',detail:'Internal preparation only'}]}));
   const response=await request('/projects','POST',{name,material_root:input,local_skill_path:skill});if(response.status!==201)throw new Error('fixture project creation failed');const project=await response.json() as {id:string};return{directory,input,skill,template,id:project.id};
  }catch(error){throw error;}
 }
 const one=await setup('first');const two=await setup('second');let current=await view(one.id);
 check('inventory includes rules, whole skill references and binary assets',current.workspace.files.length===5&&current.workspace.issues.length===0&&current.workspace.files.some(file=>file.path==='skill/assets/template.docx'));
 check('workspace metadata carries unresolved qualifications',current.workspace.unresolved[0]?.id==='qualification'&&current.workspace.assessment.models instanceof Array);
 check('different projects do not share rule paths or digests',current.workspace.source_digest!==(await view(two.id)).workspace.source_digest);
 let response=await request(`/projects/${one.id}/rules/register`,'POST',{workspace_path:one.directory});let draft=await response.json() as RuleVersion;
 response=await request(`/projects/${one.id}/rules/register`,'POST',{workspace_path:one.directory});
 check('unchanged registration reuses the same durable draft',response.status===200&&(await response.json() as RuleVersion).id===draft.id);
 const published=await Promise.all([1,2].map(async()=>{try{const result=await request(`/projects/${one.id}/rules/publish`,'POST',{source_digest:current.workspace.source_digest});if(result.status!==200)throw new Error('publish failed');return await result.json() as RuleVersion;}catch(error){throw error;}}));
 const first=published[0]!;
 check('concurrent freeze reuses one version and one complete snapshot',first.status==='published'&&first.id===published[1]?.id&&(await readdir(join(one.directory,'snapshots'))).length===1);
 const snapshot=first.manifest.snapshot_path!;
 check('snapshot preserves binary template exactly',Buffer.compare(await readFile(join(snapshot,'skill/assets/template.docx')),Buffer.from(one.template))===0);
 check('internal freeze does not certify official eligibility',first.manifest.execution_scope==='internal_preparation'&&first.manifest.official_eligibility==='unverified');
 const file=(await view(one.id)).workspace.files.find(file=>file.path==='materials/规则.md')!;
 response=await request(`/projects/${one.id}/rules/file?path=${encodeURIComponent(file.path)}`);const document=await response.json() as RuleFile&{text:string;editable:boolean};
 check('read returns current text and fingerprint for safe editing',response.status===200&&document.text==='first body v1'&&document.editable&&document.sha256===file.sha256);
 response=await request(`/projects/${one.id}/rules/file?download=1&path=skill%2Fassets%2Ftemplate.docx`);
 check('binary download preserves bytes and sets an attachment header',response.status===200&&response.headers.get('Content-Disposition')?.startsWith('attachment')===true&&Buffer.compare(Buffer.from(await response.arrayBuffer()),Buffer.from(one.template))===0);
 response=await request(`/projects/${one.id}/rules/file`,'PUT',{path:file.path,text:'first body v2',expected_sha256:file.sha256});draft=await response.json() as RuleVersion;
 check('edit after freeze creates the next draft and leaves the old snapshot unchanged',response.status===200&&draft.version===2&&draft.status==='draft'&&await readFile(join(snapshot,file.path),'utf8')==='first body v1');
 response=await request(`/projects/${one.id}/rules/file`,'PUT',{path:file.path,text:'stale overwrite',expected_sha256:file.sha256});
 check('stale edits are rejected without changing current bytes',response.status===409&&await readFile(join(one.directory,file.path),'utf8')==='first body v2');
 check('workspace edit is marked different from the frozen version',(await view(one.id)).source_changed);
 response=await request(`/projects/${one.id}/rules/publish`,'POST',{source_digest:current.workspace.source_digest});
 check('old workspace digest cannot freeze newer source files',response.status===409);
 response=await request(`/projects/${one.id}/rules/file`,'PUT',{path:'materials/新增.md',text:'new rule',expected_sha256:null});
 check('new text rule is added to the same draft',response.status===200&&(await response.json() as RuleVersion).id===draft.id);
 const form=new FormData();form.append('file',new File([new Uint8Array([1,2,3])],'附件.pdf'));form.append('path','materials/附件.pdf');
 response=await app.request(`/api/projects/${one.id}/rules/file`,{method:'POST',body:form});
 check('binary rule upload is stored without invoking recognition',response.status===200&&Buffer.compare(await readFile(join(one.directory,'materials/附件.pdf')),Buffer.from([1,2,3]))===0);
 const added=(await view(one.id)).workspace.files.find(file=>file.path==='materials/新增.md')!;
 response=await request(`/projects/${one.id}/rules/file`,'DELETE',{path:added.path,expected_sha256:added.sha256});
 check('deletion removes the working file and retains frozen history',response.status===200&&!(await view(one.id)).workspace.files.some(file=>file.path===added.path)&&await readFile(join(snapshot,file.path),'utf8')==='first body v1');
 for(const path of['skill/SKILL.md','materials/../skill/SKILL.md','../escaped.md']){
  response=await request(`/projects/${one.id}/rules/file`,'PUT',{path,text:'invalid',expected_sha256:null});check(`reject protected or escaping path ${path}`,response.status===400);
 }
 current=await view(one.id);response=await request(`/projects/${one.id}/rules/publish`,'POST',{source_digest:current.workspace.source_digest});const second=await response.json() as RuleVersion;
 check('second freeze retains the previous version and captures current files',response.status===200&&second.version===2&&(await view(one.id)).versions.length===2&&await readFile(join(second.manifest.snapshot_path!,file.path),'utf8')==='first body v2');
 await verifyRuleSnapshot(snapshot,first.manifest.files!);
 check('published fingerprints remain valid after PostgreSQL JSONB round trip',true);
 const rows=(await testPool.query('SELECT manifest FROM ai_distill.rule_versions WHERE project_id=$1',[one.id])).rows;
 check('database manifests contain no rule or skill bodies',rows.every(row=>!JSON.stringify(row.manifest).includes('body v')&&!JSON.stringify(row.manifest).includes('methodology')));
 await writeFile(join(second.manifest.snapshot_path!,file.path),'tampered');
 response=await request(`/projects/${one.id}/rules/publish`,'POST',{source_digest:current.workspace.source_digest});
 check('tampered existing snapshot prevents reuse',response.status===409);
 await writeFile(join(two.skill,'SKILL.md'),'---\nname: second\ndescription: fixture\n---\n[missing](references/missing.md)');current=await view(two.id);
 response=await request(`/projects/${two.id}/rules/publish`,'POST',{source_digest:current.workspace.source_digest});
 check('missing skill references block freeze for that project',current.workspace.issues.length>0&&response.status===409);
 check('another project never receives the first project versions',(await view(two.id)).versions.length===0);
}catch(error){console.error(error instanceof Error?error.message:'rule verification failed');process.exitCode=1;}
finally{
 try{await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);}catch{console.error('temporary schema cleanup failed');process.exitCode=1;}
 try{await rm(root,{recursive:true,force:true});await Bun.write(new URL('../docs/evidence/rule-version-results.json',import.meta.url),JSON.stringify({checked_at:new Date().toISOString(),scope:'real PostgreSQL, HTTP and local files',provider_calls:0,checks},null,2)+'\n');}catch{console.error('local fixture cleanup failed');process.exitCode=1;}
 await pool.end();
}
