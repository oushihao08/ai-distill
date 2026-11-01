/** 验证出题历史 skill 快照独立于当前目录，并确认 skill 更新只刷新项目导出。 */
import{test,expect}from'bun:test';
import{mkdtemp,mkdir,readFile,writeFile,rm}from'node:fs/promises';
import{join,dirname}from'node:path';
import{tmpdir}from'node:os';
import type{Pool,PoolClient}from'pg';
import{scanProjectPrompt,scanRuleWorkspace}from'./rule-files';
import{repositoryRoot}from'./paths';

async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'rule-currentness-')),skill=join(root,'skill');
 await mkdir(skill);await writeFile(join(skill,'SKILL.md'),'---\nname: test-skill\ndescription: currentness fixture\n---\n初始规则');
 const project={material_root:join(root,'questions'),local_skill_path:skill};
 return{root,skill,project,cleanup:()=>rm(root,{recursive:true,force:true})};
}

test('accepts a self-consistent frozen project prompt',async()=>{
 const f=await fixture();try{
  const snapshot=await scanProjectPrompt(dirname(f.project.material_root),f.skill);
  const {verifyFrozenProjectPrompt}=await import('./rule-files');
  expect(typeof verifyFrozenProjectPrompt).toBe('function');
  await verifyFrozenProjectPrompt(snapshot);
 }finally{await f.cleanup();}
});

test.each(['content','added_file','removed_file','path'])('keeps the frozen prompt valid after current skill changes (%s)',async change=>{
 const f=await fixture();try{
  const snapshot=await scanProjectPrompt(dirname(f.project.material_root),f.skill);
  if(change==='content')await writeFile(join(f.skill,'SKILL.md'),'---\nname: test-skill\ndescription: currentness fixture\n---\n更新规则');
  if(change==='added_file')await writeFile(join(f.skill,'extra.md'),'新增规则');
  if(change==='removed_file')await rm(join(f.skill,'SKILL.md'));
  if(change==='path'){const other=join(f.root,'other-skill');await mkdir(other);await writeFile(join(other,'SKILL.md'),'---\nname: test-skill\ndescription: currentness fixture\n---\n初始规则');}
  const {verifyFrozenProjectPrompt}=await import('./rule-files');
  await verifyFrozenProjectPrompt(snapshot);
 }finally{await f.cleanup();}
});

test('rejects a frozen project prompt whose stored digest is inconsistent',async()=>{
 const f=await fixture();try{
  const snapshot=await scanProjectPrompt(dirname(f.project.material_root),f.skill);
  snapshot.files[0]!.sha256='f'.repeat(64);
  const {verifyFrozenProjectPrompt}=await import('./rule-files');
  await expect(verifyFrozenProjectPrompt(snapshot)).rejects.toThrow('快照无效');
 }finally{await f.cleanup();}
});

test('marks project exports stale while preserving current archive and attempts',async()=>{
 const statements:string[]=[];
 const db={query:async(sql:string)=>{statements.push(sql);return{rowCount:1,rows:[]};}} as unknown as PoolClient;
 const {invalidateProjectRuleOutputs}=await import('./rules');
 expect(typeof invalidateProjectRuleOutputs).toBe('function');
 await invalidateProjectRuleOutputs(db,'project');
 expect(statements.some(sql=>sql.includes("UPDATE ai_distill.project_exports SET status='stale'")&&sql.includes("status IN ('running','succeeded')"))).toBe(true);
 expect(statements.some(sql=>sql.includes('UPDATE ai_distill.steps')&&sql.includes('ordinal=8'))).toBe(false);
 expect(statements.some(sql=>sql.includes('UPDATE ai_distill.workflows')&&sql.includes('ordinal=8'))).toBe(false);
 expect(statements.some(sql=>sql.startsWith('UPDATE ai_distill.step_attempts'))).toBe(false);
});

test('adopting a different skill preserves archives and refreshes project exports',async()=>{
 const parent=join(repositoryRoot,'.storage','test-fixtures');await mkdir(parent,{recursive:true});
 const root=await mkdtemp(join(parent,'rule-adoption-currentness-'));
 try{
  const projectRoot=join(root,'project'),materials=join(projectRoot,'materials'),oldSkill=join(projectRoot,'skill'),storage=join(root,'storage'),candidate=join(storage,'project-skills','project','attempt','candidate');
  await mkdir(materials,{recursive:true});await mkdir(oldSkill,{recursive:true});await mkdir(candidate,{recursive:true});
  await writeFile(join(materials,'rules.md'),'本期规则');
  const entry='---\nname: currentness-skill\ndescription: adoption fixture\n---\n';
  await writeFile(join(oldSkill,'SKILL.md'),entry+'旧规则');await writeFile(join(candidate,'SKILL.md'),entry+'新规则');
  const source=await scanRuleWorkspace(projectRoot,oldSkill),candidateView=await scanRuleWorkspace(projectRoot,candidate);
  const project={id:'project',material_root:join(projectRoot,'questions'),local_skill_path:oldSkill};
  const task={project_id:'project',input:{template_path:oldSkill,source_digest:source.source_digest},result:{candidate_path:candidate,publishable:true,issues:[],unresolved:[],candidate_files:candidateView.files.filter(file=>file.path.startsWith('skill/'))}};
  const statements:string[]=[];
  const query=async(sql:string)=>{statements.push(sql);if(sql.startsWith('SELECT * FROM ai_distill.projects'))return{rows:[project],rowCount:1};if(sql.startsWith('SELECT * FROM ai_distill.project_skill_attempts'))return{rows:[task],rowCount:1};return{rows:[],rowCount:1};};
  const pool={query,connect:async()=>({query,release(){}})};
  const {adoptProjectSkill}=await import('./rules');
  await adoptProjectSkill(pool as unknown as Pool,'project','attempt',storage);
  expect(project.local_skill_path).toBe(oldSkill);
  expect(await readFile(join(oldSkill,'SKILL.md'),'utf8')).toContain('新规则');
  expect(statements.some(sql=>sql.includes('UPDATE ai_distill.steps')&&sql.includes('ordinal=8'))).toBe(false);
  expect(statements.some(sql=>sql.includes('UPDATE ai_distill.workflows'))).toBe(false);
  expect(statements.some(sql=>sql.includes("UPDATE ai_distill.project_exports SET status='stale'"))).toBe(true);
  expect(statements.some(sql=>sql.startsWith('UPDATE ai_distill.step_attempts'))).toBe(false);
 }finally{await rm(root,{recursive:true,force:true});}
});
