/** 验证返修草稿从当前或旧格式工作区安全恢复，并拒绝缺失答案与越界链接。
 * 运行方式：由 Bun test 收集本文件用例；修改对应模块时针对该文件回归验证。
 */
import {test,expect} from 'bun:test';
import {mkdtemp,mkdir,writeFile,rm,symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {readPrivateDraft} from './private-draft';
const materials=[{id:'attachment',text:'金额100元'}];
const draft={task_name:'金额核算',task_type:'合同计算',header:{industry_l1:'待确认',industry_l2:'待确认',task_form:'single_round' as const,occupation_l1:'待确认',occupation_l2:'待确认'},question:'金额？',attachment_ids:['attachment'],rubric:[{id:'amount',criterion:'100元，否则零分',max_score:1}],answer_approach:'核对合同金额',reference_answer:'100元',answer_requirements:{input_mode:'text' as const,output_mode:'text' as const,tools:[]}};
test('private draft can be recovered from the current file or one legacy review input',async()=>{
 for(const legacy of [false,true]){
  const root=await mkdtemp(join(tmpdir(),'private-draft-'));const directory=join(root,'workflow','attempt','private');
  try{
   const path=legacy?join(directory,'authoring-old','review','input','input.json'):join(directory,'draft.json');
   await mkdir(join(path,'..'),{recursive:true});await writeFile(path,JSON.stringify(legacy?{draft}:draft));
   expect(await readPrivateDraft(root,'workflow','attempt',materials)).toEqual(draft);
  }finally{await rm(root,{recursive:true,force:true});}
 }
});
test('missing legacy reference answer and symlink outside the private workspace cannot be recovered',async()=>{
 const root=await mkdtemp(join(tmpdir(),'private-draft-')),directory=join(root,'workflow','attempt','private');
 try{
  await mkdir(directory,{recursive:true});await writeFile(join(root,'outside.json'),JSON.stringify(draft));
  await symlink(join(root,'outside.json'),join(directory,'draft.json'));
  await expect(readPrivateDraft(root,'workflow','attempt',materials)).rejects.toThrow('unsafe');
  await rm(join(directory,'draft.json'));const input=join(directory,'authoring-old','review','input');await mkdir(input,{recursive:true});
  await writeFile(join(input,'input.json'),JSON.stringify({draft:{...draft,reference_answer:undefined}}));
  await expect(readPrivateDraft(root,'workflow','attempt',materials)).rejects.toThrow();
 }finally{await rm(root,{recursive:true,force:true});}
});
