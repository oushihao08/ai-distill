/** 验证当前规则读取、文件指纹、并发编辑及冻结快照保护；不恢复已移除的编号规则草稿／发布链路。 */
import {test,expect,afterEach} from 'bun:test';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import type {Pool} from 'pg';
import {readProjectRules,editProjectRuleFile} from './rules';
import {freezeRuleWorkspace} from './rule-files';
const roots:string[]=[];
afterEach(async()=>{try{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});}catch(error){throw error;}});
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'current-rules-'));roots.push(root);await mkdir(join(root,'materials'));await mkdir(join(root,'skill'));
 await writeFile(join(root,'materials','标准.md'),'本期标准');await writeFile(join(root,'skill','SKILL.md'),'---\nname: test\ndescription: Test\n---\n本地技能');
 const project={id:'11111111-1111-4111-8111-111111111111',material_root:join(root,'questions'),local_skill_path:join(root,'skill')};
 const calls:string[]=[];
 const query=async(sql:string)=>{calls.push(sql);if(sql.startsWith('SELECT * FROM ai_distill.projects'))return{rows:[project],rowCount:1};if(['BEGIN','COMMIT','ROLLBACK'].includes(sql))return{rows:[],rowCount:0};throw new Error('读取当前规则不应访问版本表');};
 return{root,project,calls,pool:{query,connect:async()=>({query,release(){}})}as unknown as Pool};
}
test('相同当前文件清单读取得到相同摘要，不创建编号版本或运行记录',async()=>{
 const f=await fixture(),first=await readProjectRules(f.pool,f.project.id),again=await readProjectRules(f.pool,f.project.id);
 expect(first.workspace.source_digest).toBe(again.workspace.source_digest);expect(first.workspace.files.map(file=>file.path)).toContain('skill/SKILL.md');
 expect(first).not.toHaveProperty('versions');expect(f.calls.some(sql=>/INSERT|UPDATE|rule_versions|step_attempts/.test(sql))).toBe(false);
});
test('当前文件编辑改变新任务摘要，但不改写已经冻结的历史副本',async()=>{
 const f=await fixture(),view=await readProjectRules(f.pool,f.project.id),file=view.workspace.files.find(file=>file.path==='materials/标准.md')!;
 const frozen=await freezeRuleWorkspace(view.workspace,'test');roots.push(frozen);
 const updated=await editProjectRuleFile(f.pool,f.project.id,file.path,new TextEncoder().encode('新标准'),file.sha256);
 expect(updated.workspace.source_digest).not.toBe(view.workspace.source_digest);expect(await readFile(join(frozen,'materials','标准.md'),'utf8')).toBe('本期标准');
 expect(await readFile(join(f.root,'materials','标准.md'),'utf8')).toBe('新标准');expect(f.calls).toContain('COMMIT');
});
test('陈旧编辑指纹和越界路径被拒绝，不覆盖当前文件',async()=>{
 const f=await fixture(),view=await readProjectRules(f.pool,f.project.id),file=view.workspace.files.find(file=>file.path==='materials/标准.md')!;
 await editProjectRuleFile(f.pool,f.project.id,file.path,new TextEncoder().encode('已更新'),file.sha256);
 await expect(editProjectRuleFile(f.pool,f.project.id,file.path,new TextEncoder().encode('旧请求覆盖'),file.sha256)).rejects.toThrow();
 await expect(editProjectRuleFile(f.pool,f.project.id,'../outside.md',new TextEncoder().encode('越界'),null)).rejects.toThrow();
 expect(await readFile(join(f.root,'materials','标准.md'),'utf8')).toBe('已更新');expect(f.calls).toContain('ROLLBACK');
});
