/** 验证规则清单/引用/路径、冻结快照摘要、指纹冲突和安全日志；所有工作区及日志均位于临时目录，不访问项目真实 Skill 或数据库。 */
import {test,expect,afterEach} from 'bun:test';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {scanRuleWorkspace,freezeRuleWorkspace,verifyRuleSnapshot,changeRuleFile,readRuleFile,resolveRuleWorkspacePaths,resolveEffectiveProjectSkill} from './rule-files';
import {configureLogger} from './logging';
const roots:string[]=[];
afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'rule-files-'));roots.push(root);
 await mkdir(join(root,'materials'));await mkdir(join(root,'skill','references'),{recursive:true});
 await writeFile(join(root,'materials','标准.md'),'当前标准');
 await writeFile(join(root,'skill','SKILL.md'),'---\nname: test-skill\ndescription: Test skill\n---\n[参考](references/rule.md)');
 await writeFile(join(root,'skill','references','rule.md'),'参考方法');
 await writeFile(join(root,'project.json'),JSON.stringify({assessment:{rubric:'binary_equal_weight'},unresolved:[{id:'external-eligibility',detail:'资格待核'}]}));
 return{root,skill:join(root,'skill')};
}
test('library-backed projects use their explicit workspace instead of deriving it from a material directory',async()=>{
 const {root,skill}=await fixture();
 expect(await resolveRuleWorkspacePaths({workspace_path:root,local_skill_path:skill})).toMatchObject({workspace_path:root,materials_path:join(root,'materials')});
});
test('期次 Skill 优先；没有入口时使用主项目 Skill',async()=>{
 const {root,skill}=await fixture(),phase=join(root,'期次一');await mkdir(phase);
 const project={workspace_path:phase,local_skill_path:skill,parent_name:'Work法律全场景'};
 expect(await resolveEffectiveProjectSkill(project)).toEqual({path:skill,source:'project',project_path:skill,phase_path:join(phase,'skill')});
 await mkdir(join(phase,'skill'));await writeFile(join(phase,'skill','SKILL.md'),'---\nname: phase\ndescription: Phase skill\n---\n本期规则');
 expect(await resolveEffectiveProjectSkill(project)).toEqual({path:join(phase,'skill'),source:'phase',project_path:skill,phase_path:join(phase,'skill')});
});
test('期次未单独保存 workspace_path 时从 material_root 推导本期 Skill 目录',async()=>{
 const {root,skill}=await fixture(),phase=join(root,'首批筹备');await mkdir(join(phase,'questions'),{recursive:true});
 const project={material_root:join(phase,'questions'),local_skill_path:skill,parent_name:'Work法律全场景'};
 expect(await resolveEffectiveProjectSkill(project)).toEqual({path:skill,source:'project',project_path:skill,phase_path:join(phase,'skill')});
 await mkdir(join(phase,'skill'));await writeFile(join(phase,'skill','SKILL.md'),'---\nname: phase\ndescription: Phase skill\n---\n本期规则');
 expect(await resolveEffectiveProjectSkill(project)).toEqual({path:join(phase,'skill'),source:'phase',project_path:skill,phase_path:join(phase,'skill')});
});
test('rule inventory covers the whole skill package and keeps metadata separate from bodies',async()=>{
 const {root,skill}=await fixture();const result=await scanRuleWorkspace(root,skill);
 expect(result.files.map(f=>f.path)).toEqual(['materials/标准.md','project.json','skill/SKILL.md','skill/references/rule.md']);
 expect(result.files.every(f=>f.sha256.length===64&&f.size_bytes>0)).toBe(true);
 expect(result.issues).toEqual([]);expect(result.unresolved[0]?.id).toBe('external-eligibility');
 expect(JSON.stringify(result)).not.toContain('参考方法');
});
test('missing or escaping skill references prevent publication',async()=>{
 const {root,skill}=await fixture();await writeFile(join(skill,'references','rule.md'),'[缺失](missing.md) [逃逸](../../outside.md)');
 const view=await scanRuleWorkspace(root,skill);expect(view.issues.length).toBe(2);
 await expect(freezeRuleWorkspace(view,'v1')).rejects.toThrow('引用');
});
test('symlinked rule inputs are never followed outside the workspace',async()=>{
 const {root,skill}=await fixture();await symlink(join(root,'project.json'),join(root,'materials','linked.json'));
 await expect(scanRuleWorkspace(root,skill)).rejects.toThrow('符号链接');
});
test('published snapshot preserves old bytes when the working materials change',async()=>{
 const {root,skill}=await fixture();const before=await scanRuleWorkspace(root,skill);const snapshot=await freezeRuleWorkspace(before,'v1');
 await writeFile(join(root,'materials','标准.md'),'已更新的标准');
 expect(await readFile(join(snapshot,'materials','标准.md'),'utf8')).toBe('当前标准');
 await verifyRuleSnapshot(snapshot,before.files);
 expect((await scanRuleWorkspace(root,skill)).source_digest).not.toBe(before.source_digest);
});
test('snapshot verification rejects modified bytes and extra files',async()=>{
 const {root,skill}=await fixture();const before=await scanRuleWorkspace(root,skill);const snapshot=await freezeRuleWorkspace(before,'v1');
 await writeFile(join(snapshot,'extra.md'),'不得混入');await expect(verifyRuleSnapshot(snapshot,before.files)).rejects.toThrow('快照');
 await rm(join(snapshot,'extra.md'));await writeFile(join(snapshot,'materials','标准.md'),'被改写');
 await expect(verifyRuleSnapshot(snapshot,before.files)).rejects.toThrow('快照');
});
test('snapshot fingerprints remain valid after PostgreSQL JSON object key reordering',async()=>{
 const {root,skill}=await fixture();const before=await scanRuleWorkspace(root,skill);const snapshot=await freezeRuleWorkspace(before,'v1');
 const reordered=before.files.map(file=>({size_bytes:file.size_bytes,sha256:file.sha256,path:file.path}));
 await verifyRuleSnapshot(snapshot,reordered);
});
test('file replacement requires the visible fingerprint and cannot overwrite a newer edit',async()=>{
 const {root,skill}=await fixture();const before=await scanRuleWorkspace(root,skill);const file=before.files.find(f=>f.path==='materials/标准.md')!;
 await changeRuleFile(root,file.path,new TextEncoder().encode('第一次修改'),file.sha256);
 await expect(changeRuleFile(root,file.path,new TextEncoder().encode('旧页面修改'),file.sha256)).rejects.toThrow('已变化');
 expect(await readFile(join(root,file.path),'utf8')).toBe('第一次修改');
});
test('rule file read failures emit a safe file boundary event',async()=>{
 const {root}=await fixture(),logger=configureLogger({root,service:'api'});
 try{
  await expect(readRuleFile(root,'materials/missing.md')).rejects.toThrow('不存在');await logger.flush();
  const directory=join(root,'logs',new Date().toISOString().slice(0,10)),files=await readdir(directory);
  const records=(await readFile(join(directory,files[0]!), 'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  expect(records.map(record=>record.event)).toContain('file.read.failed');
  expect(records.find(record=>record.event==='file.read.failed')).toMatchObject({component:'rules',file_kind:'project_rule_file'});
 }finally{await logger.close();}
});
test('material add/delete is explicit and cannot edit the skill or traverse directories',async()=>{
 const {root,skill}=await fixture();await changeRuleFile(root,'materials/新增.md',new TextEncoder().encode('新增资料'),null);
 const file=(await scanRuleWorkspace(root,skill)).files.find(f=>f.path==='materials/新增.md')!;
 await changeRuleFile(root,file.path,null,file.sha256);
 expect((await scanRuleWorkspace(root,skill)).files.some(f=>f.path===file.path)).toBe(false);
 for(const path of ['skill/SKILL.md','materials/../project.json','materials/.env','/tmp/outside.md'])await expect(changeRuleFile(root,path,new Uint8Array([1]),null)).rejects.toThrow('路径');
});
