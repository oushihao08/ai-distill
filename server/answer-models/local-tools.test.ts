/** 验证本地作答工具只读冻结附件、只写attempt受管产物目录，并覆盖六项工具契约。 */
import {expect,test} from 'bun:test';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ANSWER_LOCAL_TOOLS} from '../../shared/types';
import {answerLocalToolDefinitions,createAnswerLocalToolExecutor} from './local-tools';

test('six local tools expose stable function schemas',()=>{
 const tools=answerLocalToolDefinitions([...ANSWER_LOCAL_TOOLS]);expect(tools.map(tool=>tool.name)).toEqual([...ANSWER_LOCAL_TOOLS]);expect(tools.every(tool=>tool.strict&&tool.parameters.type==='object')).toBe(true);
});
test('attachment list, search, read and inspect only use frozen materials',async()=>{
 const root=await mkdtemp(join(tmpdir(),'answer-tools-'));try{
  const run=createAnswerLocalToolExecutor({directory:root,enabled:[...ANSWER_LOCAL_TOOLS],materials:[{name:'合同.md',text:'# 合同\n第 1 页\n甲方应付 100 元\n| 项目 | 金额 |'}]});
  expect(JSON.parse(await run('attachment_list',{})).attachments[0]).toMatchObject({id:'attachment-1',name:'合同.md'});
  expect(JSON.parse(await run('attachment_search',{query:'100'})).hits[0]).toMatchObject({attachment_id:'attachment-1',line:3});
  expect(JSON.parse(await run('attachment_read',{attachment_id:'attachment-1',start_line:2,end_line:3})).text).toContain('100');
  expect(JSON.parse(await run('document_inspect',{attachment_id:'attachment-1'}))).toMatchObject({inspection_basis:'extracted_text',table_lines:1,page_markers:1});
  await expect(run('attachment_read',{attachment_id:'../../etc/passwd'})).rejects.toThrow('attachment_not_found');
 }finally{await rm(root,{recursive:true,force:true});}
});
test('artifact write and render stay inside the managed directory',async()=>{
 const root=await mkdtemp(join(tmpdir(),'answer-artifacts-'));try{
  const run=createAnswerLocalToolExecutor({directory:root,enabled:['artifact_write','artifact_render'],materials:[]});
  expect(JSON.parse(await run('artifact_write',{filename:'意见.md',content:'# 意见\n已核对'}))).toMatchObject({filename:'意见.md',written:true});
  expect(await readFile(join(root,'artifacts','意见.md'),'utf8')).toContain('已核对');expect(JSON.parse(await run('artifact_render',{filename:'意见.md'})).preview).toContain('已核对');
  await expect(run('artifact_write',{filename:'../escape.md',content:'x'})).rejects.toThrow('invalid_filename');await expect(run('artifact_write',{filename:'x.exe',content:'x'})).rejects.toThrow('unsupported_artifact_format');
 }finally{await rm(root,{recursive:true,force:true});}
});
