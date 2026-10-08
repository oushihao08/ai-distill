import {test,expect,afterEach} from 'bun:test';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import type {Pool} from 'pg';
import {readProjectRules,registerProjectRules,publishProjectRules,editProjectRuleFile} from './rules';
const roots:string[]=[];
afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'rule-versions-'));roots.push(root);await mkdir(join(root,'materials'));await mkdir(join(root,'skill'));
 await writeFile(join(root,'materials','标准.md'),'本期标准');await writeFile(join(root,'skill','SKILL.md'),'---\nname: test\ndescription: Test\n---\n本地技能');
 const project={id:'11111111-1111-4111-8111-111111111111',material_root:join(root,'questions'),local_skill_path:join(root,'skill')};
 const versions:any[]=[];const calls:string[]=[];
 const query=async(sql:string,values?:unknown[])=>{
  calls.push(sql);
  if(sql.startsWith('SELECT * FROM ai_distill.projects'))return{rows:[project],rowCount:1};
  if(sql.startsWith('SELECT * FROM ai_distill.rule_versions'))return{rows:[...versions].reverse(),rowCount:versions.length};
  if(sql.startsWith('INSERT INTO ai_distill.rule_versions')){const row={id:values![0],project_id:values![1],version:values![2],status:'draft',manifest:JSON.parse(values![3] as string)};versions.push(row);return{rows:[row],rowCount:1};}
  if(sql.startsWith('UPDATE ai_distill.rule_versions')){const row=versions.find(v=>v.id===values![0]);row.manifest=JSON.parse(values![1] as string);if(sql.includes("status='published'"))row.status='published';return{rows:[row],rowCount:1};}
  return{rows:[],rowCount:0};
 };
 return{root,project,versions,calls,pool:{query,connect:async()=>({query,release(){}})}as unknown as Pool};
}
test('registering unchanged rules reuses the draft version and stores no skill body',async()=>{
 const f=await fixture();const first=await registerProjectRules(f.pool,f.project.id,f.root);const again=await registerProjectRules(f.pool,f.project.id,f.root);
 expect(first.id).toBe(again.id);expect(f.versions).toHaveLength(1);expect(first.status).toBe('draft');expect(JSON.stringify(first.manifest)).not.toContain('本地技能');
});
test('publishing freezes an existing skill and subsequent edits create a separate draft',async()=>{
 const f=await fixture();const view=await readProjectRules(f.pool,f.project.id);const published=await publishProjectRules(f.pool,f.project.id,view.workspace.source_digest);
 expect(published.status).toBe('published');expect(published.manifest.official_eligibility).toBe('unverified');
 const oldFile=join(published.manifest.snapshot_path!,'materials','标准.md');
 await editProjectRuleFile(f.pool,f.project.id,'materials/标准.md',new TextEncoder().encode('新标准'),view.workspace.files.find((file:any)=>file.path==='materials/标准.md')!.sha256);
 expect(f.versions.map(v=>v.status)).toEqual(['published','draft']);
 expect(await readFile(oldFile,'utf8')).toBe('本期标准');expect((await readProjectRules(f.pool,f.project.id)).source_changed).toBe(true);
});
test('publishing an unchanged version reuses its snapshot and detects later tampering',async()=>{
 const f=await fixture();const digest=(await readProjectRules(f.pool,f.project.id)).workspace.source_digest;
 const first=await publishProjectRules(f.pool,f.project.id,digest);const second=await publishProjectRules(f.pool,f.project.id,digest);
 expect(second.id).toBe(first.id);expect(f.versions).toHaveLength(1);
 await writeFile(join(first.manifest.snapshot_path!,'skill','SKILL.md'),'被改写');
 await expect(publishProjectRules(f.pool,f.project.id,digest)).rejects.toThrow('快照');
});
test('publication refuses a stale inventory instead of silently changing the accepted version',async()=>{
 const f=await fixture();const digest=(await readProjectRules(f.pool,f.project.id)).workspace.source_digest;
 await writeFile(join(f.root,'materials','标准.md'),'目录被修改');
 await expect(publishProjectRules(f.pool,f.project.id,digest)).rejects.toThrow('已变化');expect(f.versions).toHaveLength(0);expect(f.calls).toContain('ROLLBACK');
});
