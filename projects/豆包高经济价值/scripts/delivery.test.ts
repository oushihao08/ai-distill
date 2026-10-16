/**
 * 职责：验证豆包归档入口只写交付缺口，并保留同目录已有 DOCX。
 * 主要验证：通过服务端 runProjectDelivery 调用仓库内 delivery.ts；不留下假的交付成果文件。
 */
import {test,expect} from 'bun:test';
import {mkdtemp,readFile,readdir,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {resolveProjectDelivery,runProjectDelivery,type DeliveryInput} from '../../../server/publishing/project-delivery.ts';

const input:DeliveryInput={
 version:1,
 project_id:'315407cd-43db-49d1-8eb3-c2dff77af859',
 workflow_id:'c0524100-9256-400a-8f23-366d021296ef',
 title:'题目7',
 source_digest:'a'.repeat(64),
 question_version:'saved',
 rubric_version:'saved',
 question:{task_name:'题目7已保存任务',task_type:'单轮',header:{},question:'题目7',attachment_ids:['05f43708-38e2-48d7-b38a-2173af059b38'],rubric:[{id:'1'}],answer_approach:'',reference_answer:'略'},
 acceptance:{decision:'accepted'},
 attachments:[{id:'05f43708-38e2-48d7-b38a-2173af059b38',sha256:'b'.repeat(64)}],
};

test('豆包交付只写缺口说明且保留已有 DOCX',async()=>{
 const root=await mkdtemp(join(tmpdir(),'doubao-delivery-'));
 try{
  await writeFile(join(root,'保留.docx'),'docx');
  await writeFile(join(root,'交付成果.json'),JSON.stringify({title:'题目7',task_name:'旧',project_id:input.project_id,workflow_id:input.workflow_id,attachment_ids:[]}));
  const delivery=await resolveProjectDelivery('豆包高经济价值');
  expect(delivery.mode).toBe('script');
  await runProjectDelivery(delivery,input,root);
  await runProjectDelivery(delivery,input,root);
  const names=await readdir(root);
  expect(names).toContain('保留.docx');
  expect(names).toContain('交付缺口.md');
  expect(names).not.toContain('交付成果.json');
  const text=await readFile(join(root,'交付缺口.md'),'utf8');
  expect(text).toContain('不是 Harbor 六件套');
  expect(text).not.toContain('略');
  expect(await readFile(join(root,'保留.docx'),'utf8')).toBe('docx');
 }finally{await rm(root,{recursive:true,force:true});}
});
