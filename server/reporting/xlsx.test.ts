/** 验证 XLSX 写入、非法维度拒绝、文本安全、长单元格拆分和题目数据工作表。
 * 运行方式：由 Bun test 收集本文件用例；修改对应模块时针对该文件回归验证。
 */
import {test,expect} from 'bun:test';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {writeXlsx} from './xlsx';
import {buildResultWorkbook} from './results';
test('writes a real workbook with safe inline text, split long cells and unique sheet names',async()=>{
 const root=await mkdtemp(join(tmpdir(),'xlsx-test-'));const path=join(root,'result.xlsx');
 try{
  const long='长文本'.repeat(11_000);const bytes=await writeXlsx(path,[{name:'结果/题目',columns:['id','题面','答案','状态'],rows:[{id:'w1',题面:'=1+1',答案:long,状态:'未知'}]},{name:'结果/题目',columns:['id','状态'],rows:[{id:'w2',状态:'合格'}]}]);
  expect(bytes[0]).toBe(0x50);expect((await readFile(path)).length).toBeGreaterThan(100);
  const script="import json,openpyxl,sys; w=openpyxl.load_workbook(sys.argv[1],data_only=False); s=w.worksheets[0]; print(json.dumps({'sheets':w.sheetnames,'headers':[c.value for c in s[1]],'formula':s['B2'].data_type,'value':s['B2'].value,'state':s['E2'].value},ensure_ascii=False))";
  const result=spawnSync('python3',['-c',script,path],{encoding:'utf8'});expect(result.status).toBe(0);const read=JSON.parse(result.stdout);
  expect(read.sheets).toEqual(['结果 题目','结果 题目 (2)']);expect(read.headers).toEqual(['id','题面','答案','答案（续2）','状态']);expect(read.formula).toBe('s');expect(read.value).toBe('=1+1');expect(read.state).toBe('未知');
  const longRead=spawnSync('python3',['-c',"import openpyxl,sys; s=openpyxl.load_workbook(sys.argv[1],read_only=True).worksheets[0]; print(len(s['C2'].value+s['D2'].value))",path],{encoding:'utf8'});expect(longRead.status).toBe(0);expect(Number(longRead.stdout.trim())).toBe(long.length);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('rejects empty workbook and invalid dimensions',()=>{expect(()=>writeXlsx('',[] as any)).toThrow();});
test('keeps one question per main row and maps different attachment sets to local paths',async()=>{
 const root=await mkdtemp(join(tmpdir(),'result-xlsx-'));const path=join(root,'deliverable.xlsx');
 try{
  const record={workflow_id:'w1',title:'项目甲-题目1',task_name:'合同审查',question:'核对付款约定',input_attachments:['file:///data/题目1/合同-脱敏.docx','file:///data/题目1/判决书-脱敏.docx'],model_scores:[{model_id:'qwen-id',name:'Qwen 3.8',score:17,max_score:20,percentage:85},{model_id:'kimi-id',name:'Kimi',score:14,max_score:20,percentage:70}],rubric:[{id:'R1',criterion:'写明付款节点',max_score:10},{id:'R2',criterion:'核对付款凭证',max_score:10}],answer_approach:'按合同条款核对',reference_answer:'分三期支付',reference_answer_attachment:'',accepted:true};
  const bytes=buildResultWorkbook([record,{...record,workflow_id:'w2',title:'项目甲-题目2',input_attachments:['file:///data/题目2/合同-脱敏.docx']},{...record,workflow_id:'w3',title:'项目甲-题目3',input_attachments:[]}]);
  await Bun.write(path,bytes);
  const script="import json,openpyxl,sys; w=openpyxl.load_workbook(sys.argv[1]); s=w['题目数据']; a=w['附件清单']; print(json.dumps({'sheets':w.sheetnames,'headers':[c.value for c in s[1]],'count':s.max_row-1,'attachments':[s.cell(i,4).value for i in range(2,5)],'rubric':s['E2'].value,'scores':s['F2'].value,'reference_attachment':s['I2'].value,'manifest':list(a.values),'links':[a.cell(i,6).hyperlink.target for i in range(2,a.max_row+1)],'wrap':s['D2'].alignment.wrap_text,'path_width':a.column_dimensions['E'].width},ensure_ascii=False))";
  const out=spawnSync('python3',['-c',script,path],{encoding:'utf8'});
  expect(out.status).toBe(0);
  expect(JSON.parse(out.stdout)).toEqual({sheets:['题目数据','附件清单'],headers:['题目','任务名称','评分','prompt','输入附件','考点','作答思路','标准答案-文本','标准答案-附件'],count:3,attachments:['合同-脱敏.docx\n判决书-脱敏.docx','合同-脱敏.docx',''],rubric:'R1｜写明付款节点（10分）\nR2｜核对付款凭证（10分）',scores:'Qwen 3.8：17/20 分（85%）\nKimi：14/20 分（70%）',reference_attachment:'',manifest:[['题目','工作流ID','附件序号','文件名','本机完整路径','打开文件'],['项目甲-题目1','w1',1,'合同-脱敏.docx','/data/题目1/合同-脱敏.docx','合同-脱敏.docx'],['项目甲-题目1','w1',2,'判决书-脱敏.docx','/data/题目1/判决书-脱敏.docx','判决书-脱敏.docx'],['项目甲-题目2','w2',1,'合同-脱敏.docx','/data/题目2/合同-脱敏.docx','合同-脱敏.docx']],links:record.input_attachments.concat('file:///data/题目2/合同-脱敏.docx'),wrap:true,path_width:100});
 }finally{await rm(root,{recursive:true,force:true});}
});
