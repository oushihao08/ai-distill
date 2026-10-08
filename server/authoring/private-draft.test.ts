import {test,expect} from 'bun:test';
import {mkdtemp,mkdir,writeFile,rm,symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {readPrivateDraft} from './private-draft';
const materials=[{id:'attachment',text:'金额100元'}];
const draft={question:'金额？',attachment_ids:['attachment'],rubric:[{id:'amount',criterion:'100元，否则零分',max_score:1}],reference_answer:'100元',answer_requirements:{input_mode:'text' as const,output_mode:'text' as const,tools:[]}};
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
