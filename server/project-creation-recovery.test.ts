/** 验证只读回执恢复的路径规范化、配置冲突及显式模型绑定；使用临时目录与SQL替身。 */
import {test,expect} from 'bun:test';
import {mkdtemp,rm,mkdir,symlink,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {recoverCreatedProject} from './project-creation-recovery';
test('回执查询规范化路径并拒绝配置冲突，没有任何写SQL',async()=>{
 const root=await mkdtemp(join(tmpdir(),'phase-receipt-'));
 try{
  const path=join(root,'workspace');await mkdir(path);await symlink(path,join(root,'alias'));
  const canonical=await realpath(path),input={name:'甲 - 第一期',parent_name:'甲',phase_name:'第一期',phase_no:1,workspace_path:join(root,'alias')+'/',local_skill_path:join(root,'alias'),authoring_defaults:{model:'gpt-6.1-sol',reasoning_effort:'low'}};
  let candidate:any={id:'receipt',name:input.name,parent_name:'甲',phase_name:'第一期',phase_no:1,description:'',material_backend:'library_v1',material_mode:'material_packages',workspace_path:canonical,material_root:null,local_skill_path:canonical,question_tags:[]};
  let model='gpt-6.1-sol';const queries:string[]=[];
  const db={query:async(sql:string)=>{queries.push(sql);return{rows:sql.includes('project_step_configs')?[{config:{model,reasoning_effort:'low'}}]:candidate?[candidate]:[]};}} as any;
  expect((await recoverCreatedProject(db,input)).project?.id).toBe('receipt');
  model='other';await expect(recoverCreatedProject(db,input)).rejects.toThrow('出题设置');model='gpt-6.1-sol';
  candidate={...candidate,description:'其他任务'};await expect(recoverCreatedProject(db,input)).rejects.toThrow('不一致');
  candidate=null;expect((await recoverCreatedProject(db,input)).project).toBeNull();
  expect(queries.every(sql=>sql.startsWith('SELECT'))).toBe(true);
 }finally{await rm(root,{recursive:true,force:true});}
});
